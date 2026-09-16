// Pixels. The one thing a fetch cannot give us.
//
// Everything else in the design capture reads text: markup, stylesheets, bundles. None of
// it can answer "what does this actually look like", because a modern page is a program
// and the layout is its output. A browser already on the machine can answer that, so this
// module is a thin, careful wrapper around one: render a page, write a PNG, or run a page
// and read one string back out of it.
//
// No CDP, no WebSocket, no dependency. Chromium's own command line does both jobs —
// `--screenshot` for pixels and `--dump-dom` for a value — and a serialized DOM is a
// perfectly good return channel when the page writes its answer into a single element.
//
// Three things here are deliberate:
//
//   A fresh profile per run. Pointing headless Chromium at the user's real profile either
//   refuses to start ("profile appears to be in use") or writes into the browser they have
//   open. Every run gets its own directory and takes it with it when it goes.
//
//   Network is all-or-nothing. `--host-resolver-rules=MAP * ~NOTFOUND` blocks the lot;
//   there is no working allowlist — EXCLUDE is documented but does not override a MAP of
//   `*`, verified against Chromium 153, so a page rendered offline gets no web fonts and
//   the caller is told to expect fallbacks rather than being quietly lied to.
//
//   The main host is pinned. url-guard vets every address a name resolves to and then
//   `fetch` resolves it again — the rebinding gap its own header admits to. A browser run
//   can close that gap for the page itself, because `MAP host address` pins the connection
//   while leaving the Host header and the TLS server name alone.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageMeta } from "./image-meta";

/** Binaries that are Chromium under some name, most likely first. */
const CANDIDATES = [
	"chromium",
	"chromium-browser",
	"google-chrome-stable",
	"google-chrome",
	"brave-browser",
	"microsoft-edge-stable",
	"thorium-browser",
];

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
/** How long the page is given to settle, in the browser's own virtual clock. */
const DEFAULT_SETTLE_MS = 12_000;
/** Wall-clock kill. Virtual time stalls on a request that never answers. */
const DEFAULT_TIMEOUT_MS = 45_000;
/** A dump-dom page answers with kilobytes of JSON at most; past this something is wrong. */
const MAX_DOM_BYTES = 4 * 1024 * 1024;

let cached: { binary: string | null } | null = null;

/**
 * The browser, or null. Cached for the process: this walks PATH and the answer does not
 * change while we run, and every design capture would otherwise pay for the walk.
 *
 * `CLAUDE_BRAIN_BROWSER` wins, for a binary somewhere PATH cannot see — which is the
 * daemon's normal condition, since systemd's PATH is not a login shell's.
 */
export function findBrowser(): string | null {
	if (cached) return cached.binary;
	const configured = process.env.CLAUDE_BRAIN_BROWSER;
	if (configured) {
		cached = { binary: Bun.which(configured) ?? (Bun.file(configured).size >= 0 ? configured : null) };
		return cached.binary;
	}
	for (const name of CANDIDATES) {
		const found = Bun.which(name);
		if (found) {
			cached = { binary: found };
			return found;
		}
	}
	cached = { binary: null };
	return null;
}

/** For a status line: why nothing can be rendered, in the user's words. */
export const NO_BROWSER =
	"no Chromium-based browser was found on this machine, so pages cannot be rendered — " +
	"install chromium, or point CLAUDE_BRAIN_BROWSER at one";

export type Rendered = { ok: true; path: string; width: number; height: number } | { ok: false; reject: string };

export interface ShotOptions {
	/** http(s) for a live page, or a file:// URL this package wrote itself. */
	url: string;
	/** Absolute path for the PNG. Overwritten. */
	out: string;
	width?: number;
	height?: number;
	/** Device scale. 0.5 gives a half-size image of the same layout — a card thumbnail
	 *  that cost one extra launch rather than an image library. */
	scale?: number;
	settleMs?: number;
	timeoutMs?: number;
	/** Resolve nothing at all. Web fonts and remote images will not load. */
	offline?: boolean;
	/** Pin one hostname to an address already vetted, closing the rebinding gap. */
	pin?: { host: string; address: string } | null;
}

function chromeArgs(profile: string, opts: { offline?: boolean; pin?: ShotOptions["pin"]; settleMs?: number }): string[] {
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
		"--disable-client-side-phishing-detection",
		`--user-data-dir=${profile}`,
		`--virtual-time-budget=${opts.settleMs ?? DEFAULT_SETTLE_MS}`,
	];
	if (opts.offline) args.push("--host-resolver-rules=MAP * ~NOTFOUND");
	else if (opts.pin) args.push(`--host-resolver-rules=MAP ${opts.pin.host} ${opts.pin.address}`);
	return args;
}

/**
 * Run the browser once and wait for it, with a wall-clock kill that does not depend on the
 * child behaving. Returns stderr because Chromium says why it refused to start there and
 * nowhere else, and a packaged install with no diagnostics is a support ticket.
 */
async function run(binary: string, args: string[], timeoutMs: number): Promise<{ killed: boolean; stderr: string }> {
	const proc = Bun.spawn([binary, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// A browser inherits the environment it is given; this one gets almost none of it.
		env: { PATH: process.env.PATH ?? "/usr/bin", HOME: process.env.HOME ?? tmpdir(), DISPLAY: "" },
	});
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		proc.kill("SIGTERM");
		setTimeout(() => proc.kill("SIGKILL"), 2_000).unref?.();
	}, timeoutMs);
	const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	clearTimeout(timer);
	return { killed, stderr: stderr.slice(-2048) };
}

/** A throwaway profile, removed even when the run throws. */
function withProfile<T>(body: (profile: string) => Promise<T>): Promise<T> {
	const profile = mkdtempSync(join(tmpdir(), "claude-brain-browser-"));
	return body(profile).finally(() => {
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			/* a browser still shutting down; the OS will clear tmp */
		}
	});
}

/**
 * Render a page to a PNG. Never throws: a browser that will not start, a page that never
 * loads and a file that came back empty all answer with a sentence the dashboard can show.
 */
export async function screenshot(opts: ShotOptions): Promise<Rendered> {
	const binary = findBrowser();
	if (!binary) return { ok: false, reject: NO_BROWSER };

	const width = opts.width ?? DEFAULT_WIDTH;
	const height = opts.height ?? DEFAULT_HEIGHT;
	const result = await withProfile(async (profile) => {
		const args = [
			...chromeArgs(profile, opts),
			`--window-size=${width},${height}`,
			`--force-device-scale-factor=${opts.scale ?? 1}`,
			`--screenshot=${opts.out}`,
			opts.url,
		];
		return run(binary, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	});

	const file = Bun.file(opts.out);
	if (file.size === 0) {
		return {
			ok: false,
			reject: result.killed
				? "the page took too long to render"
				: `nothing was rendered${result.stderr ? ` — ${firstLine(result.stderr)}` : ""}`,
		};
	}
	const meta = imageMeta(new Uint8Array(await file.arrayBuffer()));
	if (!meta?.complete) return { ok: false, reject: "the render came back incomplete" };
	return { ok: true, path: opts.out, width: meta.width, height: meta.height };
}

/**
 * Load a page we wrote and read one string back out of it.
 *
 * The contract with the page: compute, then replace the document body with a single
 * `<pre id="out">` holding the answer. Replacing the body is what makes this parseable —
 * a serialized DOM otherwise contains the script that produced the answer as well, and
 * any marker in the output is also a literal in the source that produced it.
 */
export async function runPage(html: string, opts: { timeoutMs?: number; offline?: boolean } = {}): Promise<
	{ ok: true; output: string } | { ok: false; reject: string }
> {
	const binary = findBrowser();
	if (!binary) return { ok: false, reject: NO_BROWSER };

	return withProfile(async (profile) => {
		const page = join(profile, "page.html");
		await Bun.write(page, html);
		const args = [...chromeArgs(profile, { offline: opts.offline ?? true }), "--dump-dom", `file://${page}`];
		const proc = Bun.spawn([binary, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin", HOME: process.env.HOME ?? tmpdir(), DISPLAY: "" },
		});
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 2_000).unref?.();
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const dom = (await new Response(proc.stdout).text()).slice(0, MAX_DOM_BYTES);
		await proc.exited;
		clearTimeout(timer);

		if (killed) return { ok: false, reject: "the measurement page did not finish" };
		const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
		if (!match?.[1]) return { ok: false, reject: "the measurement page answered with nothing" };
		return { ok: true, output: unescapeHtml(match[1]) };
	});
}

/** Text nodes come back escaped in a serialized DOM; JSON needs them back as they were. */
function unescapeHtml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function firstLine(text: string): string {
	return text.trim().split("\n").find((line) => line.trim().length > 0)?.slice(0, 160) ?? "";
}
