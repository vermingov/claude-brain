// The behaviours that were measured to be wrong on a real vault, pinned so they stay fixed:
// cue budgeting (a repeated-word prompt took 2.6 s), timestamp titles, spelling correction
// against the index's own vocabulary, temporal cues, all-edge spreading, and outcomes
// mined from a failure that later succeeded.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { titleOf } from "../src/chunker";
import { noteTitle } from "../src/capture";
import { openBrainDb } from "../src/index-db";
import { queryTerms, temporalWindow } from "../src/hybrid-search";
import { spreadActivation } from "../src/spreading";
import { mineTranscript } from "../src/transcript";
import { editDistance, nearestTerm } from "../src/vocab";

const dir = join(tmpdir(), `brain-core-${process.pid}`);
const dbPath = join(dir, "index.sqlite");

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	require("node:fs").mkdirSync(dir, { recursive: true });
	// First open pins the process-wide singleton to scratch; nothing below can reach a real index.
	const { db } = openBrainDb(dbPath);
	db.query("INSERT INTO docs (id, path, title, hash, mtime, size) VALUES (?, ?, ?, ?, 0, 0)").run(1, "a.md", "Tailscale offline", "h1");
	db.query("INSERT INTO docs (id, path, title, hash, mtime, size) VALUES (?, ?, ?, ?, 0, 0)").run(2, "b.md", "Wine audio", "h2");
	db.query("INSERT INTO docs (id, path, title, hash, mtime, size) VALUES (?, ?, ?, ?, 0, 0)").run(3, "c.md", "Hyprland focus", "h3");
	db.query("INSERT INTO chunks (id, doc_id, heading, pos, text) VALUES (1, 1, '', 0, ?)").run("tailscale shows every peer offline");
	db.query("INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (1, 'Tailscale offline', '', ?)").run(
		"tailscale shows every peer offline",
	);
	// No wikilink anywhere: the only associations are derived.
	db.query("INSERT INTO derived_links (source_doc, target_doc, kind, weight, detail) VALUES (1, 2, 'semantic', 0.8, '')").run();
	db.query("INSERT INTO derived_links (source_doc, target_doc, kind, weight, detail) VALUES (1, 3, 'tag', 0.3, 'net')").run();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cue budgeting", () => {
	test("repeated words collapse to one term each", () => {
		const prompt = Array(60).fill("linker could not find libfoo").join(" ");
		expect(queryTerms(prompt)).toEqual(["linker", "could", "not", "find", "libfoo"]);
	});
	test("a pasted log is cut to a bounded number of content words", () => {
		const words = Array.from({ length: 300 }, (_, i) => `tok${i.toString(36)}lib`);
		const terms = queryTerms(`the build failed and the log is ${words.join(" ")} 2026 error`);
		expect(terms.length).toBeLessThanOrEqual(32);
		expect(terms).not.toContain("the");
		expect(terms).not.toContain("2026");
	});
	test("a short cue keeps its function words — they still match phrases", () => {
		expect(queryTerms("how do I keep an app off the workspace")).toContain("the");
	});
});

describe("titles", () => {
	test("a capture stamp yields to the first real line", () => {
		expect(titleOf("# Inbox 2026-09-07 2033\n\nTailscale marks every peer offline when the key expired.\n", "x")).toBe(
			"Tailscale marks every peer offline when the key expired.",
		);
	});
	test("a journal keeps its date in front", () => {
		expect(titleOf("# 2026-09-14\n\n## brain-graph recall audit\n", "x")).toBe("2026-09-14 brain-graph recall audit");
	});
	test("a copy suffix in a filename fallback is still a timestamp", () => {
		expect(titleOf("Some body text here.\n", "2026-09-07 2033 (2)")).toBe("Some body text here.");
	});
	test("a real title is left alone", () => {
		expect(titleOf("# Wine audio crash\n\n2026-01-01 was the day.\n", "x")).toBe("Wine audio crash");
	});
	test("a capture is titled by its first sentence, clipped", () => {
		expect(noteTitle("AUR only, never GitHub. Because packaging.")).toBe("AUR only, never GitHub.");
		expect(noteTitle(`${"x".repeat(100)} y`).length).toBeLessThanOrEqual(80);
	});
});

describe("spelling correction", () => {
	test("edit distance counts a transposition as one", () => {
		expect(editDistance("tailscale", "tailscael")).toBe(1);
		expect(editDistance("tailscale", "tailscale")).toBe(0);
		expect(editDistance("abc", "xyz")).toBeGreaterThan(2);
	});
	test("a typo snaps to the vault's stem; a known word does not", () => {
		expect(nearestTerm("tailscael")).toBe("tailscal");
		expect(nearestTerm("tailscale")).toBeNull();
		expect(nearestTerm("offline")).toBeNull();
		expect(nearestTerm("zzzzzz")).toBeNull();
	});
});

describe("temporal cues", () => {
	const now = Date.UTC(2026, 8, 15, 12);
	test("yesterday is the previous calendar day", () => {
		const w = temporalWindow("what broke yesterday", now)!;
		expect(w.until - w.since).toBe(86_400_000);
		expect(w.until).toBeLessThanOrEqual(now);
	});
	test("N days ago is a window around that day", () => {
		const w = temporalWindow("the thing from 3 days ago", now)!;
		expect(w.since).toBeLessThan(now - 3 * 86_400_000);
		expect(w.until).toBeGreaterThan(now - 3 * 86_400_000);
	});
	test("no cue, no window", () => {
		expect(temporalWindow("wine audio crash", now)).toBeNull();
	});
});

describe("spreading over derived edges", () => {
	test("reaches notes that have no wikilink at all", () => {
		const hits = spreadActivation(new Map([[1, 0.2]]), 3);
		expect(hits.map((h) => h.docId).sort()).toEqual([2, 3]);
		const semantic = hits.find((h) => h.docId === 2)!;
		const tag = hits.find((h) => h.docId === 3)!;
		expect(semantic.score).toBeGreaterThan(tag.score);
		expect(semantic.viaDocId).toBe(1);
	});
});

describe("transcript outcomes", () => {
	test("a failing command that later succeeds becomes an outcome", () => {
		const file = join(dir, "session.jsonl");
		const line = (o: unknown) => `${JSON.stringify(o)}\n`;
		const at = (m: number) => new Date(Date.UTC(2026, 8, 15, 10, m)).toISOString();
		writeFileSync(
			file,
			line({ type: "user", sessionId: "s1", cwd: "/w", timestamp: at(0), message: { content: "please make the build pass again for me" } }) +
				line({
					type: "assistant",
					timestamp: at(1),
					message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cargo build" } }] },
				}) +
				line({
					type: "user",
					timestamp: at(2),
					message: {
						content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "error[E0425]: cannot find value `foo` in this scope" }],
					},
				}) +
				line({
					type: "assistant",
					timestamp: at(3),
					message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/w/src/main.rs" } }] },
				}) +
				line({ type: "user", timestamp: at(4), message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }) +
				line({
					type: "assistant",
					timestamp: at(5),
					message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "cargo build" } }] },
				}) +
				line({ type: "user", timestamp: at(6), message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "Finished" }] } }),
		);
		const mined = mineTranscript(file)!;
		const outcome = mined.episodes.find((e) => e.kind === "outcome")!;
		expect(outcome).toBeDefined();
		expect(outcome.text).toContain("cannot find value");
		expect(outcome.text).toContain("cargo build");
		expect(outcome.text).toContain("src/main.rs");
		expect(outcome.salience).toBe(2);
	});
});
