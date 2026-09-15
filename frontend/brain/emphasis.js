// What is lit and what is dimmed: hover, selection, a search, or a hidden lobe or edge
// kind. Produces the per-node and per-edge state the layers colour themselves from.

import { Color3 } from "@babylonjs/core/Maths/math.color";

export const DIM_CORE = [0x17 / 255, 0x1b / 255, 0x2e / 255];

export function createEmphasis(graph) {
	const { nodes, edges, categories } = graph;
	const tintByCategory = new Map(
		categories.map((c) => {
			const color = Color3.FromHexString(c.color);
			return [c.id, [color.r, color.g, color.b]];
		}),
	);
	const fallback = [148 / 255, 163 / 255, 184 / 255];
	const neighbours = nodes.map(() => new Set());
	for (const e of edges) {
		neighbours[e.source].add(e.target);
		neighbours[e.target].add(e.source);
	}

	const state = {
		hiddenCategories: new Set(),
		hiddenKinds: new Set(),
		hovered: -1,
		selected: -1,
		/** Set of node indexes, or null when no search is active. */
		matches: null,
	};

	const focus = () => (state.hovered !== -1 ? state.hovered : state.selected);
	const nodeVisible = (i) => !state.hiddenCategories.has(nodes[i].category);
	const tintOf = (node) => tintByCategory.get(node.category) ?? fallback;

	function nodeState(i) {
		if (!nodeVisible(i)) return "hidden";
		if (state.matches) return state.matches.has(i) ? "hi" : "dim";
		const f = focus();
		if (f === -1) return "normal";
		if (i === f) return "hi";
		return neighbours[f].has(i) ? "hi" : "dim";
	}

	function edgeState(e) {
		if (state.hiddenKinds.has(e.kind) || !nodeVisible(e.source) || !nodeVisible(e.target)) return "hidden";
		if (state.matches) return state.matches.has(e.source) && state.matches.has(e.target) ? "hi" : "dim";
		const f = focus();
		if (f === -1) return "normal";
		return e.source === f || e.target === f ? "hi" : "dim";
	}

	return { state, nodeVisible, tintOf, nodeState, edgeState, neighbours };
}
