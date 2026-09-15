// Spreading activation over the association graph. Retrieval in a brain doesn't stop at
// what matched the cue — activation flows outward along associations, which is why
// remembering one thing hands you the neighbouring thing you didn't ask for.
//
// Every edge kind conducts, not only wikilinks. Two thirds of a real vault is never
// wikilinked — quick captures, journals, imported notes — but almost all of it has a
// similarity, tag or co-recall edge (graph.ts), and an association the author never
// wrote down is still an association. A wikilink conducts best; the derived kinds in
// proportion to the evidence behind them.

import { EDGE_WEIGHT } from "./graph";
import { openBrainDb } from "./index-db";

/** Fraction of a seed's score that reaches a neighbour before fan-out is divided out. */
const SPREAD_RATIO = 0.35;
/** Seeds worth spreading from — activation is a limited budget, weak cues don't spread. */
const MAX_SEEDS = 5;

export interface SpreadHit {
	docId: number;
	score: number;
	/** The matched note this one came in through, for explaining the association. */
	viaDocId: number;
}

interface Edge {
	from: number;
	to: number;
	weight: number;
}

/** Every edge touching one of `ids`, walkable both ways, weighted by how well it conducts. */
function edgesAround(ids: number[]): Edge[] {
	const { db } = openBrainDb();
	const list = ids.map(() => "?").join(",");
	const rows = db
		.query(
			`SELECT source_doc AS a, target_doc AS b, 'wikilink' AS kind, 1.0 AS w FROM links
			 WHERE source_doc IN (${list}) OR target_doc IN (${list})
			 UNION ALL
			 SELECT source_doc, target_doc, kind, weight FROM derived_links
			 WHERE source_doc IN (${list}) OR target_doc IN (${list})`,
		)
		.all(...ids, ...ids, ...ids, ...ids) as Array<{ a: number; b: number; kind: string; w: number }>;
	const out: Edge[] = [];
	for (const row of rows) {
		// Same scale as graph.adjacency(): a similarity edge carries its cosine, discounted;
		// tag, timeline and co-recall edges were stored at their final weight.
		const weight =
			row.kind === "wikilink" ? EDGE_WEIGHT.wikilink! : row.kind === "semantic" ? EDGE_WEIGHT.semantic! * row.w : row.w;
		out.push({ from: row.a, to: row.b, weight }, { from: row.b, to: row.a, weight });
	}
	return out;
}

/**
 * One hop out from the strongest matches. A seed's contribution is divided by the square
 * root of its weighted degree, so a hub touching forty notes doesn't flood the result —
 * the same fan-out normalisation that keeps spreading-activation models stable.
 */
export function spreadActivation(seeds: Map<number, number>, limit = 3): SpreadHit[] {
	const top = [...seeds.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEDS);
	if (top.length === 0 || limit <= 0) return [];

	const strength = new Map<number, number>();
	const outgoing = new Map<number, Edge[]>();
	for (const edge of edgesAround(top.map(([id]) => id))) {
		if (!seeds.has(edge.from)) continue;
		strength.set(edge.from, (strength.get(edge.from) ?? 0) + edge.weight);
		const list = outgoing.get(edge.from) ?? [];
		list.push(edge);
		outgoing.set(edge.from, list);
	}

	const received = new Map<number, SpreadHit>();
	for (const [seedId, seedScore] of top) {
		const damping = SPREAD_RATIO / Math.sqrt(strength.get(seedId) ?? 1);
		for (const edge of outgoing.get(seedId) ?? []) {
			if (seeds.has(edge.to)) continue;
			const score = seedScore * damping * edge.weight;
			const prev = received.get(edge.to);
			// Several seeds pointing at the same note is itself evidence — take the
			// strongest path rather than summing, which would over-reward hubs again.
			if (!prev || score > prev.score) received.set(edge.to, { docId: edge.to, score, viaDocId: seedId });
		}
	}

	return [...received.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
