// Every URL a rebuild carries, fetched once and made local.
//
// A transplanted page points at its resources the way the page did: relative to its own origin
// ("/_next/static/…"), through an image optimiser ("/_next/image?url=…&w=64"), as srcset
// candidates, inside style attributes whose quotes are written &quot;. Served from anywhere else,
// every one of those is a 404. The document, its rules and its behaviour tapes all carry them, so
// all three go through here: each URL is resolved against the page, downloaded through the guard,
// and rewritten to the local copy. One that cannot be downloaded — over the budget, refused by the
// guard — is rewritten to its absolute address on the original site, which still loads.

import { type StoredAsset, storeFetchedAsset } from "./design-assets";

/** A whole page's imagery, tapes included, which is more than a prompt's manifest ever needed. */
const MAX_ASSETS = 600;
const MAX_BYTES = 120 * 1024 * 1024;
const CONCURRENCY = 6;

/** Attributes whose whole value is one resource. `href` is left alone: it is where a link goes. */
const SINGLE = /^(src|poster|xlink:href|data|background)$/i;
const SRCSET = /^(srcset|imagesrcset)$/i;

const MARKUP_SINGLE = /(\s(?:src|poster|xlink:href)=")([^"]*)(")/gi;
const MARKUP_SRCSET = /(\s(?:srcset|imagesrcset)=")([^"]*)(")/gi;
const MARKUP_STYLE_ATTRIBUTE = /(\sstyle=")([^"]*)(")/gi;
const MARKUP_STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
/** url() with its quote, which in markup may be the entity. Lazy, so a data: URI's parentheses survive when quoted. */
const CSS_URL = /url\(\s*(&quot;|["']|)(.+?)\1\s*\)/g;

const decodeEntities = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const encodeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** srcset candidates as the HTML spec reads them: a URL, then descriptors up to the comma. */
export function srcsetCandidates(value: string): Array<{ url: string; descriptors: string }> {
	const out: Array<{ url: string; descriptors: string }> = [];
	let i = 0;
	while (i < value.length) {
		while (i < value.length && /[\s,]/.test(value[i]!)) i++;
		let end = i;
		while (end < value.length && !/\s/.test(value[end]!)) end++;
		let url = value.slice(i, end);
		let descriptors = "";
		if (url.endsWith(",")) {
			url = url.replace(/,+$/, "");
		} else {
			let comma = end;
			while (comma < value.length && value[comma] !== ",") comma++;
			descriptors = value.slice(end, comma).trim();
			end = comma;
		}
		if (url) out.push({ url, descriptors });
		i = end + 1;
	}
	return out;
}

export interface PageResources {
	/** Note the URLs in markup, a stylesheet, or one attribute's value; nothing is fetched yet. */
	noteMarkup(markup: string): void;
	noteCss(css: string): void;
	noteAttribute(name: string, value: string): void;
	/** Fetch everything noted and not yet fetched, within the budget. */
	download(): Promise<void>;
	/** The same text with every resource URL local, or absolute where it could not be fetched. */
	markup(markup: string): string;
	css(css: string): string;
	attribute(name: string, value: string): string;
	/** The local copy of one URL as the page wrote it, if there is one. */
	localOf(raw: string): string | undefined;
	assets: StoredAsset[];
}

export function pageResources(pageUrl: string): PageResources {
	const wanted = new Set<string>();
	const local = new Map<string, string>();
	const tried = new Set<string>();
	const assets: StoredAsset[] = [];
	let budget = MAX_BYTES;

	/** The absolute http(s) address a raw URL means, or null for data:, fragments and the like. */
	const resolve = (raw: string): string | null => {
		const value = raw.trim();
		if (!value || /^(data:|#|blob:|about:|javascript:|mailto:|tel:)/i.test(value)) return null;
		try {
			const url = new URL(value, pageUrl);
			return /^https?:$/.test(url.protocol) ? url.href : null;
		} catch {
			return null;
		}
	};
	const rewrite = (raw: string): string => {
		const absolute = resolve(raw);
		return absolute ? (local.get(absolute) ?? absolute) : raw;
	};

	// Each walker takes a visitor over the raw URLs in its kind of text and returns the text with
	// the visitor's replacements, so noting and rewriting read the same places.
	const inCss = (css: string, visit: (raw: string) => string, escaped: boolean) =>
		css.replace(CSS_URL, (whole, quote: string, raw: string) => {
			const decoded = escaped ? decodeEntities(raw) : raw;
			const next = visit(decoded);
			if (next === decoded) return whole;
			return `url(${quote}${escaped ? encodeAttribute(next) : next}${quote})`;
		});
	const inSrcset = (value: string, visit: (raw: string) => string) =>
		srcsetCandidates(value)
			.map((c) => [visit(c.url), c.descriptors].filter(Boolean).join(" "))
			.join(", ");
	const inMarkup = (markup: string, visit: (raw: string) => string) =>
		markup
			.replace(MARKUP_SINGLE, (_whole, open: string, value: string, close: string) => open + encodeAttribute(visit(decodeEntities(value))) + close)
			.replace(MARKUP_SRCSET, (_whole, open: string, value: string, close: string) => open + encodeAttribute(inSrcset(decodeEntities(value), visit)) + close)
			.replace(MARKUP_STYLE_ATTRIBUTE, (_whole, open: string, value: string, close: string) => open + inCss(value, visit, true) + close)
			.replace(MARKUP_STYLE_ELEMENT, (_whole, open: string, css: string, close: string) => open + inCss(css, visit, false) + close);
	const inAttribute = (name: string, value: string, visit: (raw: string) => string) => {
		if (SINGLE.test(name)) return visit(value);
		if (SRCSET.test(name)) return inSrcset(value, visit);
		if (/^style$/i.test(name)) return inCss(value, visit, false);
		return value;
	};

	const note = (raw: string) => {
		const absolute = resolve(raw);
		if (absolute && !tried.has(absolute)) wanted.add(absolute);
		return raw;
	};

	return {
		noteMarkup: (markup) => void inMarkup(markup, note),
		noteCss: (css) => void inCss(css, note, false),
		noteAttribute: (name, value) => void inAttribute(name, value, note),
		async download() {
			const queue = [...wanted].filter((url) => !tried.has(url));
			wanted.clear();
			for (const url of queue) tried.add(url);
			const worker = async () => {
				for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
					if (assets.length >= MAX_ASSETS || budget <= 0) return;
					const stored = await storeFetchedAsset(url);
					if (!stored) continue;
					budget -= stored.bytes;
					assets.push(stored);
					local.set(url, stored.href);
				}
			};
			await Promise.all(Array.from({ length: CONCURRENCY }, worker));
		},
		markup: (markup) => inMarkup(markup, rewrite),
		css: (css) => inCss(css, rewrite, false),
		attribute: (name, value) => inAttribute(name, value, rewrite),
		localOf: (raw) => {
			const absolute = resolve(raw);
			return absolute ? local.get(absolute) : undefined;
		},
		assets,
	};
}
