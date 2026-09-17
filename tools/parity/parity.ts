#!/usr/bin/env bun
// Is the rebuild the same as the page? Measured, frame by frame, on the same clock.
//
//   record   <url> <out.json>          per-frame uniforms of a live page or a rebuild
//   compare  <a.json> <b.json>         two recordings, aligned at each one's mount
//   frames   <url> <dir> --at k,...    pixels (+ that frame's uniforms) at chosen frames
//   render   <frame.json> <dir> --at   the replay engine drawing each captured frame's exact
//                                      uniforms, scored against that frame's pixels
//   diff     <dirA> <dirB> --at k,...  two directories of frames, pixel by pixel
//
// Shared flags: --watch a,b  uniforms to log  (default uTime,time,uResolution,modelViewMatrix,
// projectionMatrix) · --mount name=value  a uniform's first-frame value, to align at the mount
// that stays · --mouse k:x:y,...  mouse moves after frame k · --viewport WxH (1280x1000)
// frames: --canvas  the canvas's own pixels (needs preserveDrawingBuffer) instead of a
// screenshot · --css-time ms  seek every CSS animation · --hide-canvas  DOM only
// compare: --clock a,b  uniforms compared as time since mount · diff: --regions JSON --heat

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page, withPage } from "../../src/cdp";
import { type RippedFrame, replayRuntime } from "../../src/webgl-ripper";
import { install, lastMount, readLarge, runTo, sceneStart } from "./hooks";

const [command, ...rest] = process.argv.slice(2);
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1]?.startsWith("--") && !isFlag(rest[i - 1]!)));
function isFlag(name: string): boolean {
	return ["--canvas", "--hide-canvas", "--heat"].includes(name);
}
const flag = (name: string): string | undefined => {
	const i = rest.indexOf(`--${name}`);
	return i >= 0 ? (isFlag(`--${name}`) ? "true" : rest[i + 1]) : undefined;
};
const list = (name: string, fallback: string) => (flag(name) ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
const watch = list("watch", "uTime,time,uResolution,modelViewMatrix,projectionMatrix");
const frames = list("at", "").map(Number);
const [vw, vh] = (flag("viewport") ?? "1280x1000").split("x").map(Number) as [number, number];
const marker = (() => {
	const m = flag("mount")?.split("=");
	return m && m.length === 2 ? { name: m[0]!, value: Number(m[1]) } : null;
})();
const mouse = list("mouse", "").map((s) => s.split(":").map(Number) as [number, number, number]);

/** Open the page on the virtual clock and stop at the scene's mount. */
async function open(page: Page, url: string): Promise<number> {
	await install(page, [...new Set([...watch, ...(marker ? [marker.name] : [])])]);
	await page.goto(url, { width: vw, height: vh, loadTimeoutMs: 40_000 });
	const start = await sceneStart(page);
	return lastMount(page, start, marker);
}

/** Mouse moves and captures, in frame order, each after the frame it names has run. */
async function script(page: Page, mount: number, captures: number[], capture: (k: number, frame: number) => Promise<void>): Promise<void> {
	const events = [
		...mouse.map(([k, x, y]) => ({ k, x, y, kind: "mouse" as const })),
		...captures.map((k) => ({ k, x: 0, y: 0, kind: "capture" as const })),
	].sort((a, b) => a.k - b.k || (a.kind === "capture" ? -1 : 1));
	for (const event of events) {
		if (event.kind === "mouse") {
			await runTo(page, mount + event.k);
			await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: event.x, y: event.y });
			continue;
		}
		// Locating the mount runs the clock on, and a frame that has already run with its
		// draws skipped cannot be photographed: the canvas would hold whatever came before.
		const now = (await page.evaluate<number>("window.__vclock.frame")) ?? 0;
		if (now >= mount + event.k) {
			throw new Error(`frame ${event.k} after the mount had already run (the clock is at ${now - mount}); capture a later frame or drop --mount`);
		}
		await runTo(page, mount + event.k - 1);
		await page.evaluate("window.__skipDraws = false");
		const f = await runTo(page, mount + event.k);
		await page.evaluate("window.__skipDraws = true");
		await capture(event.k, f);
	}
}

async function record(url: string, out: string): Promise<void> {
	const total = Number(flag("frames") ?? 3000);
	const run = await withPage(async (page) => {
		const mount = await open(page, url);
		await script(page, mount, [], async () => {});
		await runTo(page, mount + total, 900_000);
		const json = await readLarge(page, `{ sceneStart: window.__uniformLog.sceneStart, mount: ${mount}, frames: window.__uniformLog.frames, innerWidth, innerHeight, mouse: ${JSON.stringify(mouse)} }`);
		await Bun.write(out, json);
		return mount;
	});
	console.log(run.ok ? `recorded ${total} frames from mount ${run.value} → ${out}` : `failed: ${run.reject}`);
}

function compare(aPath: string, bPath: string, A: any, B: any): void {
	const clocks = list("clock", "uTime,time");
	const rows = (rec: any) => new Map<number, any>(rec.frames.filter((r: any) => r.f >= rec.mount).map((r: any) => [r.f - rec.mount, r]));
	const ra = rows(A), rb = rows(B);
	const worst = new Map<string, { err: number; k: number }>();
	const note = (key: string, err: number, k: number) => {
		const w = worst.get(key);
		if (!w || err > w.err || Number.isNaN(err)) worst.set(key, { err, k });
	};
	const base = new Map<string, number>();
	let compared = 0;
	for (let k = 0; k < Math.min(ra.size, rb.size); k++) {
		const a = ra.get(k), b = rb.get(k);
		if (!a || !b) { note("(frame missing)", 1, k); continue; }
		if (a.draws.length !== b.draws.length) note("(pass count)", Math.abs(a.draws.length - b.draws.length), k);
		for (let pass = 0; pass < Math.min(a.draws.length, b.draws.length); pass++) {
			const x = a.draws[pass], y = b.draws[pass];
			note(`pass ${pass} viewport`, Math.abs(x.vp[0] - y.vp[0]) + Math.abs(x.vp[1] - y.vp[1]), k);
			for (const name of Object.keys(x.u)) {
				const u = x.u[name] as number[], v = y.u[name] as number[] | undefined;
				if (!v) { note(`pass ${pass} ${name} (missing)`, 1, k); continue; }
				if (clocks.includes(name) && u.length === 1) {
					const key = `${pass}:${name}`;
					if (!base.has(`a${key}`)) { base.set(`a${key}`, u[0]!); base.set(`b${key}`, v[0]!); }
					note(`pass ${pass} ${name} since mount`, Math.abs((u[0]! - base.get(`a${key}`)!) - (v[0]! - base.get(`b${key}`)!)), k);
				} else {
					note(`pass ${pass} ${name}`, u.reduce((m, value, i) => Math.max(m, Math.abs(value - (v[i] ?? Number.NaN))), 0), k);
				}
			}
		}
		compared++;
	}
	console.log(`${compared} frames compared (${aPath} from mount ${A.mount}, ${bPath} from mount ${B.mount})`);
	for (const [key, w] of [...worst].sort()) console.log(`  ${key.padEnd(40)} max ${w.err.toExponential(2)} at k=${w.k}`);
}

async function captureFrames(url: string, dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const cssTime = flag("css-time");
	const run = await withPage(async (page) => {
		const mount = await open(page, url);
		await page.evaluate("document.fonts.ready.then(() => true)", 30_000);
		await script(page, mount, frames, async (k, f) => {
			if (cssTime) await page.evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${Number(cssTime)}; }); true`);
			if (flag("hide-canvas")) await page.evaluate(`document.querySelectorAll("canvas").forEach((c) => (c.style.visibility = "hidden")); true`);
			await Bun.sleep(300);
			if (flag("canvas")) {
				const url = JSON.parse(await readLarge(page, `document.querySelector("canvas").toDataURL("image/png")`)) as string;
				await Bun.write(join(dir, `k${k}.png`), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
			} else {
				const png = await page.screenshot({ width: vw, height: vh });
				if (png) await Bun.write(join(dir, `k${k}.png`), png);
			}
			const row = await page.evaluate(`window.__uniformLog.frames.find((r) => r.f === ${f})`);
			await Bun.write(join(dir, `k${k}.json`), JSON.stringify(row));
			console.log(`  k=${k} (frame ${f})`);
		});
		return mount;
	});
	console.log(run.ok ? `mount ${run.value} → ${dir}` : `failed: ${run.reject}`);
}

// ---- pixel comparison, done in a browser: no image library in this package ------------------

const DIFF_SCRIPT = String.raw`
const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("could not load " + src)); i.src = src; });
const pixels = (img) => { const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
window.diffImages = async (srcA, srcB, heatName, regions) => {
	const [ia, ib] = await Promise.all([load(srcA), load(srcB)]);
	if (ia.naturalWidth !== ib.naturalWidth || ia.naturalHeight !== ib.naturalHeight) return { error: "sizes differ: " + ia.naturalWidth + "x" + ia.naturalHeight + " vs " + ib.naturalWidth + "x" + ib.naturalHeight };
	const a = pixels(ia), b = pixels(ib), w = ia.naturalWidth, h = ia.naturalHeight, n = w * h;
	const heat = heatName ? new ImageData(w, h) : null;
	const named = (regions || []).map((r) => ({ ...r, n: 0, over2: 0, over8: 0 }));
	let sum = 0, max = 0, over2 = 0, over8 = 0, over24 = 0;
	for (let p = 0, i = 0; p < n; p++, i += 4) {
		const d0 = Math.abs(a[i] - b[i]), d1 = Math.abs(a[i + 1] - b[i + 1]), d2 = Math.abs(a[i + 2] - b[i + 2]);
		const d = Math.max(d0, d1, d2);
		sum += d0 + d1 + d2;
		if (d > max) max = d;
		if (d > 2) over2++;
		if (d > 8) over8++;
		if (d > 24) over24++;
		if (heat) { heat.data[i] = Math.min(255, d * 10); heat.data[i + 1] = d ? 40 : 0; heat.data[i + 3] = 255; }
		if (named.length) {
			const x = p % w, y = (p / w) | 0;
			for (const r of named) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { r.n++; if (d > 2) r.over2++; if (d > 8) r.over8++; }
		}
	}
	if (heat) {
		const c = document.createElement("canvas"); c.width = w; c.height = h;
		c.getContext("2d").putImageData(heat, 0, 0);
		await fetch("/save?name=" + encodeURIComponent(heatName), { method: "POST", body: c.toDataURL("image/png") });
	}
	const pc = (v) => +(v / n * 100).toFixed(3);
	return { meanAbs: +(sum / (n * 3)).toFixed(3), max, over2: pc(over2), over8: pc(over8), over24: pc(over24),
		regions: Object.fromEntries(named.map((r) => [r.name, { over2: +(r.over2 / (r.n || 1) * 100).toFixed(2), over8: +(r.over8 / (r.n || 1) * 100).toFixed(2) }])) };
};`;

/** A loopback server for a comparison page: static files from named roots, and PNG uploads. */
function serve(roots: Record<string, string>, pageHtml: string, extra?: (path: string) => Response | null) {
	return Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/") return new Response(pageHtml, { headers: { "content-type": "text/html" } });
			if (url.pathname === "/save" && req.method === "POST") {
				const name = url.searchParams.get("name") ?? "";
				if (!/^[\w./-]+\.png$/.test(name) || name.includes("..")) return new Response("no", { status: 400 });
				const body = await req.text();
				await Bun.write(resolve(roots.out ?? ".", name), Buffer.from(body.slice(body.indexOf(",") + 1), "base64"));
				return new Response("ok");
			}
			const own = extra?.(url.pathname);
			if (own) return own;
			const m = url.pathname.match(/^\/(\w+)\/([\w.-]+)$/);
			if (m && roots[m[1]!] && !m[2]!.includes("..")) return new Response(Bun.file(join(roots[m[1]!]!, m[2]!)));
			return new Response("not found", { status: 404 });
		},
	});
}

async function diff(dirA: string, dirB: string): Promise<void> {
	const regions = flag("regions") ? JSON.parse(flag("regions")!) : [];
	const server = serve({ a: dirA, b: dirB, out: dirB }, `<!doctype html><meta charset="utf-8"><script>${DIFF_SCRIPT}</script>`);
	const run = await withPage(async (page) => {
		await page.goto(`http://127.0.0.1:${server.port}/`, { width: 800, height: 600, loadTimeoutMs: 20_000 });
		for (const k of frames) {
			const result = await page.evaluate(`window.diffImages("/a/k${k}.png", "/b/k${k}.png", ${flag("heat") ? JSON.stringify(`heat-k${k}.png`) : "null"}, ${JSON.stringify(regions)})`, 180_000);
			console.log(`k=${k}`, JSON.stringify(result));
		}
		return true;
	});
	server.stop(true);
	if (!run.ok) console.log(`failed: ${run.reject}`);
}

async function render(framePath: string, dir: string): Promise<void> {
	const frame: RippedFrame = JSON.parse(await Bun.file(framePath).text());
	const css = frame.canvasCss ?? { width: vw, height: vh };
	const pageHtml = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block;width:${css.width}px;height:${css.height}px}</style>
<canvas data-hero-scene></canvas>
<script>window.__heroManual = true;</script><script src="/hero.js"></script>
<script>${DIFF_SCRIPT}
const WATCH = ${JSON.stringify(watch)};
window.renderState = async (k) => {
	const scene = window.__heroScene;
	const log = await (await fetch("/real/k" + k + ".json")).json();
	const passes = scene.draws.filter((d) => [...d.uniforms.keys()].some((n) => WATCH.includes(n)));
	if (passes.length !== log.draws.length) return { error: "passes: replay " + passes.length + ", page " + log.draws.length };
	log.draws.forEach((pass, i) => { for (const [name, value] of Object.entries(pass.u)) scene.set(passes[i].index, name, value); });
	const screen = log.draws.find((p) => p.fbo === 0);
	scene.setPixelRatio(screen.cw / ${css.width});
	log.draws.forEach((pass, i) => { if (pass.fbo !== 0) scene.setTargetSize(passes[i].target, pass.vp[0], pass.vp[1]); });
	scene.render();
	await fetch("/save?name=replay-k" + k + ".png", { method: "POST", body: scene.canvas.toDataURL("image/png") });
	return window.diffImages("/real/k" + k + ".png", "/out/replay-k" + k + ".png", null, []);
};</script>`;
	const script = replayRuntime(frame, "", { inline: true });
	const server = serve({ real: dir, out: dir }, pageHtml, (path) =>
		path === "/hero.js" ? new Response(script, { headers: { "content-type": "text/javascript" } }) : null,
	);
	const run = await withPage(async (page) => {
		await page.goto(`http://127.0.0.1:${server.port}/`, { width: Math.ceil(css.width) + 80, height: Math.ceil(css.height) + 80, loadTimeoutMs: 30_000 });
		for (let i = 0; i < 100 && !(await page.evaluate<boolean>("!!window.__heroScene")); i++) await Bun.sleep(100);
		for (const k of frames) console.log(`k=${k}`, JSON.stringify(await page.evaluate(`window.renderState(${k})`, 180_000)));
		return true;
	});
	server.stop(true);
	if (!run.ok) console.log(`failed: ${run.reject}`);
}

switch (command) {
	case "record":
		await record(positional[0]!, positional[1]!);
		break;
	case "compare": {
		const [a, b] = [positional[0]!, positional[1]!];
		compare(a, b, JSON.parse(await Bun.file(a).text()), JSON.parse(await Bun.file(b).text()));
		break;
	}
	case "frames":
		await captureFrames(positional[0]!, positional[1]!);
		break;
	case "render":
		await render(positional[0]!, positional[1]!);
		break;
	case "diff":
		await diff(positional[0]!, positional[1]!);
		break;
	default:
		console.log("usage: parity.ts record|compare|frames|render|diff … (see the header of this file)");
		process.exit(command ? 1 : 0);
}
