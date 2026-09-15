// Signals travelling the synapses, so the brain visibly thinks. Their motion is a
// function of time in the vertex shader; the CPU only reseeds which edges they ride,
// every few seconds, and recolours them when emphasis changes.

import { createSpriteLayer } from "./sprites.js";

const SPARK_COUNT = 320;
const RESEED_MS = 4000;
/** Sparks ride the explicit synapses; a similarity guess is not a signal path. */
const SIGNAL_KINDS = new Set(["wikilink", "cooccur", "timeline"]);

export function createSparks(scene, graph, tintOf) {
	const { nodes, edges } = graph;
	const signalEdges = edges.map((_, i) => i).filter((i) => SIGNAL_KINDS.has(edges[i].kind));
	const candidates = signalEdges.length > 0 ? signalEdges : edges.map((_, i) => i);
	const count = Math.min(SPARK_COUNT, candidates.length * 2);
	if (count === 0) return { restyle() {}, tick() {}, setTime() {}, dispose() {} };

	const layer = createSpriteLayer(scene, {
		name: "sparks",
		count,
		vertex: "brainSpark",
		fragment: "brainGlow",
		additive: true,
		extraAttributes: ["target"],
	});
	const edgeOfSpark = new Int32Array(count);
	let lastReseed = 0;
	let lastEdgeState = () => "normal";

	function reseed() {
		const from = new Float32Array(count * 3);
		const to = new Float32Array(count * 3);
		const phases = new Float32Array(count);
		const speeds = new Float32Array(count);
		for (let i = 0; i < count; i++) {
			const edge = candidates[Math.floor(Math.random() * candidates.length)];
			edgeOfSpark[i] = edge;
			const s = nodes[edges[edge].source];
			const t = nodes[edges[edge].target];
			from.set([s.x, s.y, s.z], i * 3);
			to.set([t.x, t.y, t.z], i * 3);
			phases[i] = Math.random();
			speeds[i] = 0.1 + Math.random() * 0.2;
		}
		layer.setPositions(from);
		layer.setVec3("target", to);
		layer.setPhases(phases);
		layer.setSizes(speeds);
		restyle(lastEdgeState);
	}

	function restyle(edgeState) {
		lastEdgeState = edgeState;
		const tints = new Float32Array(count * 4);
		for (let i = 0; i < count; i++) {
			const e = edges[edgeOfSpark[i]];
			const state = edgeState(e);
			const base = tintOf(nodes[e.source]);
			const alpha = state === "hidden" ? 0 : state === "dim" ? 0.04 : state === "hi" ? 0.9 : 0.45;
			tints.set([base[0], base[1], base[2], alpha], i * 4);
		}
		layer.setTints(tints);
	}

	function tick(now) {
		if (now - lastReseed < RESEED_MS) return;
		lastReseed = now;
		reseed();
	}

	return { restyle, tick, setTime: layer.setTime, dispose: layer.dispose };
}
