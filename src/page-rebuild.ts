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
import { type DomRecording, type ExploreOptions, PAGE_CLOCK, RECORDER_SCRIPT, explore } from "./dom-recording";
import { type DomTapes, buildTapes, eachTapeOp } from "./dom-tapes";
import { assembleTransplant, captureTransplant, heroCanvasIndex, pageScriptText, withHeroCanvas } from "./page-transplant";
import { SKIP_DRAWS } from "./parity-hooks";
import { type SiteRecording, recordSite } from "./site-capture";
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
	/**
	 * Something else that draws the page's moving background — a shader read off it in an earlier
	 * visit, a player for photographed frames — as the script that draws it and the marker its
	 * canvas needs. Appended after the tapes, in the same runtime file.
	 */
	hero?: { runtime: string; marker: string; canvas?: number };
	explore?: Partial<Omit<ExploreOptions, "viewport">>;
	/** Called through the whole rebuild, with what is happening and how far through it is. */
	onProgress?: (stage: string, progress: number, detail?: string) => void;
}

export interface PageRebuild {
	html: string;
	runtime: string;
	recording: DomRecording;
	tapes: DomTapes;
	/** Everything the page asked the network for during the visit, for running its own code again. */
	site: SiteRecording;
	/** What was kept and what was not, in numbers, for the notes. */
	stats: { rules: number; assets: number; ops: number; tapes: number; interactions: number; loops: number; seconds: number };
}

export async function rebuildPage(url: string, options: PageRebuildOptions): Promise<PageRebuild | { error: string }> {
	const started = Date.now();
	const viewport = options.viewport ?? VIEWPORT;
	// The stages, and the share of the whole each one ends at. Watching the page is most of it.
	const say = options.onProgress ?? (() => {});
	const WATCHING = { from: 0.15, to: 0.75 };
	const visit = await withPage(async (page) => {
		await page.addInitScript(SKIP_DRAWS);
		await page.addInitScript(PAGE_CLOCK);
		await page.addInitScript(RECORDER_SCRIPT);
		// Before the page opens, so its document is the first thing kept; and through the whole
		// visit, because what a page loads when a control is first used is loaded then and not before.
		const traffic = await recordSite(page);
		say("opening the page", 0.02, url);
		await page.goto(url, { ...viewport, loadTimeoutMs: LOAD_TIMEOUT_MS, afterSettleMs: SETTLE_MS });
		say("reading its DOM and every rule that applies to it", 0.06);
		const transplant = await captureTransplant(page);
		if (!transplant?.ok) return { transplant, recording: null, scriptText: "", site: null };
		const recording = await explore(page, {
			viewport,
			...options.explore,
			onProgress: (stage, progress, detail) => say(stage, WATCHING.from + (WATCHING.to - WATCHING.from) * progress, detail),
		});
		say("reading the page's own scripts", 0.77);
		const scriptText = await pageScriptText(page);
		return { transplant, recording, scriptText, site: await traffic.stop() };
	});
	if (!visit.ok) return { error: visit.reject };
	const { transplant, recording, scriptText, site } = visit.value;
	if (!transplant?.ok) return { error: transplant?.note || "the page could not be read" };
	if (!recording || !site) return { error: "the page's behaviour could not be recorded" };
	// While it probes, the visit answers every attempt to leave the page with 204 No Content. Those
	// are this harness declining to go, not something the site said, and a copy that kept them would
	// make every link on the page do nothing.
	site.exchanges = site.exchanges.filter((exchange) => !(exchange.kind === "Document" && exchange.status === 204));

	say("working out what set each change off", 0.8, `${recording.ops.length} changes recorded`);
	const tapes = buildTapes(recording);
	const scene = options.scene;
	const hero = options.hero;
	const markHero = (body: string) => {
		if (scene) return withHeroCanvas(body, scene.canvas, "data-hero-scene");
		if (!hero) return body;
		const canvas = hero.canvas ?? heroCanvasIndex(body);
		return canvas >= 0 ? withHeroCanvas(body, canvas, hero.marker) : body;
	};
	const built = await assembleTransplant(transplant, {
		scriptText,
		transformBody: scene || hero ? markHero : undefined,
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
	say("downloading what the page points at", 0.86, `${resources.assets.length} files so far`);
	await resources.download();
	eachTapeOp(tapes, (op) => rewrite(op, false));
	say("writing the page and its runtime", 0.95, `${tapes.tapes.length} tapes, ${tapes.interactions.length} things that answer a pointer`);

	const runtime = [rebuildRuntime({ tapes, scene: scene ? { frame: scene.frame, behaviour: scene.behaviour } : undefined }), hero?.runtime ?? ""]
		.filter(Boolean)
		.join("\n");
	const loops = tapes.tapes.filter((t) => t.loop).length + tapes.tapes.reduce((n, t) => n + t.episodes.filter((e) => e.loop).length, 0);
	return {
		html: built.html,
		runtime,
		recording,
		tapes,
		site,
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
