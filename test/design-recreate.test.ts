// The parts of the rebuild pipeline that can be checked without a browser or a model:
// which model a plan buys, what survives being served back to a browser, and whether the
// snapshot renders into something a model can actually read.

import { describe, expect, test } from "bun:test";
import { sanitizeSvg, validAssetFile } from "../src/design-assets";
import { describeComparison, pct } from "../src/design-compare";
import { stripScripts } from "../src/design-recreate";
import { hasHeadroom, planFrom } from "../src/model-policy";
import { type PageSnapshot, renderSnapshot, trimSnapshotText } from "../src/page-snapshot";

describe("plan detection", () => {
	test("reads the subscription out of the CLI's own payload", () => {
		expect(planFrom('{"loggedIn":true,"subscriptionType":"pro"}')).toBe("pro");
		expect(planFrom('{"loggedIn":true,"subscriptionType":"max"}')).toBe("max5");
		expect(planFrom('{"loggedIn":true,"subscriptionType":"free"}')).toBe("free");
	});

	test("a Max subscription is never guessed upward", () => {
		// The payload cannot distinguish 5x from 20x, and guessing high spends the user's
		// best model on every rebuild without being asked.
		expect(planFrom('{"loggedIn":true,"subscriptionType":"max"}')).toBe("max5");
		expect(planFrom('{"loggedIn":true,"subscriptionType":"max_20x"}')).toBe("max20");
	});

	test("anything unreadable is unknown rather than generous", () => {
		expect(planFrom("not json")).toBe("unknown");
		expect(planFrom('{"loggedIn":false,"subscriptionType":"max"}')).toBe("unknown");
		expect(planFrom("{}")).toBe("unknown");
	});
});

describe("headroom", () => {
	test("a number below its floor blocks the top model", () => {
		expect(hasHeadroom({ daily: 59, weekly: null, fableWeekly: null, source: "" })).toBe(false);
		expect(hasHeadroom({ daily: 90, weekly: 49, fableWeekly: null, source: "" })).toBe(false);
		expect(hasHeadroom({ daily: 90, weekly: 90, fableWeekly: 10, source: "" })).toBe(false);
	});

	test("unknown does not block", () => {
		// Nothing local publishes rate limits. Refusing the good model on no evidence would
		// collapse the whole ladder to the cheapest model for everyone.
		expect(hasHeadroom({ daily: null, weekly: null, fableWeekly: null, source: "" })).toBe(true);
		expect(hasHeadroom({ daily: 61, weekly: null, fableWeekly: null, source: "" })).toBe(true);
	});
});

describe("what gets served back", () => {
	test("a rebuilt document cannot carry script", () => {
		const html = stripScripts(
			`<div onclick="steal()">x</div><script>fetch('/api/designs/abc/forget')</script>` +
				`<a href="javascript:alert(1)">y</a><script src="//evil/x.js"></script>`,
		);
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onclick");
		expect(html).not.toContain("javascript:");
		expect(html).toContain("<div");
	});

	test("an SVG keeps its shapes and loses its behaviour", () => {
		const svg = `<svg viewBox="0 0 2 2"><script>x()</script><circle cx="1" onload="y()" r="1"/></svg>`;
		const out = new TextDecoder().decode(sanitizeSvg(new TextEncoder().encode(svg)));
		expect(out).toContain("<circle");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("onload");
	});

	test("only our own asset names are servable", () => {
		expect(validAssetFile("0123456789abcdef.png")).toBe(true);
		expect(validAssetFile("0123456789abcdef.mp4")).toBe(true);
		expect(validAssetFile("../../../etc/passwd")).toBe(false);
		expect(validAssetFile("0123456789abcdef.html")).toBe(false);
		expect(validAssetFile("nothex.png")).toBe(false);
	});
});

describe("comparison", () => {
	test("a failed comparison says why instead of scoring zero", () => {
		const text = describeComparison({
			ok: false,
			score: 0,
			pixel: 0,
			layout: 0,
			palette: 0,
			regions: [],
			reject: "one of the two screenshots is missing",
		});
		expect(text).toBe("one of the two screenshots is missing");
	});

	test("the worst regions are named so the next round can act on them", () => {
		const text = describeComparison({
			ok: true,
			score: 0.71,
			pixel: 0.7,
			layout: 0.8,
			palette: 0.6,
			regions: [
				{ where: "the top of the left edge", diff: 0.4 },
				{ where: "the middle of the page", diff: 0.02 },
			],
		});
		expect(text).toContain("71% match");
		expect(text).toContain("the top of the left edge");
		// A region that already matches is not something to go and fix.
		expect(text).not.toContain("the middle of the page");
	});

	test("percentages round to whole numbers", () => {
		expect(pct(0.874)).toBe("87%");
		expect(pct(1)).toBe("100%");
	});
});

function snapshot(): PageSnapshot {
	return {
		url: "https://example.com/",
		title: "Example",
		lang: "en",
		colorScheme: "dark",
		viewport: { w: 1280, h: 800, dpr: 1 },
		page: { w: 1280, h: 4000 },
		counts: { elements: 40, shown: 20, links: 3, buttons: 2, inputs: 1, images: 4 },
		tree: ["body 1280x800 @0,0 S1", "  header 1280x64 @0,0 S2 \"Example\""],
		styles: [{ id: "S1", props: { "background-color": "#07080a" }, count: 1 }],
		tokens: {
			colors: [{ hex: "#ff6363", count: 3, roles: ["background", "border"] }],
			type: [{ family: "Inter", size: "64px", weight: "600", lineHeight: "70.4px", count: 1, sample: "Hello" }],
			spacing: [{ value: 16, count: 9 }],
			radii: [{ value: "12px", count: 4 }],
			shadows: [{ value: "0 1px 2px #000000", count: 2 }],
			borders: [{ value: "1px solid #ffffff", count: 1 }],
			fonts: ["Inter 600"],
			vars: [["--accent", "#ff6363"]],
			breakpoints: [768, 1024],
		},
		headings: [{ level: 1, text: "Hello" }],
		components: [{ label: "primary button — button.btn", html: "<button class=btn>Go</button>", rules: [".btn:hover{opacity:.8}"] }],
		keyframes: ["@keyframes fade { from { opacity: 0 } }"],
		animations: [{ name: "fade", duration: "1s", easing: "ease-out forwards", on: "div.hero", count: 2 }],
		surfaces: [{ kind: "canvas", label: "in the hero canvas", x: 0, y: 0, w: 1200, h: 900, detail: "WebGL2 canvas, drawn every frame", index: 0 }],
		motion: [{ value: "opacity 150ms ease", count: 5 }],
		assets: [{ url: "https://example.com/a.png", kind: "image", role: "in the header", width: 40, height: 40, alt: "logo" }],
		icons: [{ label: "in the nav 16x16", svg: "<svg></svg>" }],
		source: { html: "<html></html>", css: ".btn{}", sheets: 2, rules: 90 },
		truncated: false,
	};
}

describe("the snapshot as text", () => {
	test("carries the values a rebuild needs", () => {
		const text = renderSnapshot(snapshot());
		expect(text).toContain("#ff6363");
		expect(text).toContain("--accent");
		expect(text).toContain("64px/70.4px 600 Inter");
		expect(text).toContain("@keyframes fade");
		// The motion has to survive into the text: a rebuild works from these lines, not
		// from the screenshot, because a screenshot cannot show movement.
		expect(text).toContain("`fade` 1s ease-out forwards on div.hero");
		expect(text).toContain("WebGL2 canvas");
		expect(text).toContain("<button class=btn>Go</button>");
		expect(text).toContain(".btn:hover");
		expect(text).toContain("1280×800");
	});

	test("trimming says that it trimmed", () => {
		const trimmed = trimSnapshotText("x".repeat(500), 100);
		expect(trimmed.length).toBeLessThan(200);
		expect(trimmed).toContain("truncated");
		expect(trimSnapshotText("short", 100)).toBe("short");
	});
});
