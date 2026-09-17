// Reading a design off the page that is actually on screen.
//
// design-url.ts parses stylesheets, which is the best you can do from outside a browser and
// is wrong in three ways that matter: it cannot resolve the cascade (which of forty rules
// won?), it cannot resolve media queries (which of them applies at this width?), and it
// cannot see a page whose markup is assembled by JavaScript, which is most of them. What it
// produces is a plausible palette and a plausible spacing scale, ranked by heuristics.
//
// A script running inside the rendered page needs no heuristics. `getComputedStyle` returns
// the value the user is looking at, already resolved; `getBoundingClientRect` returns the
// box it actually occupies. The design is not inferred, it is read.
//
// The approach — computed styles deduplicated into a dictionary, geometry carried on the
// tree, tokens aggregated as the walk goes — follows UISnap, a Firefox extension by a
// friend of the author that does this for agents. The implementation here is its own: this
// runs through the debugging protocol with no extension installed, targets one viewport
// rather than a whole document, and is budgeted for a prompt rather than a file on disk.
//
// Two rules the script obeys, both about the thing being untrusted:
//   Every string is truncated in the page, before it is ever sent. A page controls its own
//   text, its class names and its custom property values, and therefore controls how many
//   tokens we would pay for them.
//   Nothing is executed on the way back. What returns is data, and the payload that quotes
//   it says so.

const MAX_NODES = 320;
const MAX_TEXT = 90;
const MAX_CLASSES = 3;

export interface StyleEntry {
	id: string;
	props: Record<string, string>;
	count: number;
}

export interface ColorToken {
	hex: string;
	count: number;
	roles: string[];
}

export interface TypeToken {
	family: string;
	size: string;
	weight: string;
	lineHeight: string;
	count: number;
	sample: string;
}

export interface PageSnapshot {
	url: string;
	title: string;
	lang: string;
	colorScheme: string;
	viewport: { w: number; h: number; dpr: number };
	page: { w: number; h: number };
	counts: { elements: number; shown: number; links: number; buttons: number; inputs: number; images: number };
	tree: string[];
	styles: StyleEntry[];
	tokens: {
		colors: ColorToken[];
		type: TypeToken[];
		spacing: Array<{ value: number; count: number }>;
		radii: Array<{ value: string; count: number }>;
		shadows: Array<{ value: string; count: number }>;
		borders: Array<{ value: string; count: number }>;
		fonts: string[];
		vars: Array<[string, string]>;
		breakpoints: number[];
	};
	headings: Array<{ level: number; text: string }>;
	/** Representative components, with their real markup and the real rules that style them. */
	components: Array<{ label: string; html: string; rules: string[] }>;
	/** @keyframes bodies, the ones rendered elements actually name first. */
	keyframes: string[];
	/** Which animation runs on what, so a rebuild can put the motion back where it belongs. */
	animations: Array<{ name: string; duration: string; easing: string; on: string; count: number }>;
	/** Transition and animation declarations seen on rendered elements. */
	motion: Array<{ value: string; count: number }>;
	/** Canvas and video: pixels no stylesheet can describe. The caller photographs these. */
	surfaces: Array<{ kind: string; label: string; x: number; y: number; w: number; h: number; detail: string; index: number }>;
	/** Everything the page draws that is not text: images, video, icons, backgrounds. */
	assets: Array<{ url: string; kind: string; role: string; width: number; height: number; alt: string }>;
	/** Inline SVG, which is an asset that needs no downloading — it is already here. */
	icons: Array<{ label: string; svg: string }>;
	/** The whole frontend as it ended up: the rendered DOM, and every rule that built it. */
	source: { html: string; css: string; sheets: number; rules: number };
	truncated: boolean;
}

/**
 * The capture, as an expression the browser evaluates. One function, no imports, no
 * globals left behind — it is handed to Runtime.evaluate and its value is the snapshot.
 *
 * It is written against what a page is actually allowed to be: a stylesheet may be
 * cross-origin (reading .cssRules throws), a custom element may have a shadow root, a
 * computed style may be a colour function no regex knows. Every one of those is a try/catch
 * or a fallback rather than an exception that loses the whole capture.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
	const MAX_NODES = ${MAX_NODES};
	const MAX_TEXT = ${MAX_TEXT};
	const MAX_CLASSES = ${MAX_CLASSES};

	const cut = (s, n) => (s == null ? "" : String(s).length <= n ? String(s) : String(s).slice(0, n - 1) + "…");
	const ws = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
	const round = (n, d) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };

	// --- colour -------------------------------------------------------------
	// Computed values come back as rgb()/rgba() in every engine, and as lab()/oklch()/
	// color() when the author wrote one and the engine keeps it. The canvas resolves the
	// second kind for free: assign it, read it back, get rgb.
	const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	const toHex = (value) => {
		const v = String(value || "").trim();
		if (!v || v === "none") return "";
		if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
		let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)/i.exec(v);
		if (!m && /\(/.test(v)) {
			try {
				probe.fillStyle = "#000000";
				probe.fillStyle = v;
				const resolved = probe.fillStyle;
				if (/^#[0-9a-f]{6}$/i.test(resolved)) return resolved.toLowerCase();
				m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)/i.exec(resolved);
			} catch (e) { /* a value the canvas will not take either */ }
		}
		if (!m) return "";
		const alpha = m[4] === undefined ? 1 : (String(m[4]).endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
		if (alpha === 0) return "transparent";
		return "#" + hex2(parseFloat(m[1])) + hex2(parseFloat(m[2])) + hex2(parseFloat(m[3]));
	};
	const colorsIn = (value) => {
		const out = [];
		const text = String(value || "");
		const re = /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)|(?:oklch|oklab|lab|lch|hsla?|hwb|color)\([^()]*\)/gi;
		let m;
		while ((m = re.exec(text)) !== null) {
			const hex = toHex(m[0]);
			if (hex && hex !== "transparent") out.push(hex);
			if (out.length > 4) break;
		}
		return out;
	};

	// --- which properties are worth writing down ----------------------------
	// A property earns a place only when it differs from the initial value (non-inherited)
	// or from the parent (inherited). Everything else is noise repeated on every node.
	const INITIAL = {
		position: "static", "z-index": "auto", display: "", "flex-direction": "row", "flex-wrap": "nowrap",
		"justify-content": "normal", "align-items": "normal", "align-self": "auto", "flex-grow": "0",
		"flex-shrink": "1", "flex-basis": "auto", "grid-template-columns": "none", "grid-template-rows": "none",
		"grid-auto-flow": "row", "background-color": "transparent", "background-image": "none", opacity: "1",
		"box-shadow": "none", transform: "none", "object-fit": "fill", "text-transform": "none",
		"text-decoration-line": "none", "backdrop-filter": "none", filter: "none", "mix-blend-mode": "normal",
		"aspect-ratio": "auto", overflow: "visible", "white-space": "normal", cursor: "auto",
		"text-overflow": "clip", "letter-spacing": "normal",
	};
	const INHERITED = ["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
		"text-align", "text-transform", "white-space"];

	const shorthand4 = (t, r, b, l) => (t === r && r === b && b === l) ? t : (t === b && r === l) ? t + " " + r : (r === l) ? t + " " + r + " " + b : t + " " + r + " " + b + " " + l;
	const isZero = (v) => v === "0px" || v === "0" || v === "auto" || v === "normal";
	const tidy = (v) => String(v || "").replace(/-?\d+\.\d{2,}(?=px|em|rem|%|deg|s\b)/g, (m) => String(round(parseFloat(m), 1)));

	const styleOf = (cs, parent, tag) => {
		const props = {};
		const put = (k, v) => { if (v && v !== "none" && v !== "normal") props[k] = tidy(v); };

		const display = cs.display;
		if (display !== "block" && display !== "inline") props.display = display;
		if (/flex|grid/.test(display)) {
			if (cs.flexDirection !== "row") props["flex-direction"] = cs.flexDirection;
			if (cs.flexWrap !== "nowrap") props["flex-wrap"] = cs.flexWrap;
			if (cs.justifyContent !== "normal") props["justify-content"] = cs.justifyContent;
			if (cs.alignItems !== "normal") props["align-items"] = cs.alignItems;
			const rg = cs.rowGap, cg = cs.columnGap;
			if (!isZero(rg) || !isZero(cg)) props.gap = rg === cg ? tidy(rg) : tidy(rg) + " " + tidy(cg);
			if (/grid/.test(display) && cs.gridTemplateColumns !== "none") props["grid-template-columns"] = cut(tidy(cs.gridTemplateColumns), 90);
		}
		if (cs.position !== "static") props.position = cs.position;

		const bg = toHex(cs.backgroundColor);
		if (bg && bg !== "transparent") props["background-color"] = bg;
		const bgi = cs.backgroundImage;
		if (bgi && bgi !== "none") props["background-image"] = cut(tidy(bgi), 120);

		const pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(tidy);
		if (!pad.every(isZero)) props.padding = shorthand4(pad[0], pad[1], pad[2], pad[3]);
		const mar = [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].map(tidy);
		if (!mar.every(isZero)) props.margin = shorthand4(mar[0], mar[1], mar[2], mar[3]);

		const sides = ["Top", "Right", "Bottom", "Left"].map((side) => {
			const w = cs["border" + side + "Width"], st = cs["border" + side + "Style"];
			if (!w || w === "0px" || st === "none" || st === "hidden") return "";
			return tidy(w) + " " + st + " " + toHex(cs["border" + side + "Color"]);
		});
		if (sides.some(Boolean)) {
			if (sides.every((b) => b === sides[0])) props.border = sides[0];
			else sides.forEach((b, i) => { if (b) props["border-" + ["top", "right", "bottom", "left"][i]] = b; });
		}
		const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(tidy);
		if (!radii.every((r) => r === "0px")) props["border-radius"] = shorthand4(radii[0], radii[1], radii[2], radii[3]);

		put("box-shadow", cut(tidy(cs.boxShadow), 120));
		put("opacity", cs.opacity === "1" ? "" : cs.opacity);
		put("transform", cut(tidy(cs.transform), 80));
		put("backdrop-filter", cut(cs.backdropFilter, 60));
		put("filter", cut(cs.filter, 60));
		if (cs.overflow !== "visible") props.overflow = cs.overflow;
		if (cs.transitionDuration && !/^(0s,?\s*)+$/.test(cs.transitionDuration)) {
			props.transition = cut(cs.transitionProperty + " " + cs.transitionDuration + " " + cs.transitionTimingFunction, 90);
		}

		for (const prop of INHERITED) {
			const raw = cs.getPropertyValue(prop);
			if (!raw) continue;
			let value = prop === "color" ? toHex(raw) : tidy(raw);
			if (prop === "font-family") value = cut(String(raw).split(",").slice(0, 3).map((f) => f.trim().replace(/^["']|["']$/g, "")).join(", "), 70);
			if (!value) continue;
			if (parent) {
				let parentValue = prop === "color" ? toHex(parent.getPropertyValue(prop)) : tidy(parent.getPropertyValue(prop));
				if (prop === "font-family") parentValue = cut(String(parent.getPropertyValue(prop)).split(",").slice(0, 3).map((f) => f.trim().replace(/^["']|["']$/g, "")).join(", "), 70);
				if (parentValue === value) continue;
			} else if (INITIAL[prop] === value) continue;
			props[prop] = value;
		}
		return props;
	};

	// --- tokens -------------------------------------------------------------
	const colors = new Map(), typeScale = new Map(), spacing = new Map();
	const radii = new Map(), shadows = new Map(), borders = new Map(), motionValues = new Map();
	const animationUse = new Map();
	const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
	const addColor = (hex, role) => {
		if (!hex || hex === "transparent") return;
		let e = colors.get(hex);
		if (!e) { e = { count: 0, roles: new Map() }; colors.set(hex, e); }
		e.count++;
		e.roles.set(role, (e.roles.get(role) || 0) + 1);
	};
	const pxIn = (value) => String(value || "").split(/\s+/)
		.map((t) => (/^-?[\d.]+px$/.test(t) ? Math.abs(round(parseFloat(t), 1)) : null))
		.filter((n) => n !== null && n > 0 && n <= 200);

	// --- the walk -----------------------------------------------------------
	const styleIds = new Map();
	const styles = [];
	const tree = [];
	const headings = [];
	let shown = 0, truncated = false;
	const counts = { elements: 0, shown: 0, links: 0, buttons: 0, inputs: 0, images: 0 };

	const label = (el) => {
		let out = el.tagName.toLowerCase();
		if (el.id) out += "#" + cut(el.id, 24);
		const classes = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
		for (const cls of classes.slice(0, MAX_CLASSES)) out += "." + cut(cls, 24);
		if (classes.length > MAX_CLASSES) out += "(+" + (classes.length - MAX_CLASSES) + ")";
		return cut(out, 90);
	};

	// Where a thing sits, in words: "in the header", "in a nav". Enough for the rebuild to
	// put the right picture in the right place without a selector.
	const roleOfNode = (el) => {
		let node = el.parentElement, depth = 0;
		while (node && depth++ < 6) {
			const tag = node.tagName.toLowerCase();
			if (tag === "header" || tag === "nav" || tag === "footer" || tag === "aside" || tag === "main") return "in the " + tag;
			const cls = (node.getAttribute("class") || "").toLowerCase();
			if (/hero|banner|masthead/.test(cls)) return "in the hero";
			if (/card|tile|panel/.test(cls)) return "in a card";
			if (/logo|brand/.test(cls)) return "the logo";
			node = node.parentElement;
		}
		return "on the page";
	};

	const ownText = (el) => {
		let out = "";
		for (const node of el.childNodes) {
			if (node.nodeType === 3) out += node.nodeValue;
			if (out.length > MAX_TEXT * 2) break;
		}
		return cut(ws(out), MAX_TEXT);
	};

	const walk = (el, parentStyle, depth) => {
		if (shown >= MAX_NODES) { truncated = true; return; }
		counts.elements++;
		let cs;
		try { cs = getComputedStyle(el); } catch (e) { return; }
		if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return;
		const box = el.getBoundingClientRect();
		// Off-screen and zero-size elements describe nothing about what the page looks like.
		if (box.width < 2 || box.height < 2) return;
		if (box.top > window.innerHeight * 2) return;

		const tag = el.tagName.toLowerCase();
		const props = styleOf(cs, parentStyle, tag);
		const key = Object.keys(props).sort().map((k) => k + ":" + props[k]).join(";");
		let id = null;
		if (key) {
			id = styleIds.get(key);
			if (!id) {
				id = "S" + (styles.length + 1);
				styleIds.set(key, id);
				styles.push({ id: id, props: props, count: 0 });
			}
			const entry = styles[parseInt(id.slice(1), 10) - 1];
			if (entry) entry.count++;
		}

		const text = ownText(el);
		if (text) {
			addColor(toHex(cs.color), "text");
			const family = cut(String(cs.fontFamily).split(",")[0].replace(/^["']|["']$/g, "").trim(), 40);
			const typeKey = family + "|" + cs.fontSize + "|" + cs.fontWeight + "|" + cs.lineHeight;
			const seen = typeScale.get(typeKey);
			if (seen) seen.count++;
			else typeScale.set(typeKey, { family: family, size: cs.fontSize, weight: cs.fontWeight, lineHeight: tidy(cs.lineHeight), count: 1, sample: cut(text, 40) });
		}
		if (props["background-color"]) addColor(props["background-color"], "background");
		if (props["background-image"]) for (const c of colorsIn(props["background-image"])) addColor(c, "gradient");
		for (const k of ["border", "border-top", "border-right", "border-bottom", "border-left"]) {
			if (!props[k]) continue;
			bump(borders, props[k]);
			for (const c of colorsIn(props[k])) addColor(c, "border");
		}
		if (props["box-shadow"]) { bump(shadows, props["box-shadow"]); for (const c of colorsIn(props["box-shadow"])) addColor(c, "shadow"); }
		if (props["border-radius"]) bump(radii, props["border-radius"]);
		if (props.transition) bump(motionValues, props.transition);
		if (cs.animationName && cs.animationName !== "none") {
			bump(motionValues, cut(cs.animationName + " " + cs.animationDuration + " " + cs.animationTimingFunction, 90));
			// Which element it runs on is the part that cannot be guessed from the keyframes.
			// A rebuild that copies @keyframes but attaches none of them is a still picture.
			for (const name of String(cs.animationName).split(",").map((n) => n.trim())) {
				if (!name || name === "none") continue;
				const seen = animationUse.get(name);
				if (seen) seen.count++;
				else animationUse.set(name, {
					name: name,
					duration: cut(cs.animationDuration, 30),
					easing: cut(cs.animationTimingFunction + (cs.animationIterationCount !== "1" ? " ×" + cs.animationIterationCount : "") + (cs.animationFillMode !== "none" ? " " + cs.animationFillMode : ""), 60),
					on: label(el),
					count: 1,
				});
			}
		}
		for (const k of ["padding", "margin", "gap"]) for (const n of pxIn(props[k])) bump(spacing, n);

		if (/^h[1-6]$/.test(tag) && text) headings.push({ level: parseInt(tag.slice(1), 10), text: text });
		if (tag === "a") counts.links++;
		else if (tag === "button" || (tag === "input" && el.type === "button")) counts.buttons++;
		else if (tag === "input" || tag === "select" || tag === "textarea") counts.inputs++;
		else if (tag === "img" || tag === "svg" || tag === "picture") counts.images++;

		const attrs = [];
		for (const name of ["href", "type", "placeholder", "alt", "aria-label"]) {
			const value = el.getAttribute && el.getAttribute(name);
			if (value) attrs.push(name + "=" + JSON.stringify(cut(ws(value), 40)));
		}

		shown++;
		tree.push(
			"  ".repeat(Math.min(depth, 12)) + label(el) +
			" " + Math.round(box.width) + "x" + Math.round(box.height) +
			" @" + Math.round(box.left) + "," + Math.round(box.top + window.scrollY) +
			(id ? " " + id : "") +
			(text ? " " + JSON.stringify(text) : "") +
			(attrs.length ? " " + attrs.join(" ") : "")
		);

		const kids = el.shadowRoot ? el.shadowRoot.children : el.children;
		for (const child of kids) walk(child, cs, depth + 1);
	};

	// --- author's own tokens ------------------------------------------------
	// Custom properties declared on :root, ranked by how often the site's own rules use
	// them: a Tailwind v4 build declares hundreds, and the referenced ones are the design
	// system. Cross-origin sheets throw on .cssRules and are skipped.
	const declared = new Map(), used = new Map(), breakpoints = new Set();
	let budget = 12000;
	const scanRules = (rules) => {
		for (const rule of rules) {
			if (budget-- < 0) return;
			if (rule.media || rule.conditionText) {
				const text = String(rule.conditionText || (rule.media && rule.media.mediaText) || "");
				const mq = /(?:min|max)-width\s*:\s*([\d.]+)(px|r?em)/g;
				let m;
				while ((m = mq.exec(text)) !== null) breakpoints.add(Math.round(m[2] === "px" ? parseFloat(m[1]) : parseFloat(m[1]) * 16));
			}
			if (rule.style && rule.selectorText) {
				const isRoot = /(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText);
				for (let i = 0; i < rule.style.length; i++) {
					const name = rule.style[i];
					const value = rule.style.getPropertyValue(name);
					if (isRoot && name.indexOf("--") === 0) declared.set(name, ws(value));
					const uses = /var\(\s*(--[\w-]+)/g;
					let u;
					while ((u = uses.exec(value)) !== null) used.set(u[1], (used.get(u[1]) || 0) + 1);
				}
			}
			if (rule.cssRules) scanRules(rule.cssRules);
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		try { scanRules(sheet.cssRules); } catch (e) { /* cross-origin */ }
	}
	const rootStyle = getComputedStyle(document.documentElement);
	const vars = Array.from(declared.keys())
		.sort((a, b) => (used.get(b) || 0) - (used.get(a) || 0))
		.slice(0, 40)
		.map((name) => {
			const live = ws(rootStyle.getPropertyValue(name)) || declared.get(name) || "";
			return [name, cut(toHex(live) || live, 90)];
		});

	const body = document.body;
	if (body) {
		const cs = getComputedStyle(body);
		addColor(toHex(cs.backgroundColor), "page background");
		walk(body, null, 0);
	}
	counts.shown = shown;

	// --- the page's own rules, kept as written -------------------------------
	// The computed values above say what a thing looks like right now. They cannot say
	// what it does on hover, what it transitions, or what its keyframes are — those live
	// in rules that are not currently applying. So the rules themselves are collected,
	// verbatim, and handed over for the components that matter.
	const allRules = [];
	const keyframeRules = new Map();
	let ruleBudget = 4000;
	const collectRules = (rules) => {
		for (const rule of rules) {
			if (ruleBudget-- < 0) return;
			if (rule.type === 7 || (rule.name && rule.cssRules && !rule.selectorText)) {
				keyframeRules.set(String(rule.name), cut(rule.cssText, 600));
				continue;
			}
			if (rule.selectorText && rule.style && rule.style.length) {
				allRules.push({ selector: String(rule.selectorText), text: cut(rule.cssText, 420) });
			}
			if (rule.cssRules) collectRules(rule.cssRules);
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		try { collectRules(sheet.cssRules); } catch (e) { /* cross-origin */ }
	}

	// A selector that cannot match anything right now — :hover, ::before, :focus-visible —
	// still describes this element. Strip the state to test the match, keep the rule whole.
	const baseSelector = (sel) => sel
		.replace(/::?(?:hover|focus|focus-within|focus-visible|active|visited|target|checked|disabled|before|after|placeholder|selection|first-line|first-letter|marker|backdrop)\b(\([^)]*\))?/g, "")
		.replace(/\s+/g, " ").trim();

	const rulesFor = (el) => {
		const out = [];
		for (const rule of allRules) {
			if (out.length >= 14) break;
			for (const part of rule.selector.split(",")) {
				const base = baseSelector(part);
				if (!base || base === "*") continue;
				let hit = false;
				try { hit = el.matches(base); } catch (e) { hit = false; }
				if (hit) { out.push(rule.text); break; }
			}
		}
		return out;
	};

	// Markup, cleaned: scripts and inline handlers out, long data URIs shortened. This is
	// what "copy the component" means — the real element, not a description of it.
	const cleanHtml = (el) => {
		let clone;
		try { clone = el.cloneNode(true); } catch (e) { return ""; }
		for (const node of Array.from(clone.querySelectorAll("script, style, noscript, template"))) node.remove();
		const strip = (node) => {
			if (node.attributes) {
				for (const attr of Array.from(node.attributes)) {
					if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
					else if (attr.value && attr.value.indexOf("data:") === 0 && attr.value.length > 120) node.setAttribute(attr.name, "data:…");
				}
			}
			for (const child of Array.from(node.children || [])) strip(child);
		};
		strip(clone);
		return cut(clone.outerHTML.replace(/\s+/g, " "), 1400);
	};

	const componentPicks = [
		["header", "header, [role=banner]"],
		["nav", "nav, [role=navigation]"],
		["primary button", "button, [role=button], a[class*=btn], a[class*=button]"],
		["card", "[class*=card], [class*=panel], [class*=tile]"],
		["input", "input:not([type=hidden]), textarea, select"],
		["hero", "main > *:first-child, section:first-of-type"],
		["footer", "footer, [role=contentinfo]"],
	];
	const components = [];
	const takenNodes = new Set();
	for (const [name, selector] of componentPicks) {
		if (components.length >= 7) break;
		let el = null;
		try {
			for (const candidate of Array.from(document.querySelectorAll(selector)).slice(0, 12)) {
				if (takenNodes.has(candidate)) continue;
				const box = candidate.getBoundingClientRect();
				if (box.width < 16 || box.height < 12 || box.top > window.innerHeight * 2) continue;
				el = candidate;
				break;
			}
		} catch (e) { /* a selector this engine dislikes */ }
		if (!el) continue;
		takenNodes.add(el);
		components.push({ label: name + " — " + label(el), html: cleanHtml(el), rules: rulesFor(el) });
	}

	// --- assets -------------------------------------------------------------
	// A rebuild with grey boxes where the product shots were is not the design. Everything
	// the page draws is listed here with the role it plays; the download happens outside,
	// through the same guard as every other fetch.
	const assets = [];
	const assetSeen = new Set();
	const icons = [];
	const addAsset = (url, kind, role, width, height, alt) => {
		if (!url || assets.length >= 40) return;
		const absolute = (() => { try { return new URL(url, location.href).href; } catch (e) { return ""; } })();
		if (!absolute || absolute.indexOf("data:") === 0 || absolute.indexOf("blob:") === 0) return;
		if (assetSeen.has(absolute)) return;
		assetSeen.add(absolute);
		assets.push({ url: cut(absolute, 500), kind: kind, role: role, width: Math.round(width || 0), height: Math.round(height || 0), alt: cut(ws(alt || ""), 80) });
	};

	const visible = (el) => {
		const box = el.getBoundingClientRect();
		return box.width >= 8 && box.height >= 8 && box.top < window.innerHeight * 3;
	};

	try {
		for (const img of Array.from(document.images).slice(0, 60)) {
			if (!visible(img)) continue;
			const box = img.getBoundingClientRect();
			addAsset(img.currentSrc || img.src, "image", roleOfNode(img), box.width, box.height, img.alt);
		}
		for (const video of Array.from(document.querySelectorAll("video")).slice(0, 8)) {
			if (!visible(video)) continue;
			const box = video.getBoundingClientRect();
			if (video.poster) addAsset(video.poster, "image", "video poster", box.width, box.height, "");
			const src = video.currentSrc || video.src || (video.querySelector("source") || {}).src;
			addAsset(src, "video", roleOfNode(video), box.width, box.height, "");
		}
		for (const el of Array.from(document.querySelectorAll("*")).slice(0, 1200)) {
			if (assets.length >= 40) break;
			let bg;
			try { bg = getComputedStyle(el).backgroundImage; } catch (e) { continue; }
			if (!bg || bg === "none" || bg.indexOf("url(") === -1) continue;
			if (!visible(el)) continue;
			const box = el.getBoundingClientRect();
			const urls = bg.match(/url\((['"]?)([^'")]+)\1\)/g) || [];
			for (const raw of urls.slice(0, 2)) {
				const m = /url\((['"]?)([^'")]+)\1\)/.exec(raw);
				if (m) addAsset(m[2], "image", "background of " + label(el), box.width, box.height, "");
			}
		}
		const icon = document.querySelector("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
		if (icon) addAsset(icon.getAttribute("href"), "image", "favicon", 32, 32, "");
		const ogImage = document.querySelector("meta[property='og:image'], meta[name='twitter:image']");
		if (ogImage) addAsset(ogImage.getAttribute("content"), "image", "og:image", 0, 0, "");

		// Inline SVG is the icon set most sites actually use, and it arrives free.
		for (const svg of Array.from(document.querySelectorAll("svg")).slice(0, 40)) {
			if (icons.length >= 10) break;
			const box = svg.getBoundingClientRect();
			if (box.width < 8 || box.height < 8 || box.width > 320 || box.top > window.innerHeight * 2) continue;
			const markup = cut(svg.outerHTML.replace(/\s+/g, " "), 900);
			if (!markup || icons.some((i) => i.svg === markup)) continue;
			icons.push({ label: roleOfNode(svg) + " " + Math.round(box.width) + "x" + Math.round(box.height), svg: markup });
		}
	} catch (e) { /* a page that redefines its own DOM APIs */ }

	// Keyframes: the ones a rendered element actually names come first, then whatever else
	// the sheets declare, up to a byte budget. The old version kept six of sixty-one and
	// dropped the entrance animation on the hero, which is the one a person notices.
	const named = [];
	const rest = [];
	for (const name of keyframeRules.keys()) {
		if (animationUse.has(name)) named.push(name);
		else rest.push(name);
	}
	const keyframes = [];
	let frameBudget = 9000;
	for (const name of named.concat(rest)) {
		const body = keyframeRules.get(name);
		if (!body || frameBudget - body.length < 0) continue;
		frameBudget -= body.length;
		keyframes.push(body);
	}

	// Canvas and video draw pixels no rule describes. The snapshot can only point at them;
	// the caller photographs each rect through the debugging protocol and files the result
	// as an asset, which is the only way a rebuild can have the hero of a page like this.
	const surfaces = [];
	try {
		// Canvases are numbered in document order, so what one of them draws can be read off
		// the element itself rather than photographed through everything drawn over it.
		const canvases = Array.from(document.querySelectorAll("canvas"));
		for (const el of Array.from(document.querySelectorAll("canvas, video"))) {
			if (surfaces.length >= 4) break;
			const box = el.getBoundingClientRect();
			if (box.width < 120 || box.height < 90) continue;
			if (box.top > window.innerHeight * 1.5) continue;
			const tag = el.tagName.toLowerCase();
			let detail = "";
			if (tag === "canvas") {
				let kind = "2d";
				try { kind = el.getContext("webgl2") ? "WebGL2" : el.getContext("webgl") ? "WebGL" : "2d"; } catch (e) { kind = "unknown"; }
				detail = kind + " canvas, drawn every frame";
			} else {
				detail = "video" + (el.autoplay ? ", autoplaying" : "") + (el.loop ? ", looping" : "");
			}
			surfaces.push({
				kind: tag,
				label: roleOfNode(el) + " " + label(el),
				x: Math.round(box.left), y: Math.round(box.top + window.scrollY),
				w: Math.round(box.width), h: Math.round(box.height),
				detail: detail,
				index: tag === "canvas" ? canvases.indexOf(el) : -1,
			});
		}
	} catch (e) { /* a page that redefines querySelectorAll */ }

	const fonts = [];
	try {
		const seen = new Set();
		document.fonts.forEach((f) => {
			if (f.status !== "loaded") return;
			const name = f.family.replace(/^["']|["']$/g, "") + " " + f.weight;
			if (!seen.has(name)) { seen.add(name); fonts.push(cut(name, 40)); }
		});
	} catch (e) { /* no font API */ }

	const ranked = (map, limit) => Array.from(map.entries())
		.map(([value, count]) => ({ value: value, count: count }))
		.sort((a, b) => b.count - a.count).slice(0, limit);

	const pageBg = body ? toHex(getComputedStyle(body).backgroundColor) : "";
	const scheme = (() => {
		const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(pageBg || "");
		if (!m) return "unknown";
		const l = (parseInt(m[1], 16) * 0.2126 + parseInt(m[2], 16) * 0.7152 + parseInt(m[3], 16) * 0.0722) / 255;
		return l < 0.5 ? "dark" : "light";
	})();

	// --- the frontend itself -------------------------------------------------
	// Everything above is a reading of the page. This is the page: the DOM after the
	// framework has finished with it, and every rule that is actually in force. It is far
	// too large for a prompt, so it is written to a file the model can open when it needs
	// the exact thing rather than the summary of it.
	const source = { html: "", css: "", sheets: 0, rules: 0 };
	try {
		const clone = document.documentElement.cloneNode(true);
		for (const node of Array.from(clone.querySelectorAll("script, noscript, template, link[rel=preload], link[rel=prefetch]"))) node.remove();
		for (const node of Array.from(clone.querySelectorAll("*"))) {
			for (const attr of Array.from(node.attributes || [])) {
				if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
				else if (attr.value && attr.value.length > 400 && attr.value.indexOf("data:") === 0) node.setAttribute(attr.name, "data:…");
			}
		}
		source.html = cut(clone.outerHTML, 900000);
	} catch (e) { /* a document that will not clone */ }
	try {
		const parts = [];
		let budget = 900000;
		for (const sheet of Array.from(document.styleSheets)) {
			let rules;
			try { rules = sheet.cssRules; } catch (e) { continue; }
			source.sheets++;
			parts.push("/* --- " + cut(sheet.href || "inline <style>", 200) + " --- */");
			for (const rule of Array.from(rules)) {
				if (budget <= 0) break;
				const text = rule.cssText;
				source.rules++;
				budget -= text.length;
				parts.push(text);
			}
			if (budget <= 0) break;
		}
		source.css = parts.join("\n");
	} catch (e) { /* no readable sheets */ }

	return {
		url: cut(location.href, 300),
		title: cut(ws(document.title), 160),
		lang: cut(document.documentElement.lang || "", 12),
		colorScheme: scheme,
		viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
		page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
		counts: counts,
		tree: tree,
		styles: styles.slice(0, 90),
		tokens: {
			colors: Array.from(colors.entries())
				.map(([hex, e]) => ({ hex: hex, count: e.count, roles: Array.from(e.roles.entries()).sort((a, b) => b[1] - a[1]).map((r) => r[0]).slice(0, 3) }))
				.sort((a, b) => b.count - a.count).slice(0, 30),
			type: Array.from(typeScale.values()).sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || b.count - a.count).slice(0, 18),
			spacing: Array.from(spacing.entries()).map(([value, count]) => ({ value: value, count: count }))
				.sort((a, b) => b.count - a.count).slice(0, 16).sort((a, b) => a.value - b.value),
			radii: ranked(radii, 8),
			shadows: ranked(shadows, 6),
			borders: ranked(borders, 8),
			fonts: fonts.slice(0, 12),
			vars: vars,
			breakpoints: Array.from(breakpoints).sort((a, b) => a - b).slice(0, 10),
		},
		headings: headings.slice(0, 20),
		components: components,
		keyframes: keyframes,
		assets: assets,
		icons: icons,
		animations: Array.from(animationUse.values()).sort((a, b) => b.count - a.count).slice(0, 14),
		surfaces: surfaces,
		source: source,
		motion: ranked(motionValues, 8),
		truncated: truncated,
	};
})()`;

/**
 * The snapshot as text for the model. Markdown, because that is what a model reads best,
 * and because a human debugging a bad rebuild needs to read the same thing.
 *
 * Ordered by what a rebuild needs first: what the page IS, then its tokens, then its
 * structure, then the style dictionary the structure refers to.
 */
export function renderSnapshot(snap: PageSnapshot): string {
	const out: string[] = [];
	const push = (line: string): void => {
		out.push(line);
	};

	push(`# ${snap.title || snap.url}`);
	push(`Rendered at ${snap.viewport.w}×${snap.viewport.h}; the page itself is ${snap.page.w}×${snap.page.h}.`);
	push(`Colour scheme: ${snap.colorScheme}.${snap.lang ? ` Language: ${snap.lang}.` : ""}`);
	push(
		`${snap.counts.shown} of ${snap.counts.elements} visible elements described` +
			`${snap.truncated ? " (capped)" : ""} — ${snap.counts.links} links, ${snap.counts.buttons} buttons, ` +
			`${snap.counts.inputs} inputs, ${snap.counts.images} images.`,
	);
	push("");

	if (snap.tokens.colors.length) {
		push("## Colours, as rendered (count, and what they are used for)");
		for (const c of snap.tokens.colors) push(`- ${c.hex} ×${c.count} — ${c.roles.join(", ")}`);
		push("");
	}
	if (snap.tokens.type.length) {
		push("## Type scale, as rendered");
		for (const t of snap.tokens.type) {
			push(`- ${t.size}/${t.lineHeight} ${t.weight} ${t.family} ×${t.count} — “${t.sample}”`);
		}
		push("");
	}
	if (snap.tokens.fonts.length) push(`Loaded fonts: ${snap.tokens.fonts.join(", ")}\n`);
	if (snap.tokens.spacing.length) {
		push(`## Spacing steps in use (px)\n${snap.tokens.spacing.map((s) => `${s.value}×${s.count}`).join(", ")}\n`);
	}
	if (snap.tokens.radii.length) push(`Radii: ${snap.tokens.radii.map((r) => `${r.value} ×${r.count}`).join(", ")}\n`);
	if (snap.tokens.shadows.length) push(`Shadows:\n${snap.tokens.shadows.map((s) => `- ${s.value} ×${s.count}`).join("\n")}\n`);
	if (snap.tokens.borders.length) push(`Borders: ${snap.tokens.borders.map((b) => `${b.value} ×${b.count}`).join(" · ")}\n`);
	if (snap.tokens.breakpoints.length) push(`Breakpoints declared: ${snap.tokens.breakpoints.join(", ")}px\n`);
	if (snap.tokens.vars.length) {
		push("## The site's own custom properties, most referenced first");
		for (const [name, value] of snap.tokens.vars) push(`- ${name}: ${value}`);
		push("");
	}
	if (snap.headings.length) {
		push("## Headings, in order");
		for (const h of snap.headings) push(`${"#".repeat(Math.min(h.level, 6))} ${h.text}`);
		push("");
	}
	if (snap.tree.length) {
		push("## Layout, as laid out");
		push("Each line: `tag#id.class WxH @x,y S# \"own text\" attrs`. Boxes are CSS pixels on the page.");
		push("```");
		for (const line of snap.tree) push(line);
		push("```");
		push("");
	}
	if (snap.surfaces.length) {
		// Said before the tokens, because a rebuild that misses this misses the page: these
		// are the parts drawn by code rather than declared by a rule, and the asset manifest
		// below carries a photograph of each one.
		push("## Drawn, not styled");
		for (const s of snap.surfaces) {
			push(`- ${s.label}: ${s.detail}, ${s.w}×${s.h} at ${s.x},${s.y}. A still of it is in the assets below.`);
		}
		push("");
	}
	if (snap.animations.length) {
		push("## What moves, and on what");
		for (const a of snap.animations) {
			push(`- \`${a.name}\` ${a.duration} ${a.easing} on ${a.on}${a.count > 1 ? ` and ${a.count - 1} more` : ""}`);
		}
		push("");
	}
	if (snap.motion.length) {
		push("## Transitions and animation shorthands, as declared");
		for (const m of snap.motion) push(`- ${m.value} ×${m.count}`);
		push("");
	}
	if (snap.keyframes.length) {
		push("## Keyframes, verbatim");
		push("```css");
		for (const frame of snap.keyframes) push(frame);
		push("```");
		push("");
	}
	if (snap.components.length) {
		// The point of the whole exercise for anyone rebuilding: the real markup of a real
		// component, and the real rules that style it — including the states that are not
		// currently applying, which is where hover and transition live.
		push("## Components, with their own markup and rules");
		for (const component of snap.components) {
			push(`### ${component.label}`);
			if (component.html) {
				push("```html");
				push(component.html);
				push("```");
			}
			if (component.rules.length) {
				push("```css");
				for (const rule of component.rules) push(rule);
				push("```");
			}
			push("");
		}
	}
	if (snap.icons.length) {
		push("## Inline icons, verbatim");
		push("```html");
		for (const icon of snap.icons) push(`<!-- ${icon.label} -->\n${icon.svg}`);
		push("```");
		push("");
	}
	if (snap.styles.length) {
		push("## Style dictionary (the S# above)");
		for (const style of snap.styles) {
			const props = Object.entries(style.props)
				.map(([k, v]) => `${k}: ${v}`)
				.join("; ");
			push(`- **${style.id}** ×${style.count}: ${props}`);
		}
		push("");
	}
	return out.join("\n");
}

/** A rough size guard: this text goes into a prompt, and a huge page can produce a lot. */
export function trimSnapshotText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[snapshot truncated at ${maxChars} characters]`;
}
