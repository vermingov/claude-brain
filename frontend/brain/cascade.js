// How a signal spreads. A recall names a few notes; a brain does not light those and stop
// — activation leaves them along their synapses, arrives at the neighbours a moment later
// depending on how far and how strong the connection is, fires those, and dies out a few
// hops from where it started.
//
// The whole cascade is planned in one go, with times in the future, so the GPU animates
// it from a single buffer write and the main thread does nothing while it runs.

/** How well each kind of synapse conducts: an explicit link carries, a tag barely does. */
export const CONDUCTANCE = { wikilink: 1, cooccur: 0.75, timeline: 0.55, semantic: 0.35, tag: 0.25 };
/**
 * Layout units per second. Slow enough to watch: a typical synapse takes about a third
 * of a second to cross, so a three-hop volley is a wave you can follow rather than a
 * blink. Real axons are faster; legibility wins.
 */
const VELOCITY = 260;
const MIN_TRAVEL = 0.12;
const MAX_TRAVEL = 0.8;
/** Every hop loses this much, before the synapse's own conductance. */
const HOP_LOSS = 0.62;
/** Below this a signal is spent. */
const FLOOR = 0.14;
const MAX_HOPS = 3;
/** Synapses one note fires down at once, strongest first. */
const FANOUT = 4;
/** Notes named by one recall fire in a run, not all on the same frame. */
const SEED_STAGGER = 0.12;
/** Ceiling on a single spike, so excitability brightens without blowing out. */
const MAX_GAIN = 1.5;

function travelTime(length) {
	return Math.min(MAX_TRAVEL, Math.max(MIN_TRAVEL, length / VELOCITY));
}

/**
 * Per-note synapse lists, sorted by conductance, with each synapse's length. Built once
 * for a graph and reused by every volley.
 */
export function buildConduction(graph) {
	const adjacency = graph.nodes.map(() => []);
	graph.edges.forEach((edge, index) => {
		const source = graph.nodes[edge.source];
		const target = graph.nodes[edge.target];
		const length = Math.hypot(source.x - target.x, source.y - target.y, source.z - target.z);
		const conductance = CONDUCTANCE[edge.kind] ?? 0.3;
		adjacency[edge.source].push({ edge: index, other: edge.target, forward: true, length, conductance });
		adjacency[edge.target].push({ edge: index, other: edge.source, forward: false, length, conductance });
	});
	for (const list of adjacency) list.sort((a, b) => b.conductance - a.conductance);
	return adjacency;
}

/**
 * Plan the volley a set of recalled notes sets off.
 *
 * @param {Array<Array<object>>} adjacency  from buildConduction
 * @param {number[]} seeds  node indexes the recall returned
 * @param {object} [options]
 * @param {number} [options.now]  seconds, the clock the shaders read
 * @param {(edge: number) => boolean} [options.passes]  false for a synapse kind switched off
 * @param {number[]} [options.excitability]  0..1 per node; a well-worn memory fires harder
 * @param {number} [options.limit]  impulse pool size
 * @returns {{ fires: Array<{node: number, at: number, gain: number}>,
 *             impulses: Array<{edge: number, forward: boolean, at: number, travel: number, gain: number}> }}
 */
export function planVolley(adjacency, seeds, options = {}) {
	const { now = 0, passes = () => true, excitability, limit = 256 } = options;
	const fires = [];
	const impulses = [];
	const fired = new Set();
	const queue = seeds.map((node, i) => ({ node, at: now + i * SEED_STAGGER, strength: 1, hop: 0 }));

	while (queue.length > 0 && impulses.length < limit) {
		// Earliest arrival first, so a note fires once, when the first signal reaches it.
		let next = 0;
		for (let i = 1; i < queue.length; i++) if (queue[i].at < queue[next].at) next = i;
		const step = queue.splice(next, 1)[0];
		if (fired.has(step.node)) continue;
		fired.add(step.node);
		// A well-worn memory fires harder than a cold one, seeds included: gain past 1 is
		// a bigger, brighter spike, which the shaders take in their stride.
		const gain = Math.min(MAX_GAIN, step.strength * (1 + 0.5 * (excitability?.[step.node] ?? 0)));
		fires.push({ node: step.node, at: step.at, gain });
		if (step.hop >= MAX_HOPS) continue;

		let sent = 0;
		for (const link of adjacency[step.node] ?? []) {
			if (sent >= FANOUT || impulses.length >= limit) break;
			if (fired.has(link.other) || !passes(link.edge)) continue;
			const strength = step.strength * HOP_LOSS * link.conductance;
			if (strength < FLOOR) continue;
			const travel = travelTime(link.length);
			impulses.push({ edge: link.edge, forward: link.forward, at: step.at, travel, gain: strength });
			queue.push({ node: link.other, at: step.at + travel, strength, hop: step.hop + 1 });
			sent++;
		}
	}
	return { fires, impulses };
}

/**
 * A signal down one known route, hop by hop — what `claude-brain path` actually walked.
 * No branching: this is a traversal, not a recall.
 */
export function planRoute(adjacency, route, options = {}) {
	const { now = 0 } = options;
	if (route.length === 0) return { fires: [], impulses: [] };
	const fires = [{ node: route[0], at: now, gain: 1 }];
	const impulses = [];
	let at = now;
	for (let i = 1; i < route.length; i++) {
		const link = (adjacency[route[i - 1]] ?? []).find((candidate) => candidate.other === route[i]);
		// A hop the client's graph does not carry still advances the clock, so the notes
		// light in the right order even if that synapse is filtered out of the view.
		const travel = link ? travelTime(link.length) : 0.25;
		if (link) impulses.push({ edge: link.edge, forward: link.forward, at, travel, gain: 1 });
		at += travel;
		fires.push({ node: route[i], at, gain: 1 });
	}
	return { fires, impulses };
}
