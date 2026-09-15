// The travelling signals themselves: a fixed pool of one-shot sprites. Firing a volley
// writes each signal's endpoints and its window into the pool and uploads once; the
// shader animates the run and culls the slot the moment it is over.

import { createSpriteLayer } from "./sprites.js";

const POOL = 384;
const RADIUS = 4.2;

export function createImpulseLayer(scene, graph, tintOf) {
	const { nodes, edges } = graph;
	const layer = createSpriteLayer(scene, {
		name: "impulses",
		count: POOL,
		vertex: "brainImpulse",
		fragment: "brainGlow",
		blend: "add",
		attributes: [
			{ name: "target", size: 3 },
			{ name: "fireAt", size: 1 },
			{ name: "travel", size: 1 },
		],
		renderingGroup: 2,
	});
	const from = new Float32Array(POOL * 3);
	const to = new Float32Array(POOL * 3);
	const tints = new Float32Array(POOL * 4);
	const sizes = new Float32Array(POOL).fill(RADIUS);
	const fireAt = new Float32Array(POOL).fill(-1e9);
	const travel = new Float32Array(POOL).fill(1);
	layer.set("size", sizes);
	layer.set("fireAt", fireAt);
	layer.set("travel", travel);
	let cursor = 0;

	/** @param {Array<{edge: number, forward: boolean, at: number, travel: number, gain: number}>} impulses */
	function fire(impulses) {
		if (impulses.length === 0) return;
		for (const impulse of impulses) {
			const edge = edges[impulse.edge];
			const source = nodes[impulse.forward ? edge.source : edge.target];
			const target = nodes[impulse.forward ? edge.target : edge.source];
			const slot = cursor % POOL;
			cursor++;
			from.set([source.x, source.y, source.z], slot * 3);
			to.set([target.x, target.y, target.z], slot * 3);
			const tint = tintOf(source);
			// A weaker signal is a dimmer one, so a cascade visibly fades as it spreads.
			tints.set([tint[0], tint[1], tint[2], 0.35 + 0.65 * impulse.gain], slot * 4);
			fireAt[slot] = impulse.at;
			travel[slot] = impulse.travel;
		}
		layer.set("position", from);
		layer.set("target", to);
		layer.set("tint", tints);
		layer.set("fireAt", fireAt);
		layer.set("travel", travel);
	}

	return { fire, setTime: layer.setTime, setArrivals: layer.setArrivals, dispose: layer.dispose };
}
