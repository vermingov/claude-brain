// A recorded site, written down and served back, checked without a browser: what a repeated
// request is matched to, what the copy's origin will and will not hand over, and what is done to
// a document before the page's own code runs in it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, withoutVolatile, writeArchive } from "../src/site-archive";
import type { Exchange, SiteRecording } from "../src/site-capture";
import { fillIn, mayFill } from "../src/site-fill";
import { mirrorKey, serveMirror } from "../src/site-serve";

const bytes = (text: string) => new TextEncoder().encode(text);
const exchange = (url: string, body: string, over: Partial<Exchange> = {}): Exchange => ({
	url,
	method: "GET",
	status: 200,
	headers: [["content-type", "text/plain"]],
	mime: "text/plain",
	kind: "Fetch",
	body: bytes(body),
	...over,
});

const DOCUMENT = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>t</title></head><body><script src="/app.js"></script></body></html>`;

const recording: SiteRecording = {
	document: "https://site.test/",
	exchanges: [
		exchange("https://site.test/", DOCUMENT, {
			kind: "Document",
			mime: "text/html",
			headers: [
				["content-type", "text/html; charset=utf-8"],
				["content-security-policy", "default-src 'self'; upgrade-insecure-requests"],
				["x-frame-options", "DENY"],
				["content-encoding", "br"],
				["set-cookie", "session=1"],
				["content-range", "0-9/120"],
			],
		}),
		exchange("https://site.test/app.js", "console.log(1)", { kind: "Script", mime: "text/javascript" }),
		exchange("https://api.site.test/rows?select=*&t=1789687943960", "[1]"),
		exchange("https://api.site.test/rows?select=id", "[2]"),
		exchange("https://api.site.test/rpc", "first", { method: "POST", bodyHash: "aaa" }),
		exchange("https://api.site.test/rpc", "second", { method: "POST", bodyHash: "bbb" }),
	],
	redirects: [["https://site.test/old.js", "https://site.test/app.js"]],
	skipped: {},
};

const dir = mkdtempSync(join(tmpdir(), "claude-brain-copy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
await writeArchive(dir, recording);
const archive = openArchive(dir)!;
const bodyOf = async (method: string, url: string, hash?: string) => {
	const entry = archive.find(method, url, hash);
	return entry ? await Bun.file(archive.bodyPath(entry)!).text() : null;
};

describe("finding a recorded answer", () => {
	test("the same request gets the same answer, fragment or not", async () => {
		expect(await bodyOf("GET", "https://site.test/app.js#x")).toBe("console.log(1)");
	});

	test("a request stamped with the time matches the one recorded at another time", async () => {
		expect(await bodyOf("GET", "https://api.site.test/rows?t=1799999999999&select=*")).toBe("[1]");
	});

	test("a different question is not given a similar question's answer", () => {
		expect(archive.find("GET", "https://api.site.test/rows?select=name")).toBeNull();
	});

	test("two posts to one endpoint are told apart by what was sent, and an unknown body gets the last", async () => {
		expect(await bodyOf("POST", "https://api.site.test/rpc", "aaa")).toBe("first");
		expect(await bodyOf("POST", "https://api.site.test/rpc", "zzz")).toBe("second");
	});

	test("an address that redirected is answered with where it led", async () => {
		expect(await bodyOf("GET", "https://site.test/old.js")).toBe("console.log(1)");
	});

	test("only what changes every time is taken out of an address", () => {
		expect(withoutVolatile("https://a.test/x?b=2&_=1789687943&a=1&r=0.4821937465")).toBe("https://a.test/x?a=1&b=2");
		expect(withoutVolatile("https://a.test/x?id=17")).toBe("https://a.test/x?id=17");
	});
});

describe("the copy's origin", () => {
	const options = { embedders: ["http://localhost:6869"] };
	const ask = (path: string, headers: Record<string, string> = {}) => serveMirror(new Request(`http://abc123.localhost:6869${path}`, { headers }), archive, options);
	const recordedUrl = (url: string, extra = "") => `/__brain/r?u=${encodeURIComponent(url)}&m=GET${extra}`;

	test("is named by the host, and only by a host that is one", () => {
		expect(mirrorKey("abc123.localhost:6869")).toBe("abc123");
		expect(mirrorKey("localhost:6869")).toBeNull();
		expect(mirrorKey("127.0.0.1:6869")).toBeNull();
		expect(mirrorKey("a.b.localhost:6869")).toBeNull();
		expect(mirrorKey("../etc.localhost")).toBeNull();
		expect(mirrorKey(null)).toBeNull();
	});

	test("any address asked for directly gets the installer, never the recording", async () => {
		for (const path of ["/", "/app.js", "/sw.js", "/api/designs"]) {
			const res = await ask(path);
			const text = await res.text();
			expect(res.headers.get("content-type")).toContain("text/html");
			expect(text).toContain("serviceWorker.register");
			expect(text).not.toContain("console.log(1)");
		}
	});

	test("a recorded answer is data for the worker and refuses to be opened as a page", async () => {
		const asData = await ask(recordedUrl("https://site.test/app.js"), { "sec-fetch-dest": "empty" });
		expect(await asData.text()).toBe("console.log(1)");
		for (const dest of ["document", "iframe", "embed"]) {
			expect((await ask(recordedUrl("https://site.test/", "&nav=1"), { "sec-fetch-dest": dest })).status).toBe(403);
		}
	});

	test("the worker is allowed the whole origin and told where the page used to live", async () => {
		const res = await ask("/__brain/worker.js");
		expect(res.headers.get("service-worker-allowed")).toBe("/");
		expect(await res.text()).toStartWith(`const SITE = {"origin":"https://site.test"};`);
	});

	test("the document loses the site's policy and framing, keeps what its code reads, and gains the fence", async () => {
		const res = await ask(recordedUrl("https://site.test/", "&nav=1"), { "sec-fetch-dest": "empty" });
		const policy = res.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("connect-src http: https:");
		expect(policy).not.toContain("ws");
		expect(policy).toContain("frame-ancestors http://localhost:6869");
		expect(policy).not.toContain("upgrade-insecure-requests");
		for (const gone of ["x-frame-options", "content-encoding", "set-cookie"]) expect(res.headers.has(gone)).toBe(false);
		expect(res.headers.get("content-range")).toBe("0-9/120");

		const markup = await res.text();
		expect(markup).not.toMatch(/http-equiv/i);
		// Ahead of the page's first script, so a worker of its own is never even asked for.
		expect(markup.indexOf("workers.register")).toBeGreaterThan(-1);
		expect(markup.indexOf("workers.register")).toBeLessThan(markup.indexOf("/app.js"));
	});

	test("what was never recorded is a 404 to a script and an explanation to a person", async () => {
		const chunk = await ask(recordedUrl("https://site.test/missing.js"), { "sec-fetch-dest": "empty" });
		expect(chunk.status).toBe(404);
		expect(await chunk.text()).toBe("");
		const page = await ask(recordedUrl("https://site.test/pricing?<script>", "&nav=1"), { "sec-fetch-dest": "empty" });
		expect(page.status).toBe(404);
		const text = await page.text();
		expect(text).toContain("not in the copy");
		expect(text).not.toContain("<script>");
	});
});

describe("a copy completing itself", () => {
	const asked: string[] = [];
	const site = async (url: string) => {
		asked.push(url);
		if (url.endsWith("/gone.png")) return { reject: "the site answered 404" };
		return { url, status: 200, contentType: "image/png", body: "", bytes: bytes("png:" + url), proxied: false, truncated: false };
	};

	test("asks only hosts the page was already seen talking to", async () => {
		expect(mayFill(archive, "https://site.test/faces/one.png")).toBe(true);
		expect(mayFill(archive, "https://api.site.test/rows?select=other")).toBe(true);
		expect(mayFill(archive, "https://elsewhere.test/collect?data=1")).toBe(false);
		expect(mayFill(archive, "http://localhost:6868/api/status")).toBe(false);
		expect(await fillIn(archive, "https://elsewhere.test/collect?data=1", site)).toBeNull();
		expect(asked).toEqual([]);
	});

	test("asks once, keeps the answer on disk, and answers from the recording after that", async () => {
		const url = "https://site.test/faces/one.png";
		const [first, second] = await Promise.all([fillIn(archive, url, site), fillIn(archive, url, site)]);
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(asked).toEqual([url]);
		expect(await bodyOf("GET", url)).toBe("png:" + url);
		// Read again from the folder, as the next run of the server would.
		const reopened = JSON.parse(await Bun.file(join(dir, "manifest.json")).text()) as { entries: Array<{ url: string; kind: string }> };
		expect(reopened.entries.find((entry) => entry.url === url)?.kind).toBe("Filled");
	});

	test("what the site refuses is not asked for again", async () => {
		const url = "https://site.test/gone.png";
		expect(await fillIn(archive, url, site)).toBeNull();
		expect(await fillIn(archive, url, site)).toBeNull();
		expect(asked.filter((u) => u === url).length).toBe(1);
	});

	test("the copy's origin fills a GET it has no answer for, and never a POST", async () => {
		const options = { embedders: [], fill: (url: string) => fillIn(archive, url, site) };
		const get = await serveMirror(
			new Request(`http://abc123.localhost:6869/__brain/r?u=${encodeURIComponent("https://site.test/faces/two.png")}&m=GET`, { headers: { "sec-fetch-dest": "empty" } }),
			archive,
			options,
		);
		expect(get.status).toBe(200);
		expect(await get.text()).toBe("png:https://site.test/faces/two.png");
		const before = asked.length;
		const post = await serveMirror(
			new Request(`http://abc123.localhost:6869/__brain/r?u=${encodeURIComponent("https://site.test/signup")}&m=POST`, { headers: { "sec-fetch-dest": "empty" } }),
			archive,
			options,
		);
		expect(post.status).toBe(404);
		expect(asked.length).toBe(before);
	});
});
