// Signals travelling the synapses, so the brain visibly thinks. Their motion is a
// function of time in the vertex shader; the CPU only reseeds which edges they ride,
// every few seconds, and recolours them when emphasis changes.

import { createSpriteLayer } from "./sprites.js";

const SPARK_COUNT = 320;
const RESEED_MS = 4000;
/** How many sparks a recall sends out. */
const IGNITE_SPARKS = 24;
/** Sparks ride the explicit synapses; a similarity guess is not a signal path. */
const SIGNAL_KINDS = new Set(["wikilink", "cooccur", "timeline"]);

export function createSparks(scene, graph, tintOf) {
	const { nodes, edges } = graph;
	const signalEdges = edges.map((_, i) => i).filter((i) => SIGNAL_KINDS.has(edges[i].kind));
	const candidates = signalEdges.length > 0 ? signalEdges : edges.map((_, i) => i);
	const count = Math.min(SPARK_COUNT, candidates.length * 2);
	if (count === 0) return { restyle() {}, tick() {}, ignite() {}, setTime() {}, dispose() {} };

	const layer = createSpriteLayer(scene, {
		name: "sparks",
		count,
		vertex: "brainSpark",
		fragment: "brainGlow",
		additive: true,
		extraAttributes: ["target"],
	});
	const edgeOfSpark = new Int32Array(count);
	const currentPhases = new Float32Array(count);
	const currentSpeeds = new Float32Array(count);
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
		currentPhases.set(phases);
		currentSpeeds.set(speeds);
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

	/**
	 * A recall fires: sparks set out from the recalled notes along their synapses, starting
	 * at the note right now, faster than the ambient ones.
	 */
	function ignite(nodeIndexes, seconds) {
		const wanted = new Set(nodeIndexes);
		const outgoing = [];
		for (let e = 0; e < edges.length && outgoing.length < IGNITE_SPARKS; e++) {
			const edge = edges[e];
			if (wanted.has(edge.source)) outgoing.push([edge.source, edge.target, e]);
			else if (wanted.has(edge.target)) outgoing.push([edge.target, edge.source, e]);
		}
		if (outgoing.length === 0) return;
		const from = new Float32Array(count * 3);
		const to = new Float32Array(count * 3);
		const phases = new Float32Array(count);
		const speeds = new Float32Array(count);
		// Existing sparks keep their edges; the first few are re-aimed.
		for (let i = 0; i < count; i++) {
			const edge = edges[edgeOfSpark[i]];
			const s = nodes[edge.source];
			const t = nodes[edge.target];
			from.set([s.x, s.y, s.z], i * 3);
			to.set([t.x, t.y, t.z], i * 3);
			phases[i] = currentPhases[i];
			speeds[i] = currentSpeeds[i];
		}
		outgoing.forEach(([a, b, e], i) => {
			edgeOfSpark[i] = e;
			const s = nodes[a];
			const t = nodes[b];
			from.set([s.x, s.y, s.z], i * 3);
			to.set([t.x, t.y, t.z], i * 3);
			speeds[i] = 0.6;
			// fract(phase + time * speed) must be 0 now: start at the note.
			phases[i] = -((seconds * 0.6) % 1);
			currentPhases[i] = phases[i];
			currentSpeeds[i] = speeds[i];
		});
		layer.setPositions(from);
		layer.setVec3("target", to);
		layer.setPhases(phases);
		layer.setSizes(speeds);
		restyle(lastEdgeState);
	}

	function tick(now) {
		if (now - lastReseed < RESEED_MS) return;
		lastReseed = now;
		reseed();
	}

	return { restyle, tick, ignite, setTime: layer.setTime, dispose: layer.dispose };
}
