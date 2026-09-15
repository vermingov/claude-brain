// Runs layoutGraph off the daemon's main thread, so a cold simulation over a few
// thousand notes never stalls a recall. One job per message; the result comes back as
// one flat array of (id, x, y, z), transferred rather than copied.

import { type LayoutEdge, type LayoutNode, layoutGraph } from "./graph-layout";

export interface LayoutJob {
	nodes: LayoutNode[];
	edges: LayoutEdge[];
	categories: string[];
	ticks?: number;
}

declare const self: Worker;

self.onmessage = (event: MessageEvent<LayoutJob>) => {
	const { nodes, edges, categories, ticks } = event.data;
	const positions = layoutGraph(nodes, edges, categories, ticks);
	const flat = new Float64Array(positions.size * 4);
	let i = 0;
	for (const [id, p] of positions) {
		flat[i++] = id;
		flat[i++] = p.x;
		flat[i++] = p.y;
		flat[i++] = p.z;
	}
	self.postMessage(flat, [flat.buffer]);
};
