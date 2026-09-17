// Talking to the browser properly, instead of shouting flags at it.
//
// `chromium --screenshot=out.png <url>` is enough to get a picture, and headless.ts keeps
// that path for rendering a local file. It cannot do the thing that actually matters for
// reading a design: run code inside the page once it has rendered. A modern site's real
// values — the resolved colour of a button, the computed gap of a grid, the box a heading
// actually occupies — exist only after the cascade, the media queries, the utility classes
// and the framework have all had their say. `getComputedStyle` knows them. A stylesheet
// parser is guessing.
//
// So: start the browser with a debugging port, attach over a WebSocket, and use the three
// commands that matter — navigate, evaluate, capture. No dependency; the protocol is JSON
// over a socket and we need a dozen of its several hundred methods.
//
// The awkward parts, and what they cost:
//
//   Finding the port. `--remote-debugging-port=0` lets the OS choose, which is the only way
//   two captures can run at once without a port fight. Chromium then writes the real port
//   into DevToolsActivePort in its profile directory, so the file is polled rather than the
//   stderr banner parsed — the banner has moved between versions, the file has not.
//
//   Knowing when a page is "loaded". It never truly is: a site with a polling widget has a
//   request in flight forever. Waiting for the load event and then for a short quiet period
//   in the network, with a hard ceiling over both, is the pragmatic answer, and it is the
//   same one every screenshot tool arrives at.
//
//   Size. A full-page capture of a long marketing site is tens of megabytes of base64 over
//   the socket. The capture is clipped to a sane height instead.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "./headless";

const PORT_FILE_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;
/** Evaluating in the page competes with the page's own JavaScript for the main thread, so
 *  it gets its own, longer ceiling than a protocol round trip. */
const EVALUATE_TIMEOUT_MS = 60_000;
/** Longest we wait for a page, load event and network quiet together. */
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
/** How long the network must be quiet before a page counts as settled. */
const QUIET_MS = 700;
/** Past this the page is not going to settle — an analytics beacon, a poll, a live feed —
 *  and waiting for the full deadline every time makes every capture of every real site
 *  take as long as the worst one. */
const SETTLE_CEILING_MS = 12_000;
/** Anything past this is a lazy-loading feed, not a design. */
const MAX_CAPTURE_HEIGHT = 4_000;

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface CaptureOptions {
	width: number;
	height: number;
	/** 1 for a normal shot, 0.5 for a half-size card image. */
	scale?: number;
	loadTimeoutMs?: number;
	/** Extra wait after the network goes quiet — for entrance animations to finish. */
	afterSettleMs?: number;
}

/**
 * A live page. Thin on purpose: navigate, ask it something, take its picture.
 */
export class Page {
	private readonly socket: WebSocket;
	private readonly sessionId: string;
	private readonly pending = new Map<number, Pending>();
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	private nextId = 1;
	/** Requests in flight, so "the network went quiet" is a fact rather than a guess. */
	private inFlight = 0;
	private lastActivity = Date.now();
	private loaded = false;

	constructor(socket: WebSocket, sessionId: string) {
		this.socket = socket;
		this.sessionId = sessionId;
		socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
	}

	private onMessage(data: string): void {
		let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		if (msg.id !== undefined) {
			const waiter = this.pending.get(msg.id);
			if (!waiter) return;
			this.pending.delete(msg.id);
			clearTimeout(waiter.timer);
			if (msg.error) waiter.reject(new Error(msg.error.message ?? "protocol error"));
			else waiter.resolve(msg.result ?? {});
			return;
		}
		if (msg.method) for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params ?? {});
		switch (msg.method) {
			case "Page.loadEventFired":
				this.loaded = true;
				break;
			case "Network.requestWillBeSent":
				this.inFlight++;
				this.lastActivity = Date.now();
				break;
			case "Network.loadingFinished":
			case "Network.loadingFailed":
				this.inFlight = Math.max(0, this.inFlight - 1);
				this.lastActivity = Date.now();
				break;
		}
	}

	/**
	 * Put the page on a clock of its own, and hand it time in slices.
	 *
	 * A capture runs in a headless browser rendering in software, which cannot keep sixty frames a
	 * second on a page of any weight. Everything recorded off it is then sampled at whatever rate
	 * that machine managed — twenty a second, unevenly — and a rebuild made from those samples
	 * moves the way the capture struggled rather than the way the page runs.
	 *
	 * Virtual time fixes it at the source: the browser advances the page's clock only when the page
	 * has finished with the moment it is on, so an animation gets every frame it asked for, timers
	 * fire when the page thinks they should, and the recording comes back dense and evenly spaced.
	 * It is also faster than real time on a light page, because nothing waits for a display.
	 */
	async startVirtualTime(): Promise<boolean> {
		try {
			await this.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
			return true;
		} catch {
			return false;
		}
	}

	/** Let the page live for `ms` of its own time, and come back when it has spent them. */
	async grantVirtualTime(ms: number): Promise<void> {
		const budget = Math.max(1, Math.round(ms));
		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				off();
				clearTimeout(timer);
				resolve();
			};
			const off = this.on("Emulation.virtualTimeBudgetExpired", finish);
			// A page that never goes idle would otherwise hold the visit open for ever; real time is
			// the backstop, generously, since virtual time is usually the faster of the two.
			const timer = setTimeout(finish, Math.max(10_000, budget * 4));
			this.send("Emulation.setVirtualTimePolicy", {
				policy: "pauseIfNetworkFetchesPending",
				budget,
				// Without this, a page whose timers keep queueing more timers never lets the clock move.
				maxVirtualTimeTaskStarvationCount: 100_000,
			}).catch(finish);
		});
	}

	/** Give the page back to the wall clock. */
	async stopVirtualTime(): Promise<void> {
		await this.send("Emulation.setVirtualTimePolicy", { policy: "advance" }).catch(() => ({}));
	}

	/** Call `listener` with each event of this protocol method; the returned function stops it. */
	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		const set = this.listeners.get(method) ?? new Set();
		set.add(listener);
		this.listeners.set(method, set);
		return () => set.delete(listener);
	}

	send(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
		});
	}

	/**
	 * Install a script that runs before any of the page's own, on every document. The only
	 * hook that beats a bundle to `getContext` — a wrapper installed after load sees
	 * nothing, because the shaders were compiled during load and never again.
	 */
	async addInitScript(source: string): Promise<void> {
		await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
	}

	/** Go there and wait until it has stopped doing things, or until we give up waiting. */
	async goto(url: string, opts: CaptureOptions): Promise<void> {
		await this.send("Emulation.setDeviceMetricsOverride", {
			width: opts.width,
			height: opts.height,
			deviceScaleFactor: opts.scale ?? 1,
			mobile: false,
		});
		this.loaded = false;
		this.inFlight = 0;
		this.lastActivity = Date.now();
		await this.send("Page.navigate", { url });

		const deadline = Date.now() + (opts.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
		const loadedAt = { at: 0 };
		while (Date.now() < deadline) {
			await Bun.sleep(100);
			if (!this.loaded) continue;
			if (loadedAt.at === 0) loadedAt.at = Date.now();
			if (this.inFlight === 0 && Date.now() - this.lastActivity > QUIET_MS) break;
			// Loaded, but something keeps talking. Real sites poll, beacon and stream; give
			// up on quiet rather than on the page.
			if (Date.now() - loadedAt.at > SETTLE_CEILING_MS) break;
		}
		if (opts.afterSettleMs) await Bun.sleep(opts.afterSettleMs);
	}

	/**
	 * Run an expression in the page and bring the value back. The expression is ours, but
	 * the page it runs in is not: anything it returns is data from a site nobody here
	 * controls, and every caller treats it that way.
	 */
	async evaluate<T>(expression: string, timeoutMs = EVALUATE_TIMEOUT_MS): Promise<T | null> {
		try {
			const result = (await this.send(
				"Runtime.evaluate",
				{
					expression,
					returnByValue: true,
					awaitPromise: true,
					// A page that has frozen its own globals should not be able to break us.
					throwOnSideEffect: false,
				},
				timeoutMs,
			)) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
			if (result.exceptionDetails) return null;
			return result.result?.value ?? null;
		} catch {
			// A page whose main thread never yields. The caller still has a screenshot to
			// take, and losing that as well would turn a thin capture into no capture.
			return null;
		}
	}

	/**
	 * Scroll past the page once so anything lazy-loaded is actually there, then come back.
	 * Bounded hard: this runs on the page's own main thread, and an infinite-scroll feed
	 * will happily keep producing content for as long as anything keeps asking.
	 */
	async revealLazyContent(): Promise<void> {
		await this.evaluate(
			`(async () => {
				const step = Math.max(400, window.innerHeight);
				const end = Math.min(document.body ? document.body.scrollHeight : 0, ${MAX_CAPTURE_HEIGHT});
				for (let y = step, steps = 0; y < end && steps < 8; y += step, steps++) {
					window.scrollTo(0, y);
					await new Promise((r) => setTimeout(r, 50));
				}
				window.scrollTo(0, 0);
				await new Promise((r) => setTimeout(r, 150));
				return true;
			})()`,
			15_000,
		);
	}

	async screenshot(opts: {
		fullPage?: boolean;
		width: number;
		height: number;
		/** One rectangle in page coordinates, for photographing a canvas or a video. */
		clip?: { x: number; y: number; width: number; height: number };
		/** jpeg for a frame of an animation: twenty PNGs of a hero is megabytes. */
		format?: "png" | "jpeg";
		quality?: number;
		/** Applied to a clip, so a frame sequence can be captured at half size. */
		scale?: number;
	}): Promise<Uint8Array | null> {
		const params: Record<string, unknown> = {
			format: opts.format ?? "png",
			captureBeyondViewport: Boolean(opts.fullPage || opts.clip),
		};
		if (opts.format === "jpeg") params.quality = opts.quality ?? 72;
		if (opts.clip) {
			params.clip = {
				x: opts.clip.x,
				y: opts.clip.y,
				width: opts.clip.width,
				height: opts.clip.height,
				scale: opts.scale ?? 1,
			};
		} else if (opts.fullPage) {
			const height = await this.evaluate<number>(
				"Math.min(document.documentElement.scrollHeight, " + MAX_CAPTURE_HEIGHT + ")",
			);
			params.clip = { x: 0, y: 0, width: opts.width, height: height ?? opts.height, scale: 1 };
		}
		const result = (await this.send("Page.captureScreenshot", params, EVALUATE_TIMEOUT_MS)) as { data?: string };
		if (!result.data) return null;
		return new Uint8Array(Buffer.from(result.data, "base64"));
	}
}

export type BrowserRun<T> = { ok: true; value: T } | { ok: false; reject: string };

/**
 * Start a browser, open one page, hand it to `body`, and take everything down afterwards
 * whatever happens. The profile directory is fresh and goes with it: a headless run must
 * never touch the browser the user has open, and it must leave nothing behind.
 */
export async function withPage<T>(
	body: (page: Page) => Promise<T>,
	opts: { offline?: boolean; pin?: { host: string; address: string } | null } = {},
): Promise<BrowserRun<T>> {
	const binary = findBrowser();
	if (!binary) return { ok: false, reject: "no Chromium-based browser was found on this machine" };

	const profile = mkdtempSync(join(tmpdir(), "claude-brain-cdp-"));
	let proc: ReturnType<typeof Bun.spawn> | null = null;
	let socket: WebSocket | null = null;
	try {
		const args = [
			"--headless",
			// Not --disable-gpu. A page whose hero is a WebGL canvas renders that canvas as
			// nothing without a rasteriser, and the capture then photographs a black box where
			// the design is — which is exactly what happened to raycast.com: a black reference
			// shot, a rebuild with no background, and a similarity score measured between two
			// wrong pictures. SwiftShader draws it in software. Both flags are needed: the
			// unsafe-swiftshader one permits the fallback at all, and ANGLE still has to be
			// pointed at it (verified on Chromium 153 — with only the first, the hero stays
			// black and the PNG comes back byte-identical to the GPU-less one).
			"--enable-unsafe-swiftshader",
			"--use-angle=swiftshader",
			"--disable-gpu-sandbox",
			"--hide-scrollbars",
			"--disable-dev-shm-usage",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-pings",
			"--mute-audio",
			"--disable-extensions",
			"--disable-sync",
			"--disable-default-apps",
			"--disable-background-networking",
			// A headless window is never the foreground window, so Chromium treats it as
			// occluded and drops requestAnimationFrame to about one frame a second. Measured on
			// raycast.com: 15 frames in 18 seconds, which reads as "the animation is slow" when
			// what is actually happening is that nobody is drawing it. An entrance that takes
			// three seconds is then four usable samples, and a capture of a moving scene is a
			// slideshow. These three are what let the page animate at its own rate.
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			// A capture is one tab of one page. Chromium's default is a process per site plus
			// spares, which on this machine came to sixteen processes and 1.6 GB while a rip
			// was running.
			"--renderer-process-limit=1",
			"--disable-features=site-per-process,IsolateOrigins",
			"--disable-breakpad",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
		];
		if (opts.offline) args.push("--host-resolver-rules=MAP * ~NOTFOUND");
		else if (opts.pin) args.push(`--host-resolver-rules=MAP ${opts.pin.host} ${opts.pin.address}`);

		proc = Bun.spawn([binary, ...args], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			env: { PATH: process.env.PATH ?? "/usr/bin", HOME: process.env.HOME ?? tmpdir(), DISPLAY: "" },
		});

		const endpoint = await waitForEndpoint(profile);
		if (!endpoint) return { ok: false, reject: "the browser did not open a debugging port" };

		socket = await openSocket(endpoint);
		if (!socket) return { ok: false, reject: "the browser's debugging port would not accept a connection" };

		const page = await attachPage(socket);
		if (!page) return { ok: false, reject: "no page could be opened in the browser" };
		return { ok: true, value: await body(page) };
	} catch (err) {
		return { ok: false, reject: String(err instanceof Error ? err.message : err).slice(0, 200) };
	} finally {
		try {
			socket?.close();
		} catch {
			/* already gone */
		}
		proc?.kill("SIGTERM");
		setTimeout(() => proc?.kill("SIGKILL"), 2_000).unref?.();
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			/* the browser is still letting go of it; tmp gets cleared anyway */
		}
	}
}

/** Chromium writes the chosen port and socket path here once it is listening. */
async function waitForEndpoint(profile: string): Promise<string | null> {
	const path = join(profile, "DevToolsActivePort");
	const deadline = Date.now() + PORT_FILE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const [port, wsPath] = readFileSync(path, "utf-8").split("\n");
			if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
		} catch {
			/* not written yet */
		}
		await Bun.sleep(80);
	}
	return null;
}

function openSocket(url: string): Promise<WebSocket | null> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => resolve(null), 10_000);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}

/**
 * One blank tab, attached flat so its events arrive on the same socket as the browser's.
 * Network and Page domains are enabled here rather than in goto(), so the very first
 * navigation's requests are counted too — without that, "the network is quiet" is true a
 * millisecond after navigate() and every capture photographs a blank page.
 */
async function attachPage(socket: WebSocket): Promise<Page | null> {
	const send = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const id = 1_000_000 + Math.floor(Math.random() * 1_000_000);
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS);
			const onMessage = (event: MessageEvent): void => {
				let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
				try {
					msg = JSON.parse(String(event.data));
				} catch {
					return;
				}
				if (msg.id !== id) return;
				clearTimeout(timer);
				socket.removeEventListener("message", onMessage);
				if (msg.error) reject(new Error(msg.error.message ?? "protocol error"));
				else resolve(msg.result ?? {});
			};
			socket.addEventListener("message", onMessage);
			socket.send(JSON.stringify({ id, method, params }));
		});

	const created = (await send("Target.createTarget", { url: "about:blank" })) as { targetId?: string };
	if (!created.targetId) return null;
	const attached = (await send("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as {
		sessionId?: string;
	};
	if (!attached.sessionId) return null;

	const page = new Page(socket, attached.sessionId);
	await page.send("Page.enable");
	await page.send("Network.enable");
	await page.send("Runtime.enable");
	return page;
}
