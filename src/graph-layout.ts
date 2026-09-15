// Force-directed layout with the anatomy of a brain: every note is held on the cortex of
// a procedural brain (brain-surface.ts) — two folded hemispheres, cerebellum, brainstem —
// and each folder gathers in an anatomical region, the biggest folders taking the
// frontal and parietal lobes. Links and charge move notes along the surface; the field
// keeps them on it. Pure computation, no I/O — it runs in a worker thread on the daemon
// so the layout is computed once per change and served to every viewer, instead of
// every page load re-simulating three hundred ticks in the browser.

import { forceLink, forceManyBody, forceSimulation } from "d3-force-3d";
import { brainGradient, type BrainShape, projectToSurface, regionAnchor } from "./brain-surface";

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

/** Semi-axes of the cerebrum: longer front-to-back than wide, wider than tall. */
export const BRAIN = { x: 150, y: 120, z: 200 };
/** The proportions above fit ~160 notes on the cortex; a bigger vault gets a bigger brain. */
const BRAIN_BASE_NOTES = 160;
const CLUSTER_STRENGTH = 0.9;
/** How hard the field pulls a drifting note back onto the cortex, per tick. */
const SURFACE_STIFFNESS = 0.5;
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

export function brainShape(scale: number): BrainShape {
	return { ax: BRAIN.x * scale, ay: BRAIN.y * scale, az: BRAIN.z * scale };
}

/**
 * One anatomical region per lobe, largest lobes first, alternating hemispheres, so the
 * folders that hold most of the vault take the frontal and parietal cortex and a
 * two-note folder ends up somewhere small.
 */
export function categoryAnchors(categories: string[], scale = 1, sizes = new Map<string, number>()): Map<string, Point> {
	const shape = brainShape(scale);
	const ranked = [...categories].sort((a, b) => (sizes.get(b) ?? 0) - (sizes.get(a) ?? 0) || a.localeCompare(b));
	return new Map(ranked.map((category, rank) => [category, regionAnchor(rank, shape)]));
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

function anatomyForce(nodes: LayoutNode[], anchors: Map<string, Point>, shape: BrainShape): (alpha: number) => void {
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
			// The cortex: whatever the other forces did this tick, walk back toward the surface.
			const { value, normal } = brainGradient({ x: node.x!, y: node.y!, z: node.z! }, shape);
			node.vx! -= normal.x * value * SURFACE_STIFFNESS;
			node.vy! -= normal.y * value * SURFACE_STIFFNESS;
			node.vz! -= normal.z * value * SURFACE_STIFFNESS;
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
	const shape = brainShape(scale);
	const sizes = new Map<string, number>();
	for (const node of nodes) sizes.set(node.category, (sizes.get(node.category) ?? 0) + 1);
	const anchors = categoryAnchors(categories, scale, sizes);
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
		.force("anatomy", anatomyForce(nodes, anchors, shape))
		.alpha(warm ? WARM_ALPHA : 1)
		.stop();
	const rounds = ticks ?? (warm ? WARM_TICKS : COLD_TICKS);
	for (let i = 0; i < rounds; i++) simulation.tick();
	// Settle every note exactly onto the cortex; the field's folds are the picture.
	return new Map(nodes.map((n) => [n.id, projectToSurface({ x: n.x!, y: n.y!, z: n.z! }, shape)]));
}
