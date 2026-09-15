// The 3D view's data path: the layout is deterministic and anatomical, a warm start moves
// only what changed, and the payload comes from the index with index-based edges.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, noteDetail } from "../src/graph-builder";
import { BRAIN, layoutGraph, lobeOf } from "../src/graph-layout";
import { openBrainDb } from "../src/index-db";

const dir = join(tmpdir(), `brain-graph-${process.pid}`);

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "vault", "Notes"), { recursive: true });
	const { db } = openBrainDb(join(dir, "index.sqlite"));
	const doc = db.query("INSERT INTO docs (id, path, title, hash, mtime, size) VALUES (?, ?, ?, 'h', 0, 0)");
	doc.run(1, "Notes/alpha.md", "Alpha");
	doc.run(2, "00 Notes/beta.md", "Beta");
	doc.run(3, "01 Journals/2026-09-15.md", "2026-09-15 log");
	db.run("INSERT INTO links (source_doc, target_doc, relation, context) VALUES (1, 2, 'references', '')");
	db.run("INSERT INTO derived_links (source_doc, target_doc, kind, weight, detail) VALUES (2, 3, 'semantic', 0.7, '')");
	db.run("INSERT INTO doc_tags (doc_id, tag) VALUES (1, 'rust')");
	db.run("INSERT INTO communities (doc_id, community) VALUES (1, 0), (2, 0), (3, 1)");
	db.run("INSERT INTO community_labels (community, label, size) VALUES (0, 'alpha · beta', 2), (1, 'log', 1)");
	db.run("INSERT INTO doc_layout (doc_id, x, y, z) VALUES (1, 10, 20, 30)");
	writeFileSync(join(dir, "vault", "Notes", "alpha.md"), "---\ntags: [rust]\n---\n# Alpha\n\nBody of alpha.\n");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lobes", () => {
	test("an ordering prefix does not make a second lobe", () => {
		expect(lobeOf("00 Notes/x.md")).toBe("Notes");
		expect(lobeOf("Notes/x.md")).toBe("Notes");
		expect(lobeOf("01 Journals/2026/x.md")).toBe("Journals");
		expect(lobeOf("top.md")).toBe("__root__");
	});
});

describe("layout", () => {
	const nodes = () =>
		Array.from({ length: 40 }, (_, i) => ({ id: i, category: i % 3 === 0 ? "Notes" : "Journals", connections: i % 5 }));
	const edges = Array.from({ length: 30 }, (_, i) => ({ source: i, target: (i * 7 + 1) % 40, kind: i % 2 ? "wikilink" : "semantic" }));

	test("is deterministic and stays inside the brain ellipsoid", () => {
		const a = layoutGraph(nodes(), edges, ["Notes", "Journals"]);
		const b = layoutGraph(nodes(), edges, ["Notes", "Journals"]);
		expect([...a.values()]).toEqual([...b.values()]);
		for (const p of a.values()) {
			expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
			const e = Math.hypot(p.x / BRAIN.x, p.y / BRAIN.y, p.z / BRAIN.z);
			expect(e).toBeLessThan(1.6);
		}
	});

	test("a warm start keeps a settled vault where it was", () => {
		const cold = layoutGraph(nodes(), edges, ["Notes", "Journals"]);
		const warmNodes = nodes().map((n) => ({ ...n, ...cold.get(n.id)! }));
		const warm = layoutGraph(warmNodes, edges, ["Notes", "Journals"]);
		let moved = 0;
		for (const [id, p] of warm) {
			const q = cold.get(id)!;
			moved += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
		}
		expect(moved / warm.size).toBeLessThan(15);
	});
});

describe("payload", () => {
	test("comes from the index with index-based edges and merged lobes", () => {
		const graph = buildGraph();
		expect(graph.nodes.map((n) => n.id)).toEqual(["00 Notes/beta.md", "01 Journals/2026-09-15.md", "Notes/alpha.md"]);
		expect(graph.categories.map((c) => c.id)).toEqual(["Journals", "Notes"]);
		expect(graph.edges).toEqual([
			{ source: 2, target: 0, kind: "wikilink" },
			{ source: 0, target: 1, kind: "semantic" },
		]);
		const alpha = graph.nodes[2]!;
		expect(alpha).toMatchObject({ title: "Alpha", tags: ["rust"], connections: 1, community: 0, x: 10, y: 20, z: 30 });
		expect(graph.nodes[1]!.date).toBe("2026-09-15");
		expect(graph.communities[0]).toEqual({ id: 0, label: "alpha · beta", size: 2 });
		expect(JSON.stringify(graph)).not.toContain("excerpt");
	});

	test("a note's detail reads one file and lists every neighbour", () => {
		const detail = noteDetail("Notes/alpha.md", join(dir, "vault"))!;
		expect(detail.content).toBe("# Alpha\n\nBody of alpha.");
		expect(detail.backlinks).toEqual(["00 Notes/beta.md"]);
		expect(detail.node.tags).toEqual(["rust"]);
		expect(noteDetail("Notes/missing.md", join(dir, "vault"))).toBeNull();
	});
});
