// A high score is not an answer. When a cue's rare words appear in no note at all, the
// result is a guess assembled out of the vault's own vocabulary, and recall has to say so.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryCoverage } from "../src/hybrid-search";
import { openBrainDb } from "../src/index-db";

const dir = join(tmpdir(), `brain-coverage-${process.pid}`);
/** A vault about charts, values and clusters — and nothing about Kubernetes. */
const CORPUS = [
	"the chart component renders values from the design system cluster",
	"chart values are tokens; a cluster of notes shares them",
	"tailscale shows every peer offline when the key expired",
	"vfio passthrough reset bug on the amd card",
];

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const { db } = openBrainDb(join(dir, "index.sqlite"));
	CORPUS.forEach((text, i) => {
		db.query("INSERT INTO docs (id, path, title, hash, mtime, size) VALUES (?, ?, ?, ?, 0, 0)").run(i + 1, `n${i}.md`, `Note ${i}`, `h${i}`);
		db.query("INSERT INTO chunks (id, doc_id, heading, pos, text) VALUES (?, ?, '', 0, ?)").run(i + 1, i + 1, text);
		db.query("INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (?, ?, '', ?)").run(i + 1, `Note ${i}`, text);
	});
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const covered = (query: string) => queryCoverage(query.toLowerCase().split(/\s+/), CORPUS.length);

describe("query coverage", () => {
	test("a cue the vault is actually about is fully covered", () => {
		expect(covered("tailscale peer offline").covered).toBe(1);
		expect(covered("vfio passthrough reset").unknown).toEqual([]);
	});

	test("the homonym trap: common vault words, missing subject", () => {
		const result = covered("helm chart values cluster");
		expect(result.unknown).toContain("helm");
		// The one word that carried the subject is the rarest, so most of the cue is missing.
		expect(result.covered).toBeLessThan(0.7);
	});

	test("a cue about nothing the vault holds is uncovered", () => {
		expect(covered("sourdough fermentation schedule").covered).toBe(0);
		expect(covered("norwegian tax deductions").covered).toBe(0);
	});

	test("the rarest missing word is named first", () => {
		const result = covered("kubernetes chart values");
		expect(result.unknown[0]).toBe("kubernetes");
	});

	test("stopwords and stubs carry no weight", () => {
		expect(covered("the a of chart").covered).toBe(1);
	});
});
