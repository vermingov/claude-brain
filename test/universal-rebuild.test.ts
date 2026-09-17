// The site-agnostic rebuild, checked without a browser: which CSS survives a transplant, how a
// ripped canvas is swapped for the engine's, how two recordings are lined up and judged, and what
// a ported behaviour is refused for.

import { describe, expect, test } from "bun:test";
import { compareRecordings, safetyIssues } from "../src/behaviour-port";
import { pageResources, srcsetCandidates } from "../src/page-resources";
import { SOURCE_RULES, type TransplantCapture, absoluteUrls, keptRules, scriptTokens, transplantScript, withHeroCanvas } from "../src/page-transplant";
import { type Recording, alignmentError, expandRecording, uniformLog } from "../src/parity-hooks";
import { shaderNames } from "../src/scene-source";

const capture = (rules: TransplantCapture["rules"], classes: string[]): TransplantCapture => ({
	ok: true,
	note: "",
	url: "https://example.com/",
	title: "",
	htmlAttributes: [],
	bodyAttributes: [],
	body: "",
	rules,
	globals: [],
	unreadable: [],
	classes,
	icon: "",
});

describe("transplanted CSS", () => {
	test("keeps what matched, and a later state's rule only when every class it needs exists somewhere", () => {
		const rules = [
			{ css: ".hero { color: red }", href: "", matched: true, classes: [] },
			// The page adds `animate` from script when the element scrolls into view.
			{ css: ".outer.animate { animation: x 3s }", href: "", matched: false, classes: ["outer", "animate"] },
			{ css: ".outer.unheardof { color: blue }", href: "", matched: false, classes: ["outer", "unheardof"] },
			{ css: "dialog[open] { display: block }", href: "", matched: false, classes: [] },
		];
		const tokens = scriptTokens(`const s = { animate: "animate" }; el.classList.toggle("animate")`);
		const kept = keptRules(capture(rules, ["hero", "outer"]), tokens).map((r) => r.css);
		expect(kept).toEqual([".hero { color: red }", ".outer.animate { animation: x 3s }"]);
	});

	test("script tokens keep the characters utility classes are made of", () => {
		const tokens = scriptTokens(`cn("md:flex", 'w-1/2', \`data-[state=open]:block\`)`);
		expect(tokens.has("md:flex")).toBe(true);
		expect(tokens.has("w-1/2")).toBe(true);
		expect(tokens.has("data-[state=open]:block")).toBe(true);
	});

	test("url() is resolved against the sheet, and data: is left alone", () => {
		const css = `.a { background: url("../img/x.png") } .b { background: url(data:image/png;base64,AAA) }`;
		expect(absoluteUrls(css, "https://cdn.example.com/css/site.css")).toBe(
			`.a { background: url("https://cdn.example.com/img/x.png") } .b { background: url(data:image/png;base64,AAA) }`,
		);
	});

	test("the in-page script parses", () => {
		expect(() => new Function(transplantScript([{ href: "https://x/y.css", text: ".a\\:b { color: red }" }]))).not.toThrow();
	});

	test("a rule is found in its sheet's source the way the CSSOM names it, so what the CSSOM lost is not lost", () => {
		const { sourceRules, ruleKey } = new Function(`${SOURCE_RULES}; return { sourceRules, ruleKey };`)();
		const index = sourceRules(String.raw`/* x */ .card{padding:var(--s) var(--s) 0;padding-bottom:0}
@media (min-width:720px){.card{padding:var(--t) var(--t) 0}.q::after{content:"}{;\"x"}}
.card{color:red}
.bg{background:url(data:image/svg+xml;utf8,<svg>{</svg>)}
.nest{&:hover{color:blue}}
[data-x=y] > .f:before{color:red}`);
		const rule = (context: string[], prelude: string, k = 0) => (index.get(ruleKey(context, prelude)) ?? [])[k];
		// As Chrome serialises them: spaces after colons, quoted attribute values, two-colon pseudos.
		expect(rule([], ".card")).toBe(".card {padding:var(--s) var(--s) 0;padding-bottom:0}");
		expect(rule([], ".card", 1)).toBe(".card {color:red}");
		expect(rule(["@media (min-width: 720px)"], ".card")).toBe(".card {padding:var(--t) var(--t) 0}");
		expect(rule(["@media (min-width: 720px)"], ".q::after")).toBe('.q::after {content:"}{;\\"x"}');
		expect(rule([], ".bg")).toBe(".bg {background:url(data:image/svg+xml;utf8,<svg>{</svg>)}");
		expect(rule([], ".nest")).toBe(".nest {&:hover{color:blue}}");
		expect(rule([], '[data-x="y"] > .f::before')).toBe("[data-x=y] > .f:before {color:red}");
	});
});

describe("resources", () => {
	test("srcset candidates split where the HTML spec splits them", () => {
		expect(srcsetCandidates("/a.png?w=1,2 1x, /b.png 2x")).toEqual([
			{ url: "/a.png?w=1,2", descriptors: "1x" },
			{ url: "/b.png", descriptors: "2x" },
		]);
		expect(srcsetCandidates("/c.png, /d.png 640w")).toEqual([
			{ url: "/c.png", descriptors: "" },
			{ url: "/d.png", descriptors: "640w" },
		]);
	});

	test("what was not downloaded points at the original site, in markup, attributes and styles alike", () => {
		const resources = pageResources("https://example.com/page");
		const markup = `<img srcset="/_next/image?url=%2Fx.png&amp;w=32 1x, /_next/image?url=%2Fx.png&amp;w=64 2x" src="/x.png"><a href="/elsewhere">x</a><div style="background-image: url(&quot;/bg.png?a=1&amp;b=2&quot;)"></div>`;
		expect(resources.markup(markup)).toBe(
			`<img srcset="https://example.com/_next/image?url=%2Fx.png&amp;w=32 1x, https://example.com/_next/image?url=%2Fx.png&amp;w=64 2x" src="https://example.com/x.png"><a href="/elsewhere">x</a><div style="background-image: url(&quot;https://example.com/bg.png?a=1&amp;b=2&quot;)"></div>`,
		);
		expect(resources.attribute("srcset", "/a.png 1x, /b.png 2x")).toBe("https://example.com/a.png 1x, https://example.com/b.png 2x");
		expect(resources.attribute("style", 'background: url("data:image/png;base64,AAA")')).toBe('background: url("data:image/png;base64,AAA")');
		expect(resources.attribute("class", "/not-a-url")).toBe("/not-a-url");
	});
});

describe("the hero canvas", () => {
	const body = `<div class="bg"><canvas data-brain-canvas="0" data-brain-fills="" width="2400" height="1934" style="display: block; width: 1200px; height: 967px;" data-engine="three.js r185"></canvas></div><canvas data-brain-canvas="1" class="spark" width="10" height="10"></canvas>`;

	test("the ripped one becomes the engine's, sized to its container when it filled it", () => {
		const out = withHeroCanvas(body, 0);
		expect(out).toContain('<canvas data-hero-scene style="display: block; width: 100%; height: 100%;"></canvas>');
		expect(out).not.toContain("data-engine");
	});

	test("others lose only the capture's markers", () => {
		const out = withHeroCanvas(body, 0);
		expect(out).toContain('<canvas class="spark" width="10" height="10"></canvas>');
		expect(out).not.toContain("data-brain-");
	});
});

// A tiny scene: one pass with a clock, a value that eases to 1, and a constant.
function recording(mount: number, ease: (k: number) => number, shift = 0): Recording {
	const frames: Recording["frames"] = [];
	for (let k = 0; k < 400; k++) {
		const u: Record<string, number[]> = { uTime: [(k + shift) / 60 + 3], scale: [ease(k + shift)] };
		if (k === 0) u.colour = [1, 0.5, 0.25];
		frames.push({ f: mount + k, draws: [{ p: 1, fbo: 0, vp: [100, 100], cw: 100, ch: 100, u }] });
	}
	return { sceneStart: mount, mount, frames, innerWidth: 1280, innerHeight: 800, mouse: [] };
}
const spring = (k: number) => 1 - (1 + k / 30) * Math.exp(-k / 30);

describe("recordings", () => {
	test("a change-only recording expands back to every value on every frame", () => {
		const full = expandRecording(recording(10, spring));
		expect(full.frames[250]!.draws[0]!.u.colour).toEqual([1, 0.5, 0.25]);
		expect(full.frames[250]!.draws[0]!.u.scale![0]).toBeCloseTo(spring(250), 12);
	});

	test("the right alignment is the one with the smallest error", () => {
		const a = expandRecording(recording(10, spring));
		const b = expandRecording(recording(40, spring, 2));
		expect(alignmentError(a, b, 2, ["uTime"])).toBe(0);
		expect(alignmentError(a, b, 0, ["uTime"])).toBeGreaterThan(0);
	});

	test("a port with the page's arithmetic is exact, whatever the clock read at mount", () => {
		const page = recording(10, spring);
		const port = recording(90, spring);
		port.frames = port.frames.map((row) => ({ ...row, draws: row.draws.map((d) => ({ ...d, u: { ...d.u, uTime: [d.u.uTime![0]! + 7] } })) }));
		expect(compareRecordings(page, port).worst).toBe(0);
	});

	test("a port with a different spring is caught, however it is shifted", () => {
		const page = recording(10, spring);
		const port = recording(10, (k) => 1 - (1 + k / 27) * Math.exp(-k / 27));
		const result = compareRecordings(page, port);
		expect(result.worst).toBeGreaterThan(1e-3);
		expect(result.divergences[0]!.name).toBe("scale");
	});

	test("the all-uniform log script parses", () => {
		expect(() => new Function(uniformLog("all"))).not.toThrow();
	});
});

describe("ported behaviours", () => {
	test("the ways out of the sandbox are refused before anything runs", () => {
		expect(safetyIssues("fetch('https://x')")).toContain("network access");
		expect(safetyIssues("new Function('return 1')")).toContain("code loading");
		expect(safetyIssues("localStorage.setItem('a', 1)")).toContain("storage");
		expect(safetyIssues("document.body.innerHTML = ''")).toContain("navigation or DOM writing");
		expect(safetyIssues("window.__heroBehaviour = (scene, env) => { env.requestAnimationFrame(() => scene.render()); };")).toEqual([]);
	});
});

describe("scene source", () => {
	test("the names a scene's authors chose, not GLSL's or the engine's", () => {
		const names = shaderNames({
			programs: [
				{
					id: 1,
					handle: 1,
					vertex: "uniform mat4 modelViewMatrix; attribute vec3 position; varying vec2 vUv; void main() {}",
					fragment: "uniform float uTime; uniform vec3 uColor1; float horizontal(in vec2 xy, float t) { return 0.; } void main() {}",
				},
			],
			draws: [{ uniforms: [{ name: "uTime" }, { name: "temporalDistortion" }] }] as never,
		});
		expect(names).toContain("uTime");
		expect(names).toContain("uColor1");
		expect(names).toContain("horizontal");
		expect(names).toContain("temporalDistortion");
		expect(names).not.toContain("modelViewMatrix");
		expect(names).not.toContain("main");
		expect(names).not.toContain("position");
	});
});

describe("behaviour tapes", () => {
	// A page 3000px tall in an 800px viewport: a hero on screen at load, a demo at 1800px.
	// Node 0 is the hero, 1 a star inside it, 2 the demo, 3 the demo's input, 4 a text run in it.
	const recording = (ops: Array<[number, ...unknown[]]>, scroll: Array<[number, number]>) =>
		({
			base: 1000,
			viewport: { width: 1280, height: 800 },
			ops,
			scroll,
			rects: [
				[0, -1, 0, 700],
				[1, 0, 100, 110],
				[2, -1, 1800, 2300],
				[3, 2, 1900, 1940],
				[4, 3, -1, -1],
			],
			dropped: 0,
		}) as import("../src/dom-recording").DomRecording;

	test("a change on screen from the start plays from load; one in a demo waits for the demo", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		const built = buildTapes(
			recording(
				[
					[1500, "a", 1, "data-state", "on"],
					[4000, "p", 3, "value", "h"],
					[4100, "t", 4, "hello"],
				],
				[[3000, 1500]],
			),
		);
		const hero = built.tapes.find((t) => t.anchor === 0)!;
		expect(hero.episodes[0]!.enter).toEqual([[500, "a", 1, "data-state", "on"]]);
		const demo = built.tapes.find((t) => t.anchor === 2)!;
		// The demo entered view when the page scrolled at 3000; its changes are timed from then.
		expect(demo.before).toEqual([]);
		expect(demo.episodes[0]!.enter).toEqual([
			[1000, "p", 3, "value", "h"],
			[1100, "t", 4, "hello"],
		]);
	});

	test("coming into view a second time plays the second set; leaving plays the reaction to leaving", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		const built = buildTapes(
			recording(
				[
					[3600, "a", 3, "class", "typing"],
					[5700, "a", 3, "class", ""],
					[9500, "a", 3, "class", "typing again"],
				],
				[
					[3000, 1500],
					[5000, 0],
					[9000, 1500],
				],
			),
		);
		const demo = built.tapes.find((t) => t.anchor === 2)!;
		expect(demo.episodes.length).toBe(2);
		expect(demo.episodes[0]!.enter).toEqual([[600, "a", 3, "class", "typing"]]);
		expect(demo.episodes[0]!.exit).toEqual([[700, "a", 3, "class", ""]]);
		expect(demo.episodes[1]!.enter).toEqual([[500, "a", 3, "class", "typing again"]]);
	});

	test("what only changed right after scrolls follows the box those scrolls moved, at the share that had to show", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		// Node 3, the input at 1900-1940, inside the demo at 1800-2300. Scrolled to 1120 half of the
		// input is showing, at 1500 all of it, at 1950 none; its class only changes right after those.
		const built = buildTapes(
			recording(
				[
					[3010, "a", 3, "class", "on", ""],
					[5012, "a", 3, "class", "", "on"],
					[7010, "a", 3, "class", "on", ""],
				],
				[
					[2000, 1120],
					[3000, 1500],
					[5000, 1950],
					[7000, 1500],
				],
			),
		);
		const input = built.tapes.find((t) => t.anchor === 3)!;
		expect(input.threshold).toBe(0.75);
		expect(input.episodes.map((e) => [e.enter, e.exit])).toEqual([
			[[[10, "a", 3, "class", "on"]], [[12, "a", 3, "class", ""]]],
			[[[10, "a", 3, "class", "on"]], []],
		]);
	});

	test("the body's own children and the capture's markers are not replayed", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		const built = buildTapes(
			recording(
				[
					[1100, "c", -1, "<div></div>", 50],
					[1200, "a", 1, "data-brain-canvas", "0"],
				],
				[],
			),
		);
		expect(built.tapes).toEqual([]);
		expect(built.interactions).toEqual([]);
		expect(Object.values(built.skipped).reduce((a, b) => a + b, 0)).toBe(2);
	});

	test("what kept changing out of sight runs from load, and loops on the cycle it was recorded on", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		// Node 4's text run stands in for a star far below the fold, twinkling every half second.
		const ops: Array<[number, ...unknown[]]> = [];
		for (let i = 1; i <= 30; i++) ops.push([1000 + 500 * i, "a", 3, "data-state", i % 2 ? "on" : "off", i % 2 ? "off" : "on"]);
		const built = buildTapes({ ...recording(ops, []), end: 16_400 });
		const star = built.tapes.find((t) => t.anchor === 2)!;
		expect(star.episodes).toEqual([]);
		expect(star.before[0]).toEqual([500, "a", 3, "data-state", "on"]);
		expect(star.loop).toEqual([500, 1000]);
	});

	test("a click on a tab puts the whole control in the state it had then, whatever was clicked before", async () => {
		const { buildTapes } = await import("../src/dom-tapes");
		// Nodes 5, 6, 7: three tabs under node 3; the first is selected when the page is captured.
		const tabs = {
			base: 1000,
			viewport: { width: 1280, height: 800 },
			scroll: [],
			rects: [
				[0, -1, 0, 700],
				[1, 0, 100, 110],
				[2, -1, 1800, 2300],
				[3, 0, 200, 240],
				[4, 3, -1, -1],
				[5, 3, 200, 240],
				[6, 3, 200, 240],
				[7, 3, 200, 240],
			],
			dropped: 0,
			ops: [
				[2000, "m", 5, "click"],
				[3000, "m", 5, "end"],
				[4000, "m", 6, "click"],
				[4100, "a", 5, "class", "tab", "tab on"],
				[4100, "a", 6, "class", "tab on", "tab"],
				[5000, "m", 6, "end"],
				[6000, "m", 7, "click"],
				[6100, "a", 6, "class", "tab", "tab on"],
				[6100, "a", 7, "class", "tab on", "tab"],
				[7000, "m", 7, "end"],
			],
		} as unknown as import("../src/dom-recording").DomRecording;
		const built = buildTapes(tabs);
		const click = (target: number) => built.interactions.find((i) => i.on === "click" && i.target === target)!.ops;
		// The first tab changed nothing when clicked; played later, it selects itself again.
		expect(click(5)).toEqual(
			expect.arrayContaining([
				[0, "a", 5, "class", "tab on"],
				[0, "a", 6, "class", "tab"],
				[0, "a", 7, "class", "tab"],
			]),
		);
		expect(click(6)).toEqual([
			[0, "a", 7, "class", "tab"],
			[100, "a", 5, "class", "tab"],
			[100, "a", 6, "class", "tab on"],
		]);
		expect(click(7)).toEqual([
			[0, "a", 5, "class", "tab"],
			[100, "a", 6, "class", "tab"],
			[100, "a", 7, "class", "tab on"],
		]);
		expect(built.tapes).toEqual([]);
	});

	test("the walker, the recorder and the player parse", async () => {
		const { CANON_WALKER, RECORDER_SCRIPT } = await import("../src/dom-recording");
		const { rebuildRuntime } = await import("../src/webgl-ripper");
		expect(() => new Function(CANON_WALKER)).not.toThrow();
		expect(() => new Function(RECORDER_SCRIPT)).not.toThrow();
		expect(() => new Function(rebuildRuntime({ tapes: { tapes: [], interactions: [], skipped: {} } }))).not.toThrow();
	});
});
