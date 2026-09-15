// The nerve model: a volley spreads outward hop by hop, weakens as it goes, respects the
// synapse kinds the viewer left switched on, and fires each note once, when the first
// signal reaches it.

import { describe, expect, test } from "bun:test";
import { buildConduction, planRoute, planVolley } from "../frontend/brain/cascade.js";

// cascade.js is the renderer\'s own module, plain JS with no types of its own; these are
// the shapes this suite relies on.
interface Link { edge: number; other: number; forward: boolean; length: number; conductance: number }
interface Fire { node: number; at: number; gain: number }
interface Impulse { edge: number; forward: boolean; at: number; travel: number; gain: number }
type Plan = { fires: Fire[]; impulses: Impulse[] };
type Adjacency = Link[][];
interface Options { now?: number; passes?: (edge: number) => boolean; excitability?: number[]; limit?: number }
const conduction = (graph: unknown): Adjacency => buildConduction(graph) as Adjacency;
const volley = (adjacency: Adjacency, seeds: number[], options?: Options): Plan =>
	planVolley(adjacency, seeds, options) as Plan;
const route = (adjacency: Adjacency, path: number[], options?: Options): Plan =>
	planRoute(adjacency, path, options) as Plan;

/** A chain of five notes, wikilinked, 60 units apart, plus one faint tag shortcut. */
function chain() {
	const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, x: i * 60, y: 0, z: 0, category: "Notes" }));
	const edges = [
		{ source: 0, target: 1, kind: "wikilink" },
		{ source: 1, target: 2, kind: "wikilink" },
		{ source: 2, target: 3, kind: "wikilink" },
		{ source: 3, target: 4, kind: "wikilink" },
		{ source: 0, target: 4, kind: "tag" },
	];
	return { nodes, edges, categories: [{ id: "Notes", color: "#ffffff" }] };
}

describe("conduction", () => {
	test("both ends of a synapse can conduct, strongest kind first", () => {
		const adjacency = conduction(chain());
		expect(adjacency[0]!.map((link) => link.other)).toEqual([1, 4]);
		expect(adjacency[0]![0]!.forward).toBe(true);
		expect(adjacency[1]!.find((link) => link.other === 0)!.forward).toBe(false);
		expect(adjacency[0]![0]!.length).toBeCloseTo(60, 5);
	});
});

describe("volley", () => {
	test("spreads outward, arrives later the further it goes, and stops at the hop limit", () => {
		const graph = chain();
		const { fires, impulses } = volley(conduction(graph), [0], { now: 10 });
		const at = new Map(fires.map((f) => [f.node, f.at]));
		expect(at.get(0)).toBe(10);
		expect(at.get(1)!).toBeGreaterThan(10);
		expect(at.get(2)!).toBeGreaterThan(at.get(1)!);
		// Four hops out is past the limit; three is not.
		expect(at.has(3)).toBe(true);
		expect(fires.length).toBeLessThan(graph.nodes.length + 1);
		for (const impulse of impulses) {
			expect(impulse.travel).toBeGreaterThan(0);
			expect(impulse.gain).toBeGreaterThan(0);
			expect(impulse.gain).toBeLessThanOrEqual(1.5);
		}
	});

	test("a signal weakens with every hop", () => {
		const { fires } = volley(conduction(chain()), [0], { now: 0 });
		const gain = new Map(fires.map((f) => [f.node, f.gain]));
		expect(gain.get(0)).toBe(1);
		expect(gain.get(1)!).toBeLessThan(1);
		expect(gain.get(2)!).toBeLessThan(gain.get(1)!);
	});

	test("a note fires once, at the earliest arrival", () => {
		const { fires } = volley(conduction(chain()), [0, 2], { now: 0 });
		const seen = fires.map((f) => f.node);
		expect(new Set(seen).size).toBe(seen.length);
	});

	test("a synapse kind switched off does not conduct", () => {
		const graph = chain();
		const adjacency = conduction(graph);
		// Only the tag shortcut leaves note 4, and it is filtered out.
		const passes = (edge: number) => graph.edges[edge]!.kind !== "tag";
		const { impulses } = volley(adjacency, [4], { now: 0, passes });
		expect(impulses.every((i) => graph.edges[i.edge]!.kind !== "tag")).toBe(true);
		const open = volley(adjacency, [4], { now: 0 });
		expect(open.impulses.length).toBeGreaterThan(impulses.length);
	});

	test("a well-worn memory fires harder than a cold one", () => {
		const adjacency = conduction(chain());
		const cold = volley(adjacency, [1], { now: 0 });
		const hot = volley(adjacency, [1], { now: 0, excitability: [0, 1, 0, 0, 0] });
		expect(hot.fires[0]!.gain).toBeGreaterThan(cold.fires[0]!.gain);
		expect(hot.fires[0]!.gain).toBeLessThanOrEqual(1.5);
	});

	test("the impulse pool is never overrun", () => {
		const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, x: i, y: 0, z: 0, category: "Notes" }));
		const edges = [];
		for (let i = 0; i < 200; i++) for (let j = i + 1; j < 200; j += 7) edges.push({ source: i, target: j, kind: "wikilink" });
		const { impulses } = volley(conduction({ nodes, edges, categories: [] }), [0, 1, 2], { now: 0, limit: 24 });
		expect(impulses.length).toBeLessThanOrEqual(24);
	});
});

describe("route", () => {
	test("runs one signal down the hops in order", () => {
		const graph = chain();
		const { fires, impulses } = route(conduction(graph), [0, 1, 2], { now: 5 });
		expect(fires.map((f) => f.node)).toEqual([0, 1, 2]);
		expect(fires[1]!.at).toBeGreaterThan(fires[0]!.at);
		expect(fires[2]!.at).toBeGreaterThan(fires[1]!.at);
		expect(impulses.map((i) => i.edge)).toEqual([0, 1]);
		expect(impulses.every((i) => i.forward)).toBe(true);
	});

	test("a hop this view has no synapse for still advances the clock", () => {
		const { fires, impulses } = route(conduction(chain()), [0, 3], { now: 0 });
		expect(impulses).toHaveLength(0);
		expect(fires[1]!.at).toBeGreaterThan(fires[0]!.at);
	});
});
