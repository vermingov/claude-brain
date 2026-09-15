// Force-directed layout with the anatomy of a brain: category lobes pinned onto the
// cortex of an ellipsoid, a shell force that keeps notes in the cortical band instead
// of the deep interior, and a longitudinal fissure between the hemispheres. Pure
// computation, no I/O — it runs in a worker thread on the daemon so the layout is
// computed once per change and served to every viewer, instead of every page load
// re-simulating three hundred ticks in the browser and freezing it meanwhile.

import { forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

export interface LayoutNode {
	id: number;
	category: string;
	connections: number;
	x?: number;
	y?: number;
	z?: number;
	vx?: number;
	vy?: number;
	vz?: number;
}

export interface LayoutEdge {
	source: number;
	target: number;
	kind: string;
}

export interface Point {
	x: number;
	y: number;
	z: number;
}

/** Ellipsoid the layout settles into: longer front-to-back than wide, wider than tall. */
export const BRAIN = { x: 150, y: 120, z: 200 };
/** The proportions above fit ~160 notes on the cortex; a bigger vault gets a bigger brain. */
const BRAIN_BASE_NOTES = 160;
const FISSURE_HALF_WIDTH = 14;
/** Notes live in the cortical shell, not the deep interior. */
const SHELL_INNER = 0.62;
const CLUSTER_STRENGTH = 0.9;
const CHARGE = -95;
export const COLD_TICKS = 300;
/** A warm start already has a picture; it only needs to absorb what changed. */
export const WARM_TICKS = 120;
const WARM_ALPHA = 0.45;
/** How far a new note lands from its lobe's anchor before the forces take over. */
const ARRIVAL_JITTER = 40;

/** Rest length per edge kind: a wikilink pulls notes close, a similarity guess less so. */
const LINK_DISTANCE: Record<string, number> = { wikilink: 55, cooccur: 60, timeline: 85, semantic: 90, tag: 100 };
/**
 * Derived edges shape the layout gently; explicit links decide it. Similarity edges
 * outnumber wikilinks two to one on a real vault, and at a quarter strength they still
 * pulled everything into one ball — the anatomy needs them nearly silent.
 */
const LINK_STRENGTH: Record<string, number> = { wikilink: 1, cooccur: 0.6, timeline: 0.5, semantic: 0.08, tag: 0.04 };

export const ROOT_CATEGORY = "__root__";

/**
 * The lobe a note belongs to: its top-level folder, minus any ordering prefix, so a vault
 * that grew "00 Notes" beside "Notes" gets one Notes lobe and one legend entry, not two.
 */
export function lobeOf(path: string): string {
	if (!path.includes("/")) return ROOT_CATEGORY;
	const folder = path.split("/")[0]!;
	return folder.replace(/^\d+[\s._-]+/, "") || folder;
}

/**
 * Golden-spiral points on the upper cortex of the ellipsoid, mirrored into alternating
 * hemispheres so lobes spread over both sides instead of stacking on one.
 */
export function categoryAnchors(categories: string[], scale = 1): Map<string, Point> {
	const golden = Math.PI * (3 - Math.sqrt(5));
	return new Map(
		categories.map((category, i) => {
			const y = 0.15 + (i / Math.max(categories.length - 1, 1)) * 0.8;
			const r = Math.sqrt(Math.max(0, 1 - y * y));
			const theta = golden * i;
			const side = i % 2 === 0 ? 1 : -1;
			return [
				category,
				{
					x: side * Math.max(Math.abs(Math.cos(theta) * r) * BRAIN.x * scale, FISSURE_HALF_WIDTH * 2.5),
					y: y * BRAIN.y * scale,
					z: Math.sin(theta) * r * BRAIN.z * scale,
				},
			];
		}),
	);
}

/** Small deterministic generator, so the same vault lays out the same way twice. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/** Cube-root growth: volume scales with the vault, so the cortex keeps its density. */
export function brainScale(noteCount: number): number {
	return Math.max(1, Math.cbrt(noteCount / BRAIN_BASE_NOTES));
}

function anatomyForce(nodes: LayoutNode[], anchors: Map<string, Point>, scale: number): (alpha: number) => void {
	const brain = { x: BRAIN.x * scale, y: BRAIN.y * scale, z: BRAIN.z * scale };
	return (alpha) => {
		for (const node of nodes) {
			const anchor = anchors.get(node.category);
			if (anchor) {
				// An unlinked note has nothing else holding it; the lobe holds it harder.
				const k = (node.connections === 0 ? 3 : 1) * CLUSTER_STRENGTH * alpha * 0.05;
				node.vx! += (anchor.x - node.x!) * k;
				node.vy! += (anchor.y - node.y!) * k;
				node.vz! += (anchor.z - node.z!) * k;
			}
			// Cortical shell: radial push toward the [SHELL_INNER, 1] band of the ellipsoid.
			const ex = node.x! / brain.x;
			const ey = node.y! / brain.y;
			const ez = node.z! / brain.z;
			const e = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6;
			const shellK = 0.6 * alpha;
			if (e > 1) {
				node.vx! -= node.x! * (1 - 1 / e) * shellK;
				node.vy! -= node.y! * (1 - 1 / e) * shellK;
				node.vz! -= node.z! * (1 - 1 / e) * shellK;
			} else if (e < SHELL_INNER) {
				const out = (SHELL_INNER / e - 1) * shellK;
				node.vx! += node.x! * out;
				node.vy! += node.y! * out;
				node.vz! += node.z! * out;
			}
			// Longitudinal fissure: keep the hemisphere gap clear.
			if (Math.abs(node.x!) < FISSURE_HALF_WIDTH) {
				node.vx! += (node.x! >= 0 ? 1 : -1) * (FISSURE_HALF_WIDTH - Math.abs(node.x!)) * alpha * 0.9;
			}
		}
	};
}

/**
 * Lay the graph out. Nodes that arrive with a position keep it and the run is a warm
 * one: fewer ticks, lower energy, so a vault that gained three notes moves three notes.
 * Nodes without one start beside their lobe's anchor rather than at the origin.
 */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], categories: string[], ticks?: number): Map<number, Point> {
	const scale = brainScale(nodes.length);
	const anchors = categoryAnchors(categories, scale);
	const warm = nodes.some((n) => n.x !== undefined);
	const random = lcg(nodes.length * 7919 + edges.length);
	for (const node of nodes) {
		if (node.x !== undefined) continue;
		const anchor = anchors.get(node.category) ?? { x: 0, y: 0, z: 0 };
		node.x = anchor.x + (random() - 0.5) * ARRIVAL_JITTER;
		node.y = anchor.y + (random() - 0.5) * ARRIVAL_JITTER;
		node.z = anchor.z + (random() - 0.5) * ARRIVAL_JITTER;
	}

	const known = new Set(nodes.map((n) => n.id));
	const degree = new Map<number, number>();
	const links = edges
		.filter((e) => known.has(e.source) && known.has(e.target))
		.map((e) => {
			degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
			degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
			return { source: e.source, target: e.target, kind: e.kind };
		});
	// d3's default strength divides by the smaller degree so hubs don't collapse; the
	// per-kind factor keeps derived edges from outvoting wikilinks by sheer number.
	const strength = (link: { source: { id: number }; target: { id: number }; kind: string }) =>
		(LINK_STRENGTH[link.kind] ?? 0.3) / Math.min(degree.get(link.source.id) ?? 1, degree.get(link.target.id) ?? 1);

	const simulation = forceSimulation(nodes, 3)
		.force(
			"link",
			forceLink<LayoutNode>(links)
				.id((d) => d.id)
				.distance((l: { kind: string }) => LINK_DISTANCE[l.kind] ?? 60)
				.strength(strength as never),
		)
		.force("charge", forceManyBody().strength(CHARGE))
		.force("anatomy", anatomyForce(nodes, anchors, scale))
		.alpha(warm ? WARM_ALPHA : 1)
		.stop();
	const rounds = ticks ?? (warm ? WARM_TICKS : COLD_TICKS);
	for (let i = 0; i < rounds; i++) simulation.tick();
	return new Map(nodes.map((n) => [n.id, { x: n.x!, y: n.y!, z: n.z! }]));
}
