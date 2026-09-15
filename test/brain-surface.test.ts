// The procedural brain: a field that is negative inside, positive outside, zero on a
// surface that notes can be walked onto, with mirrored anatomical regions on it.

import { describe, expect, test } from "bun:test";
import { brainField, brainGradient, projectToSurface, regionAnchor } from "../src/brain-surface";
import { brainShape, layoutGraph } from "../src/graph-layout";

const shape = brainShape(1);

describe("brain surface", () => {
	test("inside is negative, outside positive, the cortex is near zero", () => {
		expect(brainField({ x: 0, y: 0, z: 0 }, shape)).toBeLessThan(0);
		expect(brainField({ x: 0, y: 3 * shape.ay, z: 0 }, shape)).toBeGreaterThan(0);
		expect(Math.abs(brainField({ x: shape.ax * 0.75, y: shape.ay * 0.55, z: 0 }, shape))).toBeLessThan(shape.ax * 0.15);
	});

	test("the fissure runs along the midline", () => {
		const onMidline = brainField({ x: 0, y: shape.ay * 0.98, z: 0 }, shape);
		const beside = brainField({ x: shape.ax * 0.35, y: shape.ay * 0.98, z: 0 }, shape);
		expect(onMidline).toBeGreaterThan(beside);
	});

	test("projection lands on the surface with an outward normal", () => {
		const p = projectToSurface({ x: 40, y: 200, z: 30 }, shape);
		expect(Math.abs(brainField(p, shape))).toBeLessThan(0.5);
		const { normal } = brainGradient(p, shape);
		expect(normal.x * p.x + normal.y * p.y + normal.z * p.z).toBeGreaterThan(0);
	});

	test("regions come in mirrored pairs on the cortex", () => {
		const left = regionAnchor(0, shape);
		const right = regionAnchor(1, shape);
		expect(Math.sign(left.x)).toBe(-Math.sign(right.x));
		expect(Math.abs(brainField(left, shape))).toBeLessThan(0.5);
		expect(Math.abs(brainField(right, shape))).toBeLessThan(0.5);
		// Every rank gets its own spot.
		const spots = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(regionAnchor(i, shape)).slice(0, 40)));
		expect(spots.size).toBe(20);
	});

	test("a layout leaves every note on the cortex", () => {
		const nodes = Array.from({ length: 60 }, (_, i) => ({ id: i, category: i % 2 ? "Notes" : "Journals", connections: i % 4 }));
		const edges = Array.from({ length: 40 }, (_, i) => ({ source: i, target: (i * 7 + 1) % 60, kind: "wikilink" }));
		const positions = layoutGraph(nodes, edges, ["Journals", "Notes"]);
		for (const p of positions.values()) expect(Math.abs(brainField(p, shape))).toBeLessThan(1);
	});
});
