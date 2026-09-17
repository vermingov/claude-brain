// The replay's generated scripts and the capture's font handling, checked without a browser.
//
// What these cannot check — that the engine draws the same pixels as the page it was taken
// from — is checked by the parity tools in tools/parity against a live page.

import { describe, expect, test } from "bun:test";
import { fontFaces, validAssetFile } from "../src/design-assets";
import { RIPPER_HOOK_SCRIPT, RIPPER_READ_SCRIPT, type RippedFrame, replayEssentials, replayRuntime } from "../src/webgl-ripper";

const frame = {
	ok: true,
	note: "",
	canvas: { width: 2400, height: 1934 },
	canvasCss: { width: 1200, height: 967.21875 },
	webgl2: true,
	programs: [{ id: 1, handle: 1, vertex: "void main(){}", fragment: "void main(){}" }],
	buffers: [],
	textures: [],
	frozen: false,
	intro: [{ t: 0, uniforms: [] }],
	timeline: [{ t: 0, uniforms: [] }],
	pointer: [],
	stream: [{ f: "__frame", a: [] }],
	locationNames: [{ handle: 1, program: 1, name: "uTime" }],
	handles: 2,
	extensions: [],
	framebuffers: [],
	draws: [],
	stats: { buffersSeen: 0, texturesSeen: 0, drawsInFrame: 0, droppedBytes: 0 },
} as unknown as RippedFrame;

const parses = (source: string) => {
	new Function(source);
	return true;
};

describe("the hero script", () => {
	test("parses fetched, inline, and with a behaviour", () => {
		expect(parses(replayRuntime(frame, "frame.json"))).toBe(true);
		expect(parses(replayRuntime(frame, "", { inline: true }))).toBe(true);
		expect(parses(replayRuntime(frame, "", { inline: true, behaviour: "window.__heroBehaviour = () => ({});" }))).toBe(true);
	});

	test("an inline frame leaves the capture's working notes behind", () => {
		const bare = replayEssentials(frame, false);
		expect("stream" in bare).toBe(false);
		expect("locationNames" in bare).toBe(false);
		expect("timeline" in bare).toBe(false);
		// Without a behaviour the samples are the motion, so they stay.
		const modelled = replayEssentials(frame, true);
		expect(modelled.timeline?.length).toBe(1);
		expect("stream" in modelled).toBe(false);
	});

	test("the canvas facts travel with the frame", () => {
		const script = replayRuntime(frame, "", { inline: true });
		expect(script).toContain('"canvasCss":{"width":1200,"height":967.21875}');
	});

	test("the capture scripts parse", () => {
		expect(parses(RIPPER_HOOK_SCRIPT)).toBe(true);
		expect(parses(RIPPER_READ_SCRIPT)).toBe(true);
	});
});

describe("fonts", () => {
	test("each url() resolves against the stylesheet it came from", () => {
		const css = [
			"/* --- https://example.com/_next/static/chunks/a.css --- */",
			'@font-face { font-family: Inter; src: url("../media/inter.woff2") format("woff2"); }',
			".x { background: url(ignored.png); }",
			"/* --- https://cdn.example.org/fonts/b.css --- */",
			"@font-face { font-family: Mono; src: local(Mono), url(mono.woff) format(\"woff\"), url(data:font/woff2;base64,AAAA); }",
		].join("\n");
		const faces = fontFaces(css);
		expect(faces.length).toBe(2);
		expect(faces[0]!.sources.map((s) => s.absolute)).toEqual(["https://example.com/_next/static/media/inter.woff2"]);
		// data: URLs are already inline; local() is not a URL at all.
		expect(faces[1]!.sources.map((s) => s.absolute)).toEqual(["https://cdn.example.org/fonts/mono.woff"]);
	});

	test("font files are servable asset names", () => {
		expect(validAssetFile("0123456789abcdef.woff2")).toBe(true);
		expect(validAssetFile("0123456789abcdef.woff")).toBe(true);
		expect(validAssetFile("0123456789abcdef.ttf")).toBe(false);
	});
});
