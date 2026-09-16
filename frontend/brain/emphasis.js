// What is present and what recedes: hover, selection, a search, a hidden lobe or synapse
// kind. Nothing here glows — emphasis is how solid a cell is, and firing is the only
// thing in the view that emits light.

import { Color3 } from "@babylonjs/core/Maths/math.color";

export function createEmphasis(graph) {
	const { nodes, edges, categories } = graph;
	const tintByCategory = new Map(
		categories.map((c) => {
			const color = Color3.FromHexString(c.color);
			return [c.id, [color.r, color.g, color.b]];
		}),
	);
	const fallback = [0.58, 0.6, 0.68];
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
	const edgeVisible = (i) => {
		const edge = edges[i];
		return !state.hiddenKinds.has(edge.kind) && nodeVisible(edge.source) && nodeVisible(edge.target);
	};

	function nodeState(i) {
		if (!nodeVisible(i)) return "hidden";
		if (state.matches) return state.matches.has(i) ? "hi" : "dim";
		const f = focus();
		if (f === -1) return "normal";
		if (i === f) return "hi";
		return neighbours[f].has(i) ? "hi" : "dim";
	}

	function edgeState(edge) {
		if (state.hiddenKinds.has(edge.kind) || !nodeVisible(edge.source) || !nodeVisible(edge.target)) return "hidden";
		if (state.matches) return state.matches.has(edge.source) && state.matches.has(edge.target) ? "hi" : "dim";
		const f = focus();
		if (f === -1) return "normal";
		return edge.source === f || edge.target === f ? "hi" : "dim";
	}

	return { state, nodeVisible, edgeVisible, tintOf, nodeState, edgeState, neighbours };
}
