// The site-agnostic rebuild, checked without a browser: which CSS survives a transplant, how a
// ripped canvas is swapped for the engine's, how two recordings are lined up and judged, and what
// a ported behaviour is refused for.

import { describe, expect, test } from "bun:test";
import { compareRecordings, safetyIssues } from "../src/behaviour-port";
import { type TransplantCapture, absoluteUrls, keptRules, scriptTokens, transplantScript, withHeroCanvas } from "../src/page-transplant";
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
