// What the page does when the window changes size.
//
// Everything else in the capture describes one width. A design is not one width: the nav
// collapses into a button, a three-column grid becomes one column, the 64px heading drops
// to 40px, and a rebuild that knows none of that is a screenshot with a stylesheet attached.
// The declared breakpoints are already in the snapshot, but a list of numbers does not say
// what happens at them.
//
// So the page is measured at several widths and the differences are reported in words. The
// method is deliberately dumb and therefore reliable: stamp every element that matters with
// an id at the reference width, then re-measure those same ids at each other width. What
// moved, what changed size, what vanished and what appeared are then facts about identified
// elements rather than a guess from two screenshots.
//
// The page is mutated to do it — one data attribute per element. That is acceptable here
// and nowhere else: this is a throwaway tab of a copy of someone's page, the attribute is
// removed before the markup is saved, and the alternative (matching nodes across relayouts
// by geometry) is exactly the kind of heuristic that reports nonsense on the sites that
// matter most.

/** Measured at these, in this order. The first is the reference every other is compared to. */
export const WIDTHS = [1280, 1024, 768, 390];
const TAG = "data-brain-id";
const MAX_TAGGED = 260;

export interface ElementBox {
	id: number;
	label: string;
	x: number;
	y: number;
	w: number;
	h: number;
	display: string;
	fontSize: string;
	columns: string;
	visible: boolean;
}

export interface WidthProbe {
	width: number;
	height: number;
	page: { w: number; h: number };
	boxes: ElementBox[];
	/** The media queries actually matching at this width. */
	matching: string[];
}

/** Stamp the elements worth following. Runs once, at the reference width. */
export const TAG_SCRIPT = String.raw`(() => {
	let n = 0;
	const cut = (s, len) => (s == null ? "" : String(s).length <= len ? String(s) : String(s).slice(0, len - 1) + "…");
	const label = (el) => {
		let out = el.tagName.toLowerCase();
		if (el.id) out += "#" + cut(el.id, 20);
		const classes = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean);
		for (const c of classes.slice(0, 2)) out += "." + cut(c, 22);
		return cut(out, 60);
	};
	const walk = (el, depth) => {
		if (n >= ${MAX_TAGGED}) return;
		let cs;
		try { cs = getComputedStyle(el); } catch (e) { return; }
		const box = el.getBoundingClientRect();
		// Only things with a shape worth following, and only the first few screens: a
		// fifteen-thousand-pixel page has hundreds of cards that all behave the same way.
		if (box.width >= 24 && box.height >= 12 && box.top < window.innerHeight * 3) {
			el.setAttribute("${TAG}", String(n));
			el.setAttribute("${TAG}-label", label(el));
			n++;
		}
		if (depth > 14) return;
		for (const child of el.children) walk(child, depth + 1);
	};
	if (document.body) walk(document.body, 0);
	return n;
})()`;

/** Re-measure the stamped elements at whatever width the viewport is now. */
export const PROBE_SCRIPT = String.raw`(() => {
	const boxes = [];
	for (const el of document.querySelectorAll("[${TAG}]")) {
		let cs;
		try { cs = getComputedStyle(el); } catch (e) { continue; }
		const box = el.getBoundingClientRect();
		const hidden = cs.display === "none" || cs.visibility === "hidden" || (box.width < 1 && box.height < 1);
		boxes.push({
			id: Number(el.getAttribute("${TAG}")),
			label: el.getAttribute("${TAG}-label") || el.tagName.toLowerCase(),
			x: Math.round(box.left),
			y: Math.round(box.top + window.scrollY),
			w: Math.round(box.width),
			h: Math.round(box.height),
			display: cs.display,
			fontSize: cs.fontSize,
			columns: cs.gridTemplateColumns && cs.gridTemplateColumns !== "none" ? cs.gridTemplateColumns.split(" ").length + " columns" : "",
			visible: !hidden,
		});
	}
	const matching = [];
	for (const sheet of Array.from(document.styleSheets)) {
		let rules;
		try { rules = sheet.cssRules; } catch (e) { continue; }
		for (const rule of Array.from(rules)) {
			if (!rule.media || !rule.conditionText) continue;
			try { if (window.matchMedia(rule.conditionText).matches) matching.push(rule.conditionText); } catch (e) { /* a query this engine dislikes */ }
			if (matching.length > 40) break;
		}
	}
	return {
		width: window.innerWidth,
		height: window.innerHeight,
		page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
		boxes: boxes,
		matching: Array.from(new Set(matching)).slice(0, 12),
	};
})()`;

/** Take the stamps back off before the markup is saved. */
export const UNTAG_SCRIPT = String.raw`(() => {
	for (const el of document.querySelectorAll("[${TAG}]")) {
		el.removeAttribute("${TAG}");
		el.removeAttribute("${TAG}-label");
	}
	return true;
})()`;

interface Change {
	label: string;
	what: string;
}

/**
 * What changed between the reference width and this one, in the order a person would
 * notice it: things that disappeared, things that appeared, then the biggest reflows.
 */
function changesAt(base: WidthProbe, other: WidthProbe): Change[] {
	const byId = new Map(base.boxes.map((b) => [b.id, b]));
	const gone: Change[] = [];
	const appeared: Change[] = [];
	const moved: Array<Change & { delta: number }> = [];

	for (const box of other.boxes) {
		const before = byId.get(box.id);
		if (!before) continue;
		if (before.visible && !box.visible) {
			gone.push({ label: box.label, what: "is hidden" });
			continue;
		}
		if (!before.visible && box.visible) {
			appeared.push({ label: box.label, what: `appears, ${box.w}×${box.h}` });
			continue;
		}
		if (!box.visible) continue;

		const notes: string[] = [];
		// Width relative to the viewport is the interesting part: a box that was 400px of
		// 1280 and is now 350px of 390 has gone from a quarter of the screen to nearly all
		// of it, which is the actual design decision.
		const wasShare = before.w / base.width;
		const nowShare = box.w / other.width;
		if (Math.abs(box.w - before.w) > 24) {
			notes.push(`${before.w}px → ${box.w}px (${Math.round(wasShare * 100)}% → ${Math.round(nowShare * 100)}% of the width)`);
		}
		if (before.display !== box.display) notes.push(`display ${before.display} → ${box.display}`);
		if (before.columns !== box.columns && (before.columns || box.columns)) {
			notes.push(`${before.columns || "no grid"} → ${box.columns || "no grid"}`);
		}
		if (before.fontSize !== box.fontSize) notes.push(`type ${before.fontSize} → ${box.fontSize}`);
		if (notes.length) {
			moved.push({ label: box.label, what: notes.join(", "), delta: Math.abs(box.w - before.w) + (before.display !== box.display ? 1000 : 0) });
		}
	}

	moved.sort((a, b) => b.delta - a.delta);
	return [...gone.slice(0, 6), ...appeared.slice(0, 6), ...moved.slice(0, 14)];
}

/** The responsive behaviour, as text a rebuild can turn into media queries. */
export function renderResponsive(probes: WidthProbe[]): string {
	if (probes.length < 2) return "";
	const base = probes[0]!;
	const lines = [
		"## How it responds",
		"",
		`Measured at ${probes.map((p) => `${p.width}px`).join(", ")}. The first is the width everything`,
		"else here is described at; the rest say what the page does when it narrows. Write real",
		"media queries for these, at the breakpoints the page itself declares.",
		"",
	];
	for (const probe of probes.slice(1)) {
		lines.push(`### At ${probe.width}px`);
		if (probe.matching.length) lines.push(`Queries in force: ${probe.matching.join("; ")}`);
		const changes = changesAt(base, probe);
		if (changes.length === 0) lines.push("Nothing moves: the layout is the same as at the reference width.");
		for (const change of changes) lines.push(`- ${change.label} ${change.what}`);
		lines.push("");
	}
	return lines.join("\n");
}
