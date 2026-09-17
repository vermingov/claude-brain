// A page rebuilt from itself, in one visit.
//
// The pieces live elsewhere: the DOM and its rules (page-transplant.ts), what the page's script
// does to that DOM over time and under a pointer (dom-recording.ts, dom-tapes.ts), the resources
// all of it points at (page-resources.ts), and the runtime that plays it back, with the replay
// engine when a WebGL scene was ripped in its own visit (webgl-ripper.ts). This is the order they
// run in.
//
// No clock is virtualised here. The recording has to be stamped in the time the page's timers and
// transitions run in; only rasterising WebGL is skipped, so a scene does not starve the frames
// everything else is waiting on.

import { withPage } from "./cdp";
import { type DomRecording, type ExploreOptions, RECORDER_SCRIPT, explore } from "./dom-recording";
import { type DomTapes, buildTapes, eachTapeOp } from "./dom-tapes";
import { assembleTransplant, captureTransplant, pageScriptText, withHeroCanvas } from "./page-transplant";
import { SKIP_DRAWS } from "./parity-hooks";
import { type RippedFrame, rebuildRuntime } from "./webgl-ripper";

const VIEWPORT = { width: 1280, height: 800 };
const LOAD_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;

export interface PageRebuildOptions {
	/** Where the document loads its runtime from, relative to the document. */
	runtimeHref: string;
	viewport?: { width: number; height: number };
	/** A scene ripped from this page, and which of the page's canvases it was drawn into. */
	scene?: { frame: RippedFrame; behaviour?: string; canvas: number };
	explore?: Partial<Omit<ExploreOptions, "viewport">>;
}

export interface PageRebuild {
	html: string;
	runtime: string;
	recording: DomRecording;
	tapes: DomTapes;
	/** What was kept and what was not, in numbers, for the notes. */
	stats: { rules: number; assets: number; ops: number; tapes: number; interactions: number; loops: number; seconds: number };
}

export async function rebuildPage(url: string, options: PageRebuildOptions): Promise<PageRebuild | { error: string }> {
	const started = Date.now();
	const viewport = options.viewport ?? VIEWPORT;
	const visit = await withPage(async (page) => {
		await page.addInitScript(SKIP_DRAWS);
		await page.addInitScript(RECORDER_SCRIPT);
		await page.goto(url, { ...viewport, loadTimeoutMs: LOAD_TIMEOUT_MS, afterSettleMs: SETTLE_MS });
		const transplant = await captureTransplant(page);
		if (!transplant?.ok) return { transplant, recording: null, scriptText: "" };
		const recording = await explore(page, { viewport, ...options.explore });
		return { transplant, recording, scriptText: await pageScriptText(page) };
	});
	if (!visit.ok) return { error: visit.reject };
	const { transplant, recording, scriptText } = visit.value;
	if (!transplant?.ok) return { error: transplant?.note || "the page could not be read" };
	if (!recording) return { error: "the page's behaviour could not be recorded" };

	const tapes = buildTapes(recording);
	const scene = options.scene;
	const built = await assembleTransplant(transplant, {
		scriptText,
		transformBody: scene ? (body) => withHeroCanvas(body, scene.canvas) : undefined,
		tail: `<script src="${options.runtimeHref}"></script>`,
	});

	// The tapes point at resources too: an image a click swaps in, a panel a demo renders.
	const { resources } = built;
	const rewrite = (op: unknown[], note: boolean) => {
		if (op[1] === "c" && typeof op[3] === "string") {
			if (note) resources.noteMarkup(op[3]);
			else op[3] = resources.markup(op[3]);
		} else if (op[1] === "a" && typeof op[3] === "string" && typeof op[4] === "string") {
			if (note) resources.noteAttribute(op[3], op[4]);
			else op[4] = resources.attribute(op[3], op[4]);
		}
	};
	eachTapeOp(tapes, (op) => rewrite(op, true));
	await resources.download();
	eachTapeOp(tapes, (op) => rewrite(op, false));

	const runtime = rebuildRuntime({ tapes, scene: scene ? { frame: scene.frame, behaviour: scene.behaviour } : undefined });
	const loops = tapes.tapes.filter((t) => t.loop).length + tapes.tapes.reduce((n, t) => n + t.episodes.filter((e) => e.loop).length, 0);
	return {
		html: built.html,
		runtime,
		recording,
		tapes,
		stats: {
			rules: built.rules,
			assets: resources.assets.length,
			ops: recording.ops.length,
			tapes: tapes.tapes.length,
			interactions: tapes.interactions.length,
			loops,
			seconds: Math.round((Date.now() - started) / 1000),
		},
	};
}
