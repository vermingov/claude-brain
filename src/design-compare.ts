// How close is the rebuild to the real thing?
//
// The recreation loop needs a number it can act on, and "how similar are these two PNGs"
// is a question with several honest answers that disagree. A rebuild can have every colour
// right and every box in the wrong place; another can have the layout to the pixel and be
// the wrong grey throughout. One mean-difference score calls both "70%" and tells the model
// nothing about which mistake it made, so three are measured separately:
//
//   pixel    the share of pixels that visibly disagree. Not mean absolute error: on a page
//            that is 90% near-black, a mean over every pixel is dominated by the agreeing
//            background and reports 100% for a rebuild whose nav is fifteen pixels out.
//            Counting pixels past a just-noticeable threshold measures the disagreement
//            instead of diluting it.
//   layout   the same count over an edge map, and only where at least one of the two images
//            HAS an edge. Colour-blind and background-blind: it asks whether the boxes and
//            the type land in the same places, and says nothing about the empty space
//            between them, which is where the mean-error version got its free marks.
//   palette  histogram intersection over a 4×4×4 colour cube. Position-blind, so it says
//            whether the right colours are present in roughly the right proportions.
//
// And a grid of named regions, worst first, because "the top strip is 41% off" is something
// the next round can act on, where "you scored 0.71" is not.
//
// The arithmetic runs inside the browser we already need for the screenshots. Decoding a
// PNG in Bun would mean an image dependency for a package that deliberately has none, and
// the canvas is right there. Both images go in as data URIs: a file:// page may load a
// file:// image, but reading it back off the canvas taints it, and a tainted canvas throws
// exactly where the measurement happens.

import { runPage } from "./headless";

/** Working resolution for the pixel pass. Big enough for layout, small enough to be free. */
const W = 320;
const H = 200;
/** The edge pass runs at half that: gradients are noisy, and noise is not a design. */
const EW = 160;
const EH = 100;
const GRID_COLS = 4;
const GRID_ROWS = 3;
/** Channel distance a pixel must exceed to count as visibly wrong. Below roughly this,
 *  two greys are the same grey to a person looking at a screen. */
const PIXEL_THRESHOLD = 12;
/**
 * Gradient strength that counts as an edge at all, and how far two edges may differ.
 *
 * Calibrated rather than guessed. At 0.06 every soft ramp in a full-bleed gradient counted
 * as structure, so a rebuild whose nav and type land within a pixel scored 31% on layout
 * while a completely unrelated page scored 6% — a spread of 25 points between "almost
 * right" and "not the same page at all". Raising the floor keeps text edges and box borders
 * (0.5–0.9) and drops the background texture:
 *
 *   floor   rebuild vs real page   an unrelated page
 *   0.06    layout 31%             layout 6%
 *   0.18    layout 57%             layout 9%
 *   0.30    layout 71%             layout 9%
 *
 * 0.30 it is: the same unrelated-page floor, and a layout score that agrees with what the
 * two screenshots look like side by side.
 */
const EDGE_FLOOR = 0.3;
const EDGE_THRESHOLD = 0.3;

export interface RegionDiff {
	/** "the top-left corner", "the centre", "the bottom strip" — for a sentence. */
	where: string;
	/** 0..1, how different that block is. */
	diff: number;
}

export interface Comparison {
	ok: boolean;
	/** 0..1 overall, the number the loop stops on. */
	score: number;
	pixel: number;
	layout: number;
	palette: number;
	regions: RegionDiff[];
	reject?: string;
}

const COL_NAMES = ["the left edge", "the left-of-centre column", "the right-of-centre column", "the right edge"];
const ROW_NAMES = ["the top", "the middle", "the bottom"];

function regionName(col: number, row: number): string {
	return `${ROW_NAMES[row] ?? "the middle"} of ${COL_NAMES[col] ?? "the page"}`;
}

/**
 * The page that does the arithmetic. Written as a string rather than imported, because it
 * runs in a browser this process only talks to through a command line — and it must end by
 * replacing the body with a single `<pre id="out">`, which is runPage's whole contract.
 */
function measurePage(aDataUri: string, bDataUri: string): string {
	const script = String.raw`
const load = (src) => new Promise((res, rej) => {
	const img = new Image();
	img.onload = () => res(img);
	img.onerror = () => rej(new Error("that image could not be decoded"));
	img.src = src;
});

const answer = (value) => {
	document.body.innerHTML = "";
	const pre = document.createElement("pre");
	pre.id = "out";
	pre.textContent = JSON.stringify(value);
	document.body.appendChild(pre);
};

const pixels = (img, w, h) => {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	// White, not transparent: a rebuild that forgot a background would otherwise compare
	// as black and score far worse than it deserves.
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(img, 0, 0, w, h);
	return ctx.getImageData(0, 0, w, h).data;
};

const luma = (data, w, h) => {
	const out = new Float32Array(w * h);
	for (let i = 0, p = 0; i < data.length; i += 4, p++) {
		out[p] = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
	}
	return out;
};

/** Gradient magnitude — where the image changes, which is where the design's edges are. */
const edges = (l, w, h) => {
	const out = new Float32Array(w * h);
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const gx = l[i + 1] - l[i - 1];
			const gy = l[i + w] - l[i - w];
			out[i] = Math.min(1, Math.hypot(gx, gy));
		}
	}
	return out;
};

/** How far apart two pixels are, on their worst channel. */
const worstChannel = (a, b, i) => Math.max(
	Math.abs(a[i] - b[i]),
	Math.abs(a[i + 1] - b[i + 1]),
	Math.abs(a[i + 2] - b[i + 2]),
);

/** 4 bits of colour per channel, normalised — present in what proportion, not where. */
const cube = (data) => {
	const bins = new Float64Array(64);
	let total = 0;
	for (let i = 0; i < data.length; i += 4) {
		const idx = (data[i] >> 6) * 16 + (data[i + 1] >> 6) * 4 + (data[i + 2] >> 6);
		bins[idx]++;
		total++;
	}
	for (let i = 0; i < bins.length; i++) bins[i] /= total || 1;
	return bins;
};

const intersection = (a, b) => {
	let shared = 0;
	for (let i = 0; i < a.length; i++) shared += Math.min(a[i], b[i]);
	return shared;
};

(async () => {
	try {
		const [left, right] = await Promise.all([load(IMAGE_A), load(IMAGE_B)]);
		const a = pixels(left, WIDTH, HEIGHT);
		const b = pixels(right, WIDTH, HEIGHT);

		let differing = 0;
		for (let i = 0; i < a.length; i += 4) {
			if (worstChannel(a, b, i) > PIXEL_THRESHOLD) differing++;
		}
		const pixel = 1 - differing / (WIDTH * HEIGHT);

		const ea = pixels(left, EWIDTH, EHEIGHT);
		const eb = pixels(right, EWIDTH, EHEIGHT);
		const edgeA = edges(luma(ea, EWIDTH, EHEIGHT), EWIDTH, EHEIGHT);
		const edgeB = edges(luma(eb, EWIDTH, EHEIGHT), EWIDTH, EHEIGHT);
		let edgePixels = 0;
		let edgeMisses = 0;
		for (let i = 0; i < edgeA.length; i++) {
			const strongest = Math.max(edgeA[i], edgeB[i]);
			if (strongest < EDGE_FLOOR) continue;
			edgePixels++;
			if (Math.abs(edgeA[i] - edgeB[i]) > EDGE_THRESHOLD) edgeMisses++;
		}
		// Two images with no structure at either threshold genuinely agree about having
		// none — a soft gradient with no hard edges is a real thing to photograph. Scoring
		// that zero said "completely different layout" about two pictures that were the same
		// picture. Too few edge pixels to judge is reported as agreement, and the pixel and
		// palette terms carry the comparison instead.
		const layout = edgePixels > 64 ? 1 - edgeMisses / edgePixels : 1;

		const palette = intersection(cube(a), cube(b));

		// Per-block, by the same count: "38% of this block's pixels differ" is something the
		// next round can go and look at, where "this block averages 4 levels of grey out"
		// is not.
		const regions = [];
		const bw = Math.floor(WIDTH / COLS);
		const bh = Math.floor(HEIGHT / ROWS);
		for (let row = 0; row < ROWS; row++) {
			for (let col = 0; col < COLS; col++) {
				let blockDiffering = 0;
				let count = 0;
				for (let y = row * bh; y < (row + 1) * bh; y++) {
					for (let x = col * bw; x < (col + 1) * bw; x++) {
						const i = (y * WIDTH + x) * 4;
						if (worstChannel(a, b, i) > PIXEL_THRESHOLD) blockDiffering++;
						count++;
					}
				}
				regions.push({ col, row, diff: count > 0 ? blockDiffering / count : 0 });
			}
		}
		answer({ ok: true, pixel, layout, palette, regions });
	} catch (err) {
		answer({ ok: false, error: String((err && err.message) || err) });
	}
})();
`
		// Dimensions first, images last. Base64 is drawn from an alphabet that includes
		// every letter, so a blob can legitimately contain the text `WIDTH` — substituting
		// into the script after the images are in it would corrupt a PNG now and then, in a
		// way that looks like a decode failure and reproduces on one image in a thousand.
		.replace(/\bWIDTH\b/g, String(W))
		.replace(/\bHEIGHT\b/g, String(H))
		.replace(/\bEWIDTH\b/g, String(EW))
		.replace(/\bEHEIGHT\b/g, String(EH))
		.replace(/\bCOLS\b/g, String(GRID_COLS))
		.replace(/\bROWS\b/g, String(GRID_ROWS))
		.replace(/\bPIXEL_THRESHOLD\b/g, String(PIXEL_THRESHOLD))
		.replace(/\bEDGE_FLOOR\b/g, String(EDGE_FLOOR))
		.replace(/\bEDGE_THRESHOLD\b/g, String(EDGE_THRESHOLD))
		// Function replacements: `$&` and friends in a string replacement are substitution
		// patterns, and these values are not ours to trust that way.
		.replace("IMAGE_A", () => JSON.stringify(aDataUri))
		.replace("IMAGE_B", () => JSON.stringify(bDataUri));

	return `<!doctype html><meta charset="utf-8"><title>compare</title><body><script>${script}</script></body>`;
}

async function dataUri(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if (file.size === 0) return null;
	const bytes = new Uint8Array(await file.arrayBuffer());
	return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function clamp01(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
	return Math.min(1, Math.max(0, n));
}

/**
 * Compare a rebuild against the real page. `reference` is the screenshot of the site,
 * `candidate` the screenshot of what we built; both are PNG paths.
 *
 * The weighting is a judgement, stated once here rather than scattered: getting the layout
 * right matters nearly as much as getting the pixels right, and having the right palette
 * in the wrong places is worth something but not much.
 */
export async function compareShots(reference: string, candidate: string): Promise<Comparison> {
	const empty: Comparison = { ok: false, score: 0, pixel: 0, layout: 0, palette: 0, regions: [] };
	const [a, b] = await Promise.all([dataUri(reference), dataUri(candidate)]);
	if (!a || !b) return { ...empty, reject: "one of the two screenshots is missing" };

	const run = await runPage(measurePage(a, b), { offline: true, timeoutMs: 60_000 });
	if (!run.ok) return { ...empty, reject: run.reject };

	let parsed: {
		ok?: boolean;
		error?: string;
		pixel?: number;
		layout?: number;
		palette?: number;
		regions?: Array<{ col: number; row: number; diff: number }>;
	};
	try {
		parsed = JSON.parse(run.output);
	} catch {
		return { ...empty, reject: "the comparison did not come back as JSON" };
	}
	if (!parsed.ok) return { ...empty, reject: parsed.error ?? "the comparison failed" };

	const pixel = clamp01(parsed.pixel);
	const layout = clamp01(parsed.layout);
	const palette = clamp01(parsed.palette);
	const regions = (parsed.regions ?? [])
		.map((r) => ({ where: regionName(r.col, r.row), diff: clamp01(r.diff) }))
		.sort((x, y) => y.diff - x.diff)
		.slice(0, 4);

	return {
		ok: true,
		score: pixel * 0.45 + layout * 0.35 + palette * 0.2,
		pixel,
		layout,
		palette,
		regions,
	};
}

/** The comparison as a sentence the next round can act on. */
export function describeComparison(c: Comparison): string {
	if (!c.ok) return c.reject ?? "the two renders could not be compared";
	const parts = [
		`overall ${pct(c.score)} match`,
		`pixels ${pct(c.pixel)}`,
		`layout ${pct(c.layout)}`,
		`palette ${pct(c.palette)}`,
	];
	const worst = c.regions.filter((r) => r.diff > 0.08);
	const where = worst.length
		? ` Furthest off: ${worst.map((r) => `${r.where} (${pct(r.diff)} different)`).join(", ")}.`
		: "";
	return `${parts.join(", ")}.${where}`;
}

export function pct(value: number): string {
	return `${Math.round(value * 100)}%`;
}
