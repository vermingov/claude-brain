// Synapses: one line system for every edge, positions set once from the server's layout,
// colours rewritten only when emphasis changes.

import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

/** How visible each kind is at rest; explicit links lead, similarity guesses stay faint. */
export const EDGE_ALPHA = { wikilink: 0.32, cooccur: 0.28, timeline: 0.22, semantic: 0.09, tag: 0.07 };
const TIMELINE_TINT = [148 / 255, 163 / 255, 184 / 255];
const TIMELINE_TINT_HI = [186 / 255, 196 / 255, 220 / 255];
const DIM_TINT = [30 / 255, 34 / 255, 54 / 255];

export function createEdgeLayer(scene, graph) {
	const { nodes, edges } = graph;
	const lines = edges.map((e) => {
		const s = nodes[e.source];
		const t = nodes[e.target];
		return [new Vector3(s.x, s.y, s.z), new Vector3(t.x, t.y, t.z)];
	});
	const colors = edges.map(() => [new Color4(1, 1, 1, 0.3), new Color4(1, 1, 1, 0.3)]);
	const mesh = CreateLineSystem("synapses", { lines, colors, useVertexColor: true, updatable: true }, scene);
	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true;
	const data = new Float32Array(edges.length * 8);

	/**
	 * @param {(edge: object, i: number) => "hidden"|"dim"|"normal"|"hi"} stateOf
	 * @param {(node: object) => number[]} tintOf  rgb of a node's lobe
	 */
	function restyle(stateOf, tintOf) {
		for (let i = 0; i < edges.length; i++) {
			const e = edges[i];
			const state = stateOf(e, i);
			const o = i * 8;
			if (state === "hidden") {
				data.fill(0, o, o + 8);
				continue;
			}
			let source = DIM_TINT;
			let target = DIM_TINT;
			let alpha = 0.12;
			if (state !== "dim") {
				if (e.kind === "timeline") {
					source = target = state === "hi" ? TIMELINE_TINT_HI : TIMELINE_TINT;
				} else {
					source = tintOf(nodes[e.source]);
					target = tintOf(nodes[e.target]);
				}
				alpha = state === "hi" ? 1 : EDGE_ALPHA[e.kind] ?? 0.2;
			}
			data[o] = source[0];
			data[o + 1] = source[1];
			data[o + 2] = source[2];
			data[o + 3] = alpha;
			data[o + 4] = target[0];
			data[o + 5] = target[1];
			data[o + 6] = target[2];
			data[o + 7] = alpha;
		}
		mesh.setVerticesData(VertexBuffer.ColorKind, data, true);
	}

	return { mesh, restyle, dispose: () => mesh.dispose() };
}
