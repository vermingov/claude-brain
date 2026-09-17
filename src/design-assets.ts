// The pictures, the video, the logo — the parts of a design that are not text.
//
// A rebuild that draws grey rectangles where the product shots were is not a rebuild of
// that page; it is a wireframe of it. And a design library that remembers "the accent is
// #ff6363, the type is Inter" but has none of the site's own imagery has forgotten the
// half of the design that people actually respond to.
//
// So the assets the page draws come down with everything else: through the same guard as
// every other fetch, into a content-addressed folder beside the rebuild, and into the
// rebuild's markup under a relative path that works in two places at once — the local
// render, where the file sits next to the HTML, and the dashboard, which serves the same
// relative path back.
//
// Bounded hard, because this is the one part of a capture that downloads things a page
// chose: a count, a per-file ceiling, and a total. A site whose hero is a 200 MB video
// gets its poster frame and a note saying so.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RECREATE_DIR } from "./design-store";
import { sniffMime } from "./image-meta";
import { type FetchLimits, guardedFetch } from "./url-guard";

/** Shared across designs on purpose: the same logo cited twice is one file. */
export const ASSET_DIR = join(RECREATE_DIR, "assets");
/** What the rebuild writes in its markup. Relative, so file:// and the dashboard agree. */
export const ASSET_HREF = "assets";

const MAX_ASSETS = 18;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 28 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;

/** Type is the design, so the page's own faces come down too — a handful of small files. */
const MAX_FONTS = 32;
const MAX_FONT_BYTES = 1024 * 1024;
const FONT_LIMITS: FetchLimits = {
	maxBytes: MAX_FONT_BYTES,
	timeoutMs: 15_000,
	stallMs: 8_000,
	accept: ["font/", "application/font", "application/x-font", "application/octet-stream", "binary/octet-stream"],
};

const IMAGE_LIMITS: FetchLimits = {
	maxBytes: MAX_IMAGE_BYTES,
	timeoutMs: 15_000,
	stallMs: 8_000,
	accept: ["image/"],
};
const VIDEO_LIMITS: FetchLimits = {
	maxBytes: MAX_VIDEO_BYTES,
	timeoutMs: 30_000,
	stallMs: 10_000,
	accept: ["video/", "application/octet-stream"],
};

/** What the page said about an asset before we went and got it. */
export interface AssetRef {
	url: string;
	kind: string;
	role: string;
	width: number;
	height: number;
	alt: string;
}

export interface StoredAsset {
	/** The path the rebuild writes: `assets/<hash>.<ext>`. */
	href: string;
	file: string;
	kind: "image" | "video" | "font";
	role: string;
	width: number;
	height: number;
	alt: string;
	bytes: number;
	from: string;
}

const EXTENSION: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"video/mp4": "mp4",
	"video/webm": "webm",
};

/**
 * SVG is served back to a browser from the dashboard's own origin, and an SVG is a
 * document that can carry script. It is kept — it is most of the world's iconography — but
 * only after the parts that execute are taken out of it. The dashboard also sends it with
 * a sandbox policy; this is the copy that ends up in the user's own files.
 */
export function sanitizeSvg(bytes: Uint8Array): Uint8Array {
	const text = new TextDecoder().decode(bytes);
	const cleaned = text
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
		.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
		.replace(/javascript:/gi, "blocked:");
	return new TextEncoder().encode(cleaned);
}

function extensionFor(bytes: Uint8Array, contentType: string, url: string): string | null {
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (magic === "wOF2") return "woff2";
	if (magic === "wOFF") return "woff";
	const sniffed = sniffMime(bytes);
	if (sniffed) return EXTENSION[sniffed] ?? null;
	const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (EXTENSION[declared]) return EXTENSION[declared]!;
	// SVG has no magic bytes worth trusting, and a video's box header is not worth a
	// parser here — fall back to what the URL claims, from a closed list.
	const guess = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(url)?.[1]?.toLowerCase() ?? "";
	return ["png", "jpg", "jpeg", "webp", "gif", "avif", "svg", "mp4", "webm"].includes(guess)
		? guess === "jpeg"
			? "jpg"
			: guess
		: null;
}

function hashOf(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Fetch what the page draws. Never throws, never fails a capture: an asset that will not
 * download is simply not in the manifest, and the rebuild is told to draw a filled box in
 * its place instead.
 */
export async function collectAssets(refs: AssetRef[]): Promise<StoredAsset[]> {
	if (refs.length === 0) return [];
	mkdirSync(ASSET_DIR, { recursive: true });

	// Biggest boxes first: the hero shot matters more than a 16px chevron, and the budget
	// is spent in that order.
	const ordered = [...refs]
		.sort((a, b) => b.width * b.height - a.width * a.height)
		.slice(0, MAX_ASSETS * 2);

	const stored: StoredAsset[] = [];
	let total = 0;
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const ref = ordered[cursor++];
			if (!ref) return;
			if (stored.length >= MAX_ASSETS || total >= MAX_TOTAL_BYTES) return;

			const isVideo = ref.kind === "video";
			const res = await guardedFetch(ref.url, isVideo ? VIDEO_LIMITS : IMAGE_LIMITS);
			if ("reject" in res) continue;
			// res.bytes, never res.body: decoding binary as UTF-8 is lossy and cannot be undone.
			let bytes = res.bytes;
			if (bytes.length === 0) continue;

			const ext = extensionFor(bytes, res.contentType, ref.url);
			if (!ext) continue;
			if (ext === "svg") bytes = sanitizeSvg(bytes);
			if (total + bytes.length > MAX_TOTAL_BYTES) continue;

			const file = `${hashOf(bytes)}.${ext}`;
			const path = join(ASSET_DIR, file);
			// Content-addressed, so a file already the right length is already the right file.
			if (Bun.file(path).size !== bytes.length) await Bun.write(path, bytes);
			total += bytes.length;
			stored.push({
				href: `${ASSET_HREF}/${file}`,
				file,
				kind: isVideo ? "video" : "image",
				role: ref.role,
				width: ref.width,
				height: ref.height,
				alt: ref.alt,
				bytes: bytes.length,
				from: ref.url,
			});
		}
	};
	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ordered.length) }, worker));
	return stored;
}

/**
 * Every @font-face in a captured stylesheet, with each url() resolved against the sheet it
 * came from. The capture writes one section per sheet, opened by a comment naming its URL.
 */
export function fontFaces(sourceCss: string): Array<{ text: string; sources: Array<{ written: string; absolute: string }> }> {
	const faces: Array<{ text: string; sources: Array<{ written: string; absolute: string }> }> = [];
	const sections = sourceCss.split(/\/\* --- (\S+) --- \*\//);
	let base = "";
	for (let i = 0; i < sections.length; i++) {
		if (i % 2 === 1) {
			base = sections[i]!;
			continue;
		}
		for (const rule of sections[i]!.matchAll(/@font-face\s*\{[^}]*\}/g)) {
			const sources: Array<{ written: string; absolute: string }> = [];
			for (const match of rule[0].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
				// data: fonts are already inline, and a relative URL with no sheet to anchor it
				// cannot be fetched from anywhere meaningful.
				if (match[1]!.startsWith("data:")) continue;
				try {
					sources.push({ written: match[0], absolute: new URL(match[1]!, base || undefined).href });
				} catch {
					/* unresolvable */
				}
			}
			faces.push({ text: rule[0], sources });
		}
	}
	return faces;
}

/**
 * The page's own typefaces, and the @font-face rules that point at them.
 *
 * A rebuild set in "Inter" from a font CDN is not set in the Inter the page ships: another
 * cut, other metrics, other stylistic sets, and every line of text lands a pixel or two off.
 * The captured stylesheet is one section per sheet, each opened by a comment naming the sheet's
 * URL, so every url() in a @font-face is resolved against the sheet it came from — which is
 * what makes `../media/x.woff2` mean anything at all. Only woff2 and woff are kept: both are
 * inert containers with a magic number, and that is the whole of what gets served back.
 */
export async function collectFonts(sourceCss: string): Promise<{ css: string; files: StoredAsset[] }> {
	mkdirSync(ASSET_DIR, { recursive: true });
	const files: StoredAsset[] = [];
	const byUrl = new Map<string, string>();
	const rewritten: string[] = [];
	for (const face of fontFaces(sourceCss)) {
		let text = face.text;
		for (const { written, absolute } of face.sources) {
			let href = byUrl.get(absolute);
			if (!href && files.length < MAX_FONTS) {
				const res = await guardedFetch(absolute, FONT_LIMITS);
				if ("reject" in res || res.bytes.length === 0) continue;
				const ext = extensionFor(res.bytes, "", "");
				if (ext !== "woff2" && ext !== "woff") continue;
				const file = `${hashOf(res.bytes)}.${ext}`;
				const path = join(ASSET_DIR, file);
				if (Bun.file(path).size !== res.bytes.length) await Bun.write(path, res.bytes);
				href = `${ASSET_HREF}/${file}`;
				byUrl.set(absolute, href);
				files.push({ href, file, kind: "font", role: "font", width: 0, height: 0, alt: "", bytes: res.bytes.length, from: absolute });
			}
			if (href) text = text.replace(written, `url("${href}")`);
		}
		// A face whose files would not all come down is dropped rather than left pointing at
		// someone else's server; the stack's fallbacks take over.
		if (face.sources.every((source) => byUrl.has(source.absolute))) rewritten.push(text);
	}
	return { css: rewritten.join("\n"), files };
}

/**
 * The manifest, for the prompt. Written as instructions about paths rather than as a table
 * of facts, because the one thing the model has to get exactly right is the `src` string.
 */
export function renderAssetManifest(assets: StoredAsset[]): string {
	if (assets.length === 0) {
		return "No assets could be downloaded from this page. Where an image belongs, draw a box of the right size filled with a colour or gradient taken from that part of the screenshot.";
	}
	const lines = [
		"## Assets, downloaded and sitting next to the document you are writing",
		"",
		"Reference these by the exact path given. They are real files: use them for the images,",
		"logos and video the page has, rather than drawing a placeholder. Anything not listed",
		"here has to be a filled box in the right place at the right size.",
		"",
	];
	for (const asset of assets) {
		const size = asset.width && asset.height ? ` displayed at ${asset.width}×${asset.height}` : "";
		const alt = asset.alt ? ` — “${asset.alt}”` : "";
		lines.push(`- \`${asset.href}\` (${asset.kind}, ${Math.round(asset.bytes / 1024)} KB) — ${asset.role}${size}${alt}`);
	}
	return lines.join("\n");
}

/** One resource a transplanted page points at: an image, a poster, a video, an icon. */
const RESOURCE_LIMITS: FetchLimits = {
	maxBytes: MAX_VIDEO_BYTES,
	timeoutMs: 30_000,
	stallMs: 10_000,
	accept: ["image/", "video/", "application/octet-stream", "binary/octet-stream"],
};

/**
 * Fetch one resource by URL and keep it under the same content-addressed name as everything
 * else. What the bytes are is decided by sniffing them, not by the URL: an image optimiser
 * endpoint says nothing about its format in its path.
 */
export async function storeFetchedAsset(url: string): Promise<StoredAsset | null> {
	mkdirSync(ASSET_DIR, { recursive: true });
	const res = await guardedFetch(url, RESOURCE_LIMITS);
	if ("reject" in res || res.bytes.length === 0) return null;
	const ext = extensionFor(res.bytes, res.contentType, url);
	if (!ext || ext === "woff2" || ext === "woff") return null;
	let bytes = res.bytes;
	if (ext === "svg") bytes = sanitizeSvg(bytes);
	if ((ext !== "mp4" && ext !== "webm") && bytes.length > MAX_IMAGE_BYTES) return null;
	const file = `${hashOf(bytes)}.${ext}`;
	const path = join(ASSET_DIR, file);
	if (Bun.file(path).size !== bytes.length) await Bun.write(path, bytes);
	return {
		href: `${ASSET_HREF}/${file}`,
		file,
		kind: ext === "mp4" || ext === "webm" ? "video" : "image",
		role: "",
		width: 0,
		height: 0,
		alt: "",
		bytes: bytes.length,
		from: url,
	};
}

/**
 * File bytes this package produced rather than fetched: a canvas photographed through the
 * debugging protocol, which is the only way to get the pixels of a WebGL hero into a
 * rebuild. Same folder, same naming, same manifest, so the rebuild cannot tell the
 * difference and neither does the endpoint that serves them.
 */
export async function storeAssetBytes(
	bytes: Uint8Array,
	meta: { role: string; width: number; height: number; alt?: string; from?: string },
): Promise<StoredAsset | null> {
	if (bytes.length === 0) return null;
	mkdirSync(ASSET_DIR, { recursive: true });
	const file = `${hashOf(bytes)}.png`;
	const path = join(ASSET_DIR, file);
	if (Bun.file(path).size !== bytes.length) await Bun.write(path, bytes);
	return {
		href: `${ASSET_HREF}/${file}`,
		file,
		kind: "image",
		role: meta.role,
		width: meta.width,
		height: meta.height,
		alt: meta.alt ?? "",
		bytes: bytes.length,
		from: meta.from ?? "rendered on this machine",
	};
}

/** The same, for a recording this package made of a canvas. */
export async function storeVideoBytes(
	bytes: Uint8Array,
	meta: { role: string; width: number; height: number },
): Promise<StoredAsset | null> {
	if (bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES) return null;
	mkdirSync(ASSET_DIR, { recursive: true });
	const file = `${hashOf(bytes)}.webm`;
	const path = join(ASSET_DIR, file);
	if (Bun.file(path).size !== bytes.length) await Bun.write(path, bytes);
	return {
		href: `${ASSET_HREF}/${file}`,
		file,
		kind: "video",
		role: meta.role,
		width: meta.width,
		height: meta.height,
		alt: "",
		bytes: bytes.length,
		from: "recorded on this machine",
	};
}

/** Whether a name is one of ours, for the endpoint that serves these back. */
export function validAssetFile(name: string): boolean {
	return /^[0-9a-f]{16}\.(png|jpg|webp|gif|avif|svg|mp4|webm|woff2|woff)$/.test(name);
}

export function assetPath(file: string): string {
	return join(ASSET_DIR, file);
}

export const ASSET_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
	mp4: "video/mp4",
	webm: "video/webm",
	woff2: "font/woff2",
	woff: "font/woff",
};
