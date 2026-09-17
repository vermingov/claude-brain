// Where every element was on the page, what counts as one component, and when each was on screen.
//
// A behaviour recording says a change happened to node 1412 at a moment. Turning that into
// something a rebuild can play needs two things this holds: which element the change belongs to —
// the component around it — and, from the recorded scroll positions and the boxes measured at the
// baseline, whether that element was in view at the time, and how much of it.

import type { DomRecording } from "./dom-recording";
import { type RecordedOp, stateKey } from "./dom-ops";

/** The tallest a component may be, as a share of the viewport, before climbing stops. */
const COMPONENT_HEIGHT = 1.2;
/** A change this soon after the page scrolled was the page reacting to the scroll. */
const SCROLL_REACTION_MS = 300;

export interface ComponentTree {
	parentOf(id: number): number;
	anchorOf(id: number): number;
	box: Map<number, [number, number]>;
	/** Node ids made by a replaced subtree, stated relative to that replacement, for comparing cycles. */
	stableId(id: number): string;
	baselineNodes: number;
}

export function componentTree(recording: DomRecording): ComponentTree {
	const vh = recording.viewport.height;
	const parent = new Map<number, number>();
	const box = new Map<number, [number, number]>();
	for (const [id, parentId, top, bottom] of recording.rects) {
		parent.set(id, parentId);
		if (top >= 0 && bottom > top) box.set(id, [top, bottom]);
	}
	// Nodes numbered after the baseline belong to whichever subtree was re-serialised to make them.
	const rebuilt = recording.ops
		.filter((op) => op[1] === "c")
		.map((op) => ({ parent: op[2] as number, first: op[4] as number }))
		.sort((a, b) => a.first - b.first);
	const ownerOf = (id: number) => {
		let owner: { parent: number; first: number } | null = null;
		for (const r of rebuilt) {
			if (r.first > id) break;
			owner = r;
		}
		return owner;
	};
	const parentOf = (id: number): number => (parent.has(id) ? parent.get(id)! : (ownerOf(id)?.parent ?? -1));
	const anchorOf = (id: number): number => {
		let at = id;
		while (at !== -1 && !box.has(at)) at = parentOf(at);
		if (at === -1) return -1;
		// Climb while the next box up is still component-sized.
		for (;;) {
			let up = parentOf(at);
			while (up !== -1 && !box.has(up)) up = parentOf(up);
			if (up === -1) return at;
			const [top, bottom] = box.get(up)!;
			if (bottom - top > vh * COMPONENT_HEIGHT) return at;
			at = up;
		}
	};
	const stableId = (id: number) => {
		if (parent.has(id) || id < 0) return String(id);
		const owner = ownerOf(id);
		return owner ? `${owner.parent}+${id - owner.first}` : String(id);
	};
	return { parentOf, anchorOf, box, stableId, baselineNodes: recording.rects.length };
}

export type Visibility = ReturnType<typeof visibilityOf>;

/** When an anchor was on screen, and what the page was doing to the scroll around a moment. */
export function visibilityOf(recording: DomRecording, tree: ComponentTree) {
	const vh = recording.viewport.height;
	const scrollAt = (t: number): number => {
		let y = 0;
		for (const [time, value] of recording.scroll) {
			if (time > t) break;
			y = value;
		}
		return y;
	};
	/** How much of a box is showing with the page scrolled to y, from 0 to 1. */
	const shareShowing = (box: [number, number], y: number) => Math.max(0, Math.min(box[1], y + vh) - Math.max(box[0], y)) / (box[1] - box[0]);
	const inView = (box: [number, number], y: number, threshold: number) => (threshold > 0 ? shareShowing(box, y) >= threshold : shareShowing(box, y) > 0);
	const visibleAt = (anchor: number, t: number, threshold: number): boolean => anchor === -1 || inView(tree.box.get(anchor)!, scrollAt(t), threshold);
	/** Where the page was scrolled from and to, when t came right after a scroll; null otherwise. */
	const scrolledJustBefore = (t: number): [number, number] | null => {
		const [from, to] = [scrollAt(t - SCROLL_REACTION_MS), scrollAt(t)];
		return from === to ? null : [from, to];
	};
	// Every moment an anchor came into view or left it.
	const episodesOf = (anchor: number, threshold: number): Array<{ enter: number; exit: number }> => {
		const changes = [recording.base, ...recording.scroll.map(([t]) => t)].sort((a, b) => a - b);
		const out: Array<{ enter: number; exit: number }> = [];
		let visible = false;
		for (const t of changes) {
			const now = visibleAt(anchor, t, threshold);
			if (now && !visible) out.push({ enter: t, exit: Number.POSITIVE_INFINITY });
			if (!now && visible) out[out.length - 1]!.exit = t;
			visible = now;
		}
		return out;
	};
	return { episodesOf, scrolledJustBefore, shareShowing };
}

/**
 * The state that only ever changed right after a scroll, mapped to the box it was reacting to and
 * the share of that box that had to be showing. The box is the nearest one, from the changed
 * element up, whose showing share every one of those scrolls moved; the threshold lies above what
 * was showing before each entry and at or below what was showing after it, and the same the other
 * way round for each exit.
 */
export function scrollReactions(recording: DomRecording, tree: ComponentTree, visibility: Visibility, claimed: Set<unknown[]>) {
	const changes = new Map<string, RecordedOp[]>();
	for (const op of recording.ops) {
		const key = stateKey(op);
		if (!key || claimed.has(op)) continue;
		const list = changes.get(key) ?? [];
		list.push(op);
		changes.set(key, list);
	}
	const reactive = new Map<string, { anchor: number; threshold: number }>();
	for (const [key, ops] of changes) {
		if (ops.length < 2) continue;
		const scrolls = ops.map((op) => visibility.scrolledJustBefore(op[0]));
		if (scrolls.some((scroll) => !scroll)) continue;
		for (let at = ops[0]![2] as number; at !== -1; at = tree.parentOf(at)) {
			const box = tree.box.get(at);
			if (!box) continue;
			let [low, high] = [0, 1];
			for (const [from, to] of scrolls as Array<[number, number]>) {
				const [before, after] = [visibility.shareShowing(box, from), visibility.shareShowing(box, to)];
				if (Math.abs(before - after) < 0.01) {
					low = high;
					break;
				}
				low = Math.max(low, Math.min(before, after));
				high = Math.min(high, Math.max(before, after));
			}
			if (low < high) {
				reactive.set(key, { anchor: at, threshold: low === 0 ? 0 : Math.round(((low + high) / 2) * 100) / 100 });
				break;
			}
		}
	}
	return reactive;
}
