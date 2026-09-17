// One visit to a page with a WebGL scene: take the scene, and record what it does.
//
// Both on a virtual clock, with rasterisation skipped. The clock is what makes the capture
// true to a real screen: every frame the page sees is exactly 1/60 s long, however slowly
// software rendering would have drawn it, so easing that integrates its frame delta behaves
// as it does on a person's monitor instead of blowing up on two-second frames — which is how
// raycast.com's glass distortion was once recorded as -47253. Skipping the draws is what
// makes it fast: uniforms still upload and state still moves, and thirty seconds of scene
// take thirty seconds.
//
// What comes back:
//   the frame       buffers, textures, programs, targets, draws — for the replay engine
//   a recording     every uniform of every pass of every frame, change-only, while a
//                   scripted pointer crosses the page: the ground truth a behaviour ported
//                   from the page's code is checked against
//   the canvas      which one, in document order, so the rebuild can put the engine there
//   the scripts     every script the page ran, where the scene's own code is to be found

import { type Page, withPage } from "./cdp";
import { type Recording, SKIP_DRAWS, VIRTUAL_CLOCK, readLarge, runTo, sceneStart, uniformLog } from "./parity-hooks";
import { RIPPER_HOOK_SCRIPT, RIPPER_STASH_SCRIPT, type RippedFrame, ripperSliceScript } from "./webgl-ripper";

/** Frames recorded after the scene's first: entrance, pointer, some settled motion. */
export const RECORD_FRAMES = 1600;
/**
 * Where the pointer goes, as fractions of the viewport, after which frame. Chosen to step in
 * each direction and come back to rest, so a scene that follows the pointer shows its response
 * and one that ignores it shows that too.
 */
export const POINTER_PATH: Array<[number, number, number]> = [
	[300, 0.25, 0.3],
	[600, 0.85, 0.8],
	[900, 0.5, 0.5],
	[1150, 0.08, 0.92],
	[1400, 0.5, 0.5],
];

/** Scroll positions after which frame: a little way down and back, for scroll-driven scenes. */
export const SCROLL_PATH: Array<[number, number]> = [
	[1250, 300],
	[1350, 0],
];

/** The pointer and scroll script every recording shares, page and port alike. */
export async function playScript(page: Page, mount: number, viewport: { width: number; height: number }): Promise<Array<[number, number, number]>> {
	const mouse: Array<[number, number, number]> = POINTER_PATH.map(([k, fx, fy]) => [k, Math.round(fx * viewport.width), Math.round(fy * viewport.height)]);
	const events = [
		...mouse.map(([k, x, y]) => ({ k, run: () => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }) })),
		...SCROLL_PATH.map(([k, y]) => ({ k, run: () => page.evaluate(`window.scrollTo(0, ${y}); true`) })),
	].sort((a, b) => a.k - b.k);
	for (const event of events) {
		await runTo(page, mount + event.k, 600_000);
		await event.run();
	}
	return mouse;
}

export interface SceneRip {
	frame: RippedFrame;
	canvasIndex: number;
	recording: Recording | null;
	scripts: string[];
	inlineScripts: string;
}

export async function ripScene(
	url: string,
	viewport: { width: number; height: number },
	pin: { host: string; address: string } | null,
): Promise<{ ok: true; rip: SceneRip } | { ok: false; reject: string }> {
	const run = await withPage(
		async (page) => {
			await page.addInitScript(VIRTUAL_CLOCK);
			await page.addInitScript(SKIP_DRAWS);
			await page.addInitScript(RIPPER_HOOK_SCRIPT);
			await page.addInitScript(uniformLog("all"));
			await page.goto(url, { width: viewport.width, height: viewport.height, loadTimeoutMs: 45_000 });
			const mount = await sceneStart(page, 90_000);

			const mouse = await playScript(page, mount, viewport);
			await runTo(page, mount + RECORD_FRAMES, 600_000);
			const recording = JSON.parse(
				(await readLarge(page, `{ sceneStart: window.__uniformLog.sceneStart, mount: ${mount}, frames: window.__uniformLog.frames, innerWidth, innerHeight, mouse: ${JSON.stringify(mouse)} }`)) || "null",
			) as Recording | null;

			// The ripper finishes on its own schedule, in page time: let the clock run for it.
			await page.evaluate("window.__vclock.pauseAt = -1; window.__vclock.paused = false");
			const length = await page.evaluate<number>(RIPPER_STASH_SCRIPT, 240_000);
			if (!length) return null;
			let json = "";
			for (let from = 0; from < length; from += 1_000_000) {
				json += (await page.evaluate<string>(ripperSliceScript(from, 1_000_000), 60_000)) ?? "";
			}
			const frame = JSON.parse(json) as RippedFrame;
			const canvasIndex =
				(await page.evaluate<number>(
					`(() => { const rip = window.__brainRip; const c = rip && rip.lastGl && rip.lastGl.canvas; return c ? Array.from(document.querySelectorAll("canvas")).indexOf(c) : -1; })()`,
				)) ?? -1;
			const scripts =
				(await page.evaluate<string[]>(
					`Array.from(new Set([...performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\.m?js(\\?|$)/.test(n)), ...Array.from(document.scripts).map((s) => s.src).filter(Boolean)]))`,
				)) ?? [];
			const inlineScripts =
				(await page.evaluate<string>(`Array.from(document.scripts).filter((s) => !s.src).map((s) => s.textContent).join("\\n").slice(0, 4000000)`)) ?? "";
			return { frame, canvasIndex, recording, scripts, inlineScripts };
		},
		{ pin },
	);
	if (!run.ok) return { ok: false, reject: run.reject };
	if (!run.value) return { ok: false, reject: "the scene was drawn but could not be read back" };
	if (!run.value.frame.ok) return { ok: false, reject: run.value.frame.note || "no frame was captured" };
	return { ok: true, rip: run.value };
}
