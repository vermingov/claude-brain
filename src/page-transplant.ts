// A rebuild made of the page itself.
//
// A model writing a page from measurements can get close. It cannot get it exactly right,
// and "exactly" is the point: the same fonts in the same cut, the same cascade, the same
// eleven media queries, the same keyframes on the same elements. All of that already exists,
// in the page, in a form a browser has finished computing. So the rebuild is taken rather
// than written: the rendered DOM, and every CSS rule that applies to it, as the browser that
// rendered it decided.
//
// What that takes, for any site rather than one:
//
//   the DOM          after the framework has run, with open shadow roots serialised as
//                    declarative ones and their adopted sheets inlined. Scripts, iframes,
//                    event handlers and preload hints go; everything that draws stays.
//   the rules        every sheet the document uses — linked, inline, inserted through the
//                    CSSOM by CSS-in-JS, adopted — and the cross-origin ones a page cannot
//                    read are fetched and parsed here instead. A rule is kept when its
//                    selector matches something, with states and pseudo-elements stripped
//                    for the test, and kept inside whatever @media, @supports, @container or
//                    @layer held it. At-rules that are global — keyframes, @property, layer
//                    order — are kept whole.
//   rules for later  a class a script adds after load (an "is-open", an "animate" on scroll)
//                    matches nothing when the page is read. Those rules are kept when every
//                    class they need is either in the document already or named in the
//                    page's own JavaScript, which is where the script that adds it lives.
//   the resources    every image, poster, background and font the kept DOM and rules point
//                    at, downloaded through the same guard as every other fetch and rewritten
//                    to local paths. Links point back at the original site.
//
// What it cannot take is behaviour. Scripts are gone, so a menu will not open and a carousel
// will not turn; the WebGL scene is replaced by this package's replay engine, and classes a
// page toggles on visibility are handed to that runtime by data attribute.

import { type StoredAsset, collectFonts } from "./design-assets";
import type { Page } from "./cdp";
import { type PageResources, pageResources } from "./page-resources";
import { type FetchLimits, guardedFetch } from "./url-guard";

const MAX_SHEET_BYTES = 4 * 1024 * 1024;
const SHEET_LIMITS: FetchLimits = { maxBytes: MAX_SHEET_BYTES, timeoutMs: 15_000, stallMs: 8_000, accept: ["text/css", "text/plain", "application/octet-stream"] };
/** Sheets a page loads from a CDN it cannot read: counted, but bounded by bytes. */
const MAX_CROSS_ORIGIN_SHEETS = 150;
const MAX_CROSS_ORIGIN_BYTES = 16 * 1024 * 1024;

export interface TransplantRule {
	/** The rule's text, already wrapped in the grouping rules that held it. */
	css: string;
	/** The sheet it came from, for resolving its url()s. Empty for inline styles. */
	href: string;
	/** Whether its selector matched something when the page was read. */
	matched: boolean;
	/** The class names its selector needs, for the rules that matched nothing yet. */
	classes: string[];
}

export interface TransplantCapture {
	ok: boolean;
	note: string;
	url: string;
	title: string;
	htmlAttributes: Array<[string, string]>;
	bodyAttributes: Array<[string, string]>;
	/** The body's content, serialised with open shadow roots. */
	body: string;
	rules: TransplantRule[];
	/** Keyframes, @property, @font-face, layer order: kept whatever matched. */
	globals: Array<{ css: string; href: string }>;
	/** Sheets the page itself was not allowed to read. */
	unreadable: string[];
	/** Every class name in the document, so a rule for a later class can be judged. */
	classes: string[];
	icon: string;
}

/**
 * In-page: a stylesheet's source text as an index of its rules, so a rule can be written out the
 * way the sheet wrote it rather than the way this engine serialises it back.
 *
 * The CSSOM loses things on the way back to text. A shorthand holding var() whose longhand is
 * then set on its own — `padding: var(--s) var(--s) 0; padding-bottom: 0` — comes back as
 * `padding-top: ; padding-right: ; padding-left: ;`, and the padding is gone. Properties and values
 * this engine does not support, which the browser viewing the rebuild may, are not there at all.
 *
 * Rules are keyed by the grouping rules around them and their prelude, both with whitespace,
 * quotes and case taken out, since the CSSOM normalises those; a key seen twice is told apart by
 * order. Only rules at the top level or inside at-rules are indexed: a nested rule stays inside
 * the text of the rule that holds it.
 */
export const SOURCE_RULES = String.raw`
const ruleKey = (context, prelude) =>
	[...context, prelude].map((part) => part.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "").replace(/["']/g, "").replace(/::/g, ":").toLowerCase()).join("\u0001");
const sourceRules = (text) => {
	const index = new Map();
	let i = 0;
	const list = (context) => {
		let start = i;
		let depth = 0;
		while (i < text.length) {
			const c = text[i];
			if (c === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				i = end < 0 ? text.length : end + 2;
				continue;
			}
			if (c === '"' || c === "'") {
				for (i++; i < text.length && text[i] !== c; i += text[i] === "\\" ? 2 : 1);
				i++;
				continue;
			}
			if (c === "\\") { i += 2; continue; }
			if (c === "(" || c === "[") depth++;
			else if ((c === ")" || c === "]") && depth > 0) depth--;
			else if (depth === 0 && c === ";") start = i + 1;
			else if (depth === 0 && c === "}") return;
			else if (depth === 0 && c === "{") {
				const prelude = text.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").trim();
				const open = i++;
				list(context && prelude.startsWith("@") ? context.concat(prelude) : null);
				if (context && prelude) {
					const key = ruleKey(context, prelude);
					const whole = prelude + " " + text.slice(open, i + 1);
					if (index.has(key)) index.get(key).push(whole);
					else index.set(key, [whole]);
				}
				i++;
				start = i;
				continue;
			}
			i++;
		}
	};
	list([]);
	return index;
};
`;

/**
 * Read the page. `extraSheets` are cross-origin sheets fetched on this side, passed back in as
 * text so the browser can parse and match them like any other.
 */
export function transplantScript(extraSheets: Array<{ href: string; text: string }> = []): string {
	return String.raw`(async () => {
	const EXTRA = ${JSON.stringify(extraSheets)};
	const out = { ok: false, note: "", url: location.href, title: document.title, htmlAttributes: [], bodyAttributes: [], body: "", rules: [], globals: [], unreadable: [], classes: [], icon: "" };
	if (!document.body) { out.note = "the page has no body"; return out; }

	// ---- selectors: split, stripped of states, tested --------------------------------------
	const splitTop = (text) => {
		const parts = [];
		let depth = 0, quote = "", start = 0;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
			if (c === '"' || c === "'") quote = c;
			else if (c === "(" || c === "[") depth++;
			else if (c === ")" || c === "]") depth--;
			else if (c === "," && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
		}
		parts.push(text.slice(start).trim());
		return parts.filter(Boolean);
	};
	const STATE = /::?(?:-[a-z]+-)?[a-z-]+(?:\((?:[^()]|\([^()]*\))*\))?/gi;
	const KEEP_PSEUDO = /^:(?:not|is|where|has|nth-child|nth-last-child|nth-of-type|nth-last-of-type|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|root|empty|scope|lang|dir)\b/i;
	const testable = (selector) => selector.replace(STATE, (m) => (KEEP_PSEUDO.test(m) ? m : "")).replace(/\s+([>+~])?\s*$/, "").trim() || "*";
	const matches = (selector) => {
		try { return !!document.querySelector(testable(selector)); } catch (e) { return true; }
	};
	const classesOf = (selector) => {
		const found = [];
		for (const m of selector.matchAll(/\.((?:\\.|[\w-])+)/g)) found.push(m[1].replace(/\\(.)/g, "$1"));
		return found;
	};

	// ---- rules ----------------------------------------------------------------------------
	${SOURCE_RULES}
	// Each sheet's own text, indexed. A linked sheet is fetched again, from the cache as a rule; an
	// inline one is its element's text; one built from script has no text, and its rules are
	// written as the CSSOM serialises them.
	const sourceOf = async (sheet, href) => {
		try {
			if (sheet.ownerNode && sheet.ownerNode.tagName === "STYLE") return sourceRules(sheet.ownerNode.textContent || "");
			if (!href) return null;
			const response = await fetch(href, { credentials: "same-origin", cache: "force-cache" });
			return response.ok ? sourceRules(await response.text()) : null;
		} catch (e) {
			return null;
		}
	};
	// The k-th rule with this key in the source, for the k-th one the CSSOM has.
	const written = (source, seen, context, prelude, fallback) => {
		if (!source) return fallback;
		const key = ruleKey(context, prelude);
		const k = seen.get(key) || 0;
		seen.set(key, k + 1);
		const list = source.get(key);
		return list && list[k] ? list[k] : fallback;
	};
	const GLOBAL = /^@(keyframes|-webkit-keyframes|property|font-face|counter-style|font-feature-values|font-palette-values|page|namespace)\b/i;
	const walk = async (rules, href, wrap, source, seen, context) => {
		for (const rule of Array.from(rules)) {
			const text = rule.cssText;
			if (rule instanceof CSSStyleRule) {
				const parts = splitTop(rule.selectorText || "");
				const matched = parts.some(matches);
				const classes = matched ? [] : Array.from(new Set(parts.flatMap(classesOf)));
				out.rules.push({ css: wrap(written(source, seen, context, rule.selectorText || "", text)), href, matched, classes });
			} else if (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule) {
				let inner = null;
				try { inner = rule.styleSheet && rule.styleSheet.cssRules; } catch (e) { inner = null; }
				const innerHref = (rule.styleSheet && rule.styleSheet.href) || href;
				if (inner) await walk(inner, innerHref, wrap, await sourceOf(rule.styleSheet, innerHref), new Map(), []);
				else if (rule.href) out.unreadable.push(new URL(rule.href, href || location.href).href);
			} else if (GLOBAL.test(text)) {
				out.globals.push({ css: written(source, seen, context, text.slice(0, text.indexOf("{")).trim() || text.replace(/;\s*$/, ""), text), href });
			} else if (rule.cssRules) {
				// @media, @supports, @container, @layer, @scope, @starting-style: whatever the
				// grouping, its prelude is everything before the first brace.
				const prelude = text.slice(0, text.indexOf("{")).trim();
				await walk(rule.cssRules, href, (inner) => wrap(prelude + " { " + inner + " }"), source, seen, context.concat(prelude));
			} else if (/^@layer\b/i.test(text)) {
				out.globals.push({ css: text, href });
			}
		}
	};
	const sheets = [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets || [])];
	for (const sheet of sheets) {
		let rules = null;
		try { rules = sheet.cssRules; } catch (e) { rules = null; }
		if (rules) await walk(rules, sheet.href || "", (t) => t, await sourceOf(sheet, sheet.href || ""), new Map(), []);
		else if (sheet.href) out.unreadable.push(sheet.href);
	}
	for (const extra of EXTRA) {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(extra.text);
			await walk(sheet.cssRules, extra.href, (t) => t, sourceRules(extra.text), new Map(), []);
		} catch (e) { /* a sheet this engine will not parse */ }
	}

	// ---- the DOM ---------------------------------------------------------------------------
	// Adopted sheets inside open shadow roots do not serialise; put them in as <style>.
	const shadowRoots = [];
	const findRoots = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) {
				shadowRoots.push(el.shadowRoot);
				const adopted = el.shadowRoot.adoptedStyleSheets || [];
				if (adopted.length && !el.shadowRoot.querySelector(":scope > style[data-brain-adopted]")) {
					const style = document.createElement("style");
					style.setAttribute("data-brain-adopted", "");
					style.textContent = adopted.map((s) => Array.from(s.cssRules).map((r) => r.cssText).join("\n")).join("\n");
					el.shadowRoot.prepend(style);
				}
				findRoots(el.shadowRoot);
			}
		}
	};
	findRoots(document);

	// Canvases are numbered in document order, so a scene ripped in another visit can be matched
	// to its element, and marked when they fill their container — the case where a renderer
	// sizes the canvas to its parent and the rebuild should let CSS do the same.
	Array.from(document.querySelectorAll("canvas")).forEach((canvas, index) => {
		canvas.setAttribute("data-brain-canvas", String(index));
		const box = canvas.getBoundingClientRect();
		const parent = canvas.parentElement && canvas.parentElement.getBoundingClientRect();
		if (parent && Math.abs(box.width - parent.width) < 1 && Math.abs(box.height - parent.height) < 1) canvas.setAttribute("data-brain-fills", "");
	});

	const absolute = (value) => { try { return new URL(value, location.href).href; } catch (e) { return value; } };
	// Serialised from the live body, shadow roots and all, then cleaned as a fragment: scripts,
	// frames and handlers out, links made absolute. Shadow templates are cleaned too, but keep
	// their own <style>, which is the only thing styling what is inside them.
	const REMOVE = "script, noscript, iframe, object, embed, link[rel=preload], link[rel=prefetch], link[rel=modulepreload], link[rel=stylesheet]";
	const clean = (root, inShadow) => {
		for (const node of Array.from(root.querySelectorAll(inShadow ? REMOVE : REMOVE + ", style"))) node.remove();
		for (const node of Array.from(root.querySelectorAll("*"))) {
			for (const attr of Array.from(node.attributes || [])) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
			const href = node.getAttribute("href");
			if (href && /^javascript:/i.test(href)) node.removeAttribute("href");
			else if (node.tagName === "A" && href && !href.startsWith("#")) node.setAttribute("href", absolute(href));
			if (node.tagName === "TEMPLATE") clean(node.content, inShadow || node.hasAttribute("shadowrootmode"));
		}
	};
	const serialised = document.body.getHTML
		? document.body.getHTML({ serializableShadowRoots: true, shadowRoots })
		: document.body.innerHTML;
	// The behaviour recorder numbers the DOM at this instant, so its first change and this
	// serialisation share a baseline.
	if (window.__domRecorder && !window.__domRecorder.on) window.__domRecorder.start();
	const template = document.createElement("template");
	template.innerHTML = serialised;
	clean(template.content, false);
	out.body = template.innerHTML;
	out.htmlAttributes = Array.from(document.documentElement.attributes).map((a) => [a.name, a.value]);
	out.bodyAttributes = Array.from(document.body.attributes).filter((a) => !/^on/i.test(a.name)).map((a) => [a.name, a.value]);
	const classes = new Set();
	for (const el of document.querySelectorAll("[class]")) for (const c of el.classList) classes.add(c);
	for (const root of shadowRoots) for (const el of root.querySelectorAll("[class]")) for (const c of el.classList) classes.add(c);
	out.classes = Array.from(classes);
	const icon = document.querySelector("link[rel~=icon]");
	out.icon = icon ? absolute(icon.getAttribute("href")) : "";
	out.unreadable = Array.from(new Set(out.unreadable));
	out.ok = true;
	return out;
})()`;
}

/** In-page: the addresses of every script the page loaded. */
export const SCRIPT_URLS = `Array.from(new Set([...performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\.m?js(\\?|$)/.test(n)), ...Array.from(document.scripts).map((s) => s.src).filter(Boolean)]))`;
/** In-page: the text of every inline script, bounded. */
export const INLINE_SCRIPTS = `Array.from(document.scripts).filter((s) => !s.src).map((s) => s.textContent).join("\\n").slice(0, 4000000)`;

const SCRIPT_LIMITS: FetchLimits = { maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000, stallMs: 8_000, accept: ["javascript", "ecmascript", "text/", "application/octet-stream"] };
const MAX_SCRIPTS = 80;

/** All of a page's JavaScript as one text: where the classes it adds later are named. */
export async function pageScriptText(page: Page): Promise<string> {
	const urls = (await page.evaluate<string[]>(SCRIPT_URLS)) ?? [];
	const parts = [(await page.evaluate<string>(INLINE_SCRIPTS)) ?? ""];
	for (const url of urls.slice(0, MAX_SCRIPTS)) {
		const res = await guardedFetch(url, SCRIPT_LIMITS);
		if (!("reject" in res)) parts.push(new TextDecoder().decode(res.bytes));
	}
	return parts.join("\n");
}

/**
 * Read the page twice if it has to: once to learn which sheets it could not read, and again
 * with those sheets fetched here and handed back in.
 */
export async function captureTransplant(page: Page): Promise<TransplantCapture | null> {
	await domSettled(page);
	const first = await page.evaluate<TransplantCapture>(transplantScript(), 120_000);
	if (!first?.ok || first.unreadable.length === 0) return first;
	const extra: Array<{ href: string; text: string }> = [];
	let budget = MAX_CROSS_ORIGIN_BYTES;
	for (const href of first.unreadable.slice(0, MAX_CROSS_ORIGIN_SHEETS)) {
		if (budget <= 0) break;
		const res = await guardedFetch(href, SHEET_LIMITS);
		if ("reject" in res) continue;
		budget -= res.bytes.length;
		extra.push({ href, text: absoluteUrls(new TextDecoder().decode(res.bytes), href) });
	}
	if (extra.length === 0) return first;
	const second = await page.evaluate<TransplantCapture>(transplantScript(extra), 180_000);
	if (!second?.ok) return first;
	// The second read is for the rules alone. The document is the first read's: that is the
	// instant the behaviour recorder numbered, and the page has moved on since.
	const fetched = new Set(extra.map((e) => e.href));
	return { ...first, rules: second.rules, globals: second.globals, unreadable: second.unreadable.filter((href) => !fetched.has(href)) };
}

/**
 * Wait until the document stops growing. The network going quiet is not the same thing: a page
 * that streams its sections in, or hydrates a skeleton into content, is still changing, and a
 * transplant taken then is a copy of the skeleton — seen on raycast.com as 20 KB of body where
 * the settled page has 520.
 */
async function domSettled(page: Page, timeoutMs = 12_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = -1;
	let stableSince = Date.now();
	while (Date.now() < deadline) {
		const size = (await page.evaluate<number>("document.body ? document.body.getElementsByTagName('*').length : 0")) ?? 0;
		if (size !== last) {
			last = size;
			stableSince = Date.now();
		} else if (Date.now() - stableSince >= 1_200) {
			return;
		}
		await Bun.sleep(200);
	}
}

/**
 * Put the replay engine's canvas where the ripped scene's canvas was. The page's own attributes
 * go — its buffer size and its engine's markers belong to a renderer that is not coming — except
 * the class, which the page's CSS positions it by. A canvas that filled its container is sized
 * to fill it again; one that did not keeps the size its renderer gave it.
 */
export function withHeroCanvas(body: string, index: number): string {
	return body.replace(/<canvas\b([^>]*)>\s*<\/canvas>/gi, (whole, attrs: string) => {
		const number = /\sdata-brain-canvas="(\d+)"/.exec(attrs)?.[1];
		if (Number(number) !== index) return whole.replace(/\sdata-brain-(canvas|fills)(="[^"]*")?/g, "");
		const cls = /\sclass="([^"]*)"/.exec(attrs)?.[1];
		const style = /\sdata-brain-fills/.test(attrs)
			? "display: block; width: 100%; height: 100%;"
			: (/\sstyle="([^"]*)"/.exec(attrs)?.[1] ?? "display: block;");
		return `<canvas data-hero-scene${cls ? ` class="${cls}"` : ""} style="${style}"></canvas>`;
	});
}

/** url() relative to a sheet, made absolute, so the text means the same thing anywhere. */
export function absoluteUrls(css: string, base: string): string {
	return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote: string, raw: string) => {
		if (/^(data:|#)/i.test(raw)) return whole;
		try {
			return `url(${quote}${new URL(raw, base).href}${quote})`;
		} catch {
			return whole;
		}
	});
}

/**
 * Which rules to keep. Matched ones, always. Unmatched ones when every class they need is in
 * the document or named in the page's own scripts — the rule for a state a script will add.
 */
export function keptRules(capture: TransplantCapture, scriptTokens: Set<string>): TransplantRule[] {
	const inDocument = new Set(capture.classes);
	return capture.rules.filter((rule) => {
		if (rule.matched) return true;
		if (rule.classes.length === 0) return false;
		return rule.classes.every((name) => inDocument.has(name) || scriptTokens.has(name));
	});
}

/**
 * The words a page's scripts contain, for asking whether one of them names a class. A set,
 * because the question is asked thousands of times against megabytes of bundle. Split on the
 * characters that end a string or an expression, not on the ones utility classes are made of
 * (md:flex, w-1/2, data-[state=open]:block).
 */
export function scriptTokens(scriptText: string): Set<string> {
	return new Set(scriptText.split(/[\s"'`,;(){}<>]+/).filter((t) => t.length > 1 && t.length < 120));
}

export interface TransplantOptions {
	/** The page's JavaScript, concatenated: where classes added later are named. */
	scriptText: string;
	/** Markup to put before </body> — the hero runtime tag. */
	tail?: string;
	/** Rewrite the ripped canvas; given the body, returns it. */
	transformBody?: (body: string) => string;
}

export interface Transplanted {
	html: string;
	/** What the document and its rules pointed at, local now; the tapes go through the same. */
	resources: PageResources;
	fonts: StoredAsset[];
	rules: number;
}

/** The rebuild document: the page's DOM and kept rules, its resources local. */
export async function assembleTransplant(capture: TransplantCapture, options: TransplantOptions): Promise<Transplanted> {
	const rules = keptRules(capture, scriptTokens(options.scriptText));
	const fontSource = capture.globals
		.filter((g) => /^@font-face/i.test(g.css))
		.map((g) => `/* --- ${g.href || capture.url} --- */\n${g.css}`)
		.join("\n");
	const fonts = await collectFonts(fontSource);
	const globals = capture.globals.filter((g) => !/^@font-face/i.test(g.css)).map((g) => absoluteUrls(g.css, g.href || capture.url));
	let css = [...globals, ...rules.map((r) => absoluteUrls(r.css, r.href || capture.url))].join("\n");
	let body = options.transformBody ? options.transformBody(capture.body) : capture.body;

	// Every remote resource the document or its rules point at, fetched once and rewritten.
	const resources = pageResources(capture.url);
	resources.noteMarkup(body);
	resources.noteCss(css);
	if (capture.icon) resources.noteAttribute("src", capture.icon);
	await resources.download();
	body = resources.markup(body);
	css = resources.css(css);
	const icon = capture.icon ? resources.localOf(capture.icon) : undefined;

	const attrs = (list: Array<[string, string]>) => list.map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
	const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const html = [
		"<!DOCTYPE html>",
		`<html${attrs(capture.htmlAttributes)}>`,
		"<head>",
		'<meta charset="utf-8">',
		`<title>${escapeText(capture.title)}</title>`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		icon ? `<link rel="icon" href="${icon}">` : "",
		"<style>",
		fonts.css,
		css.replace(/<\/style/gi, "<\\/style"),
		"</style>",
		"</head>",
	]
		.filter((line) => line !== "")
		.join("\n")
		// Nothing between the tags and the content, and nothing after: whitespace inside <body>,
		// or after </body> or </html>, is parsed into the body as a text node, and a text node the
		// page never had shifts the numbering the behaviour recorder relies on.
		.concat(`\n<body${attrs(capture.bodyAttributes)}>${body}${options.tail ?? ""}</body></html>`);
	return { html, resources, fonts: fonts.files, rules: rules.length };
}
