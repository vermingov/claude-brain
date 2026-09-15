// The Home tab's numbers come straight from the index, with a fixed 14-day window and
// the recurring themes taken from the last consolidation rather than recomputed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrainDb, setMeta } from "../src/index-db";
import { overview } from "../src/overview";

const dir = join(tmpdir(), `brain-overview-${process.pid}`);
const NOW = Date.UTC(2026, 8, 15, 12);
const DAY = 86_400_000;

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const { db } = openBrainDb(join(dir, "index.sqlite"));
	db.run("INSERT INTO docs (id, path, title, hash, mtime, size, access_count, last_access) VALUES (1, 'a.md', 'Alpha', 'h', 0, 0, 5, ?)", [NOW - DAY]);
	db.run("INSERT INTO docs (id, path, title, hash, mtime, size, access_count, last_access) VALUES (2, 'b.md', 'Beta', 'h2', 0, 0, 0, 0)");
	db.run("INSERT INTO sessions (id, cwd, started, ended, summary) VALUES ('s1', '/w/proj', ?, ?, 'did a thing')", [NOW - 2 * DAY, NOW - 2 * DAY + 1000]);
	db.run("INSERT INTO sessions (id, cwd, started) VALUES ('s2', '/w/other', ?)", [NOW - DAY]);
	const episode = db.query("INSERT INTO episodes (session_id, kind, ts, text, fingerprint) VALUES (?, ?, ?, ?, ?)");
	episode.run("s1", "prompt", NOW - 2 * DAY, "one", "f1");
	episode.run("s1", "error", NOW - 2 * DAY + 1, "two", "f2");
	episode.run("s2", "prompt", NOW - 20 * DAY, "old", "f3");
	db.run("INSERT INTO recalls (session_id, doc_id, cwd, ts) VALUES ('s1', 1, '/w/proj', ?)", [NOW - DAY]);
	db.run("INSERT INTO community_labels (community, label, size) VALUES (0, 'alpha · beta', 2), (1, 'lonely', 1)");
	setMeta(db, "proposals_json", JSON.stringify([{ kind: "error", text: "it broke", occurrences: 3, sessions: 2, lastSeen: NOW }]));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("overview", () => {
	test("reports the window, the top notes, and what recurred", () => {
		const o = overview(NOW);
		expect(o.activity).toHaveLength(14);
		expect(o.activity.at(-1)!.day).toBe("2026-09-15");
		expect(o.activity.reduce((n, d) => n + d.episodes, 0)).toBe(2);
		expect(o.activity.reduce((n, d) => n + d.recalls, 0)).toBe(1);
		expect(o.topNotes.map((n) => n.title)).toEqual(["Alpha"]);
		expect(o.recentSessions.map((s) => s.id)).toEqual(["s1"]);
		expect(o.clusters).toEqual([{ id: 0, label: "alpha · beta", size: 2 }]);
		expect(o.themes[0]!.text).toBe("it broke");
		expect(o.episodesByKind).toEqual({ prompt: 2, error: 1 });
	});
});
