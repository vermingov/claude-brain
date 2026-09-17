// What a hover or a click did, taken out of the stream of everything else that was happening.
//
// The harness that drove the page (dom-recording.ts) wrote a marker before each input it made.
// What follows a marker is mostly that input's doing — but not all of it, because a page does not
// hold still while it is poked: a star field keeps twinkling, a demo keeps typing. So a change is
// only given to the input when whatever it changed was not already moving on its own.
//
// Then a click is made whole. What was recorded is only what changed, and what changed depends on
// what came before: clicking the third tab after the second deactivates the second. Played back
// after the fourth was clicked, that would leave two tabs active. So the clicks on one control —
// the ones whose changes touch the same things, and those close by in the tree that changed
// nothing because they were already selected — start by putting everything else in that control
// back the way it was when they were recorded.

import type { DomRecording } from "./dom-recording";
import type { ComponentTree } from "./dom-geometry";
import { type RecordedOp, type TapeOp, played, stateKey } from "./dom-ops";
import type { Interaction } from "./dom-tapes";

/** A node or component that changed this recently before a probe was already moving… */
const RECENT_MS = 1_500;
/** …as was one changing on a beat, until it misses this many beats. */
const MISSED_BEATS = 1.5;
/** Changes closer together than this are one moment. */
const MOMENT_MS = 50;
/** Two clicked elements this close in the tree, or closer, are the same control: tabs, a toggle. */
const CONTROL_DISTANCE = 3;
/** A control is a handful of things that share a state. More than this and it is not a control. */
const CONTROL_MEMBERS = 12;
/** State touched by this share of all the clicks belongs to the page, not to any one control. */
const PAGE_WIDE = 0.3;

/**
 * The harness wrote a marker before each input. A change that follows it, up to the next marker,
 * belongs to that input unless its node — or, outside the probed element's own component, its
 * component — was already moving: changed just before, or changing on a beat that is not over.
 *
 * A click is then made whole. What was recorded is what changed, and what changed depends on
 * what came before: clicking the third tab after the second deactivates the second. Played after
 * the fourth, that leaves two tabs active. So clicks on one control — the ones whose changes touch
 * the same things, and those close by in the tree that changed nothing because they were already
 * selected — are given, at their start, the state everything else in that control was in when
 * they were recorded.
 */
export function interactionsOf(recording: DomRecording, tree: ComponentTree) {
	const nodeRhythm = new Map<number, Rhythm>();
	const anchorRhythm = new Map<number, Rhythm>();
	const claimed = new Set<unknown[]>();
	const probes: Array<{ target: number; on: Interaction["on"]; at: number; component: number; ops: RecordedOp[]; navigated?: boolean }> = [];
	let probe: (typeof probes)[number] | null = null;
	// Between a click that navigated and the page coming back, nothing is this page's behaviour.
	let navigating = false;

	const within = (id: number, root: number) => {
		for (let at = id; at !== -1; at = tree.parentOf(at)) if (at === root) return true;
		return false;
	};
	for (const op of recording.ops) {
		const t = op[0];
		if (op[1] === "m") {
			const kind = op[3] as string;
			if (kind === "navigated") {
				navigating = true;
				if (probe) {
					probe.navigated = true;
					probe.ops = [];
				}
			} else if (kind === "resumed") {
				navigating = false;
			}
			probe = null;
			if (kind === "hover" || kind === "leave" || kind === "click") {
				const target = op[2] as number;
				probe = { target, on: kind, at: t, component: tree.anchorOf(target), ops: [] };
				probes.push(probe);
			}
			continue;
		}
		if (navigating) {
			claimed.add(op);
			continue;
		}
		const node = op[2] as number;
		const anchor = tree.anchorOf(node);
		if (probe && !moving(nodeRhythm.get(node), t) && (within(node, probe.component) || !moving(anchorRhythm.get(anchor), t))) {
			probe.ops.push(op);
			claimed.add(op);
			continue;
		}
		beat(nodeRhythm, node, t);
		beat(anchorRhythm, anchor, t);
	}

	const state = stateTimeline(recording, tree);
	const clicks = probes.filter((p) => p.on === "click" && !p.navigated);
	const groups = controlsOf(clicks, tree);
	const interactions: Interaction[] = [];
	const taken = new Set<string>();
	for (const p of probes) {
		const key = `${p.on}:${p.target}`;
		if (taken.has(key) || p.navigated) continue;
		const ops = p.ops.map((op) => played(op, op[0] - p.at));
		if (p.on === "click") {
			const control = groups.get(p);
			if (control) {
				const own = new Set(p.ops.map((op) => state.keyOf(op)));
				const prefix: TapeOp[] = [];
				for (const k of control) if (!own.has(k)) prefix.push(...state.opAt(k, p.at));
				prefix.sort((x, y) => Number(y[1] === "c") - Number(x[1] === "c"));
				ops.unshift(...prefix);
			}
		}
		if (!ops.length) continue;
		taken.add(key);
		interactions.push({ target: p.target, on: p.on, ops });
	}
	return { interactions, claimed };
}

/** When something last changed, how often, and how far apart its changes typically are. */
interface Rhythm {
	last: number;
	count: number;
	gap: number;
}

function beat(rhythms: Map<number, Rhythm>, id: number, t: number): void {
	const rhythm = rhythms.get(id);
	if (!rhythm) {
		rhythms.set(id, { last: t, count: 1, gap: 0 });
		return;
	}
	const gap = t - rhythm.last;
	if (gap > MOMENT_MS) rhythm.gap = rhythm.count >= 2 ? rhythm.gap * 0.7 + gap * 0.3 : gap;
	rhythm.last = t;
	rhythm.count++;
}

function moving(rhythm: Rhythm | undefined, t: number): boolean {
	if (!rhythm) return false;
	const since = t - rhythm.last;
	return since <= RECENT_MS || (rhythm.count >= 3 && since <= rhythm.gap * MISSED_BEATS);
}

/** Clicks grouped into controls, each mapped to every state key its control touches. */
function controlsOf(clicks: Array<{ target: number; ops: RecordedOp[] }>, tree: ComponentTree): Map<object, Set<string>> {
	// State that nearly every click touches is the page's, not a control's: a layer that follows
	// the pointer, a class on the body. Left in, it ties every control on the page into one, and
	// then each of them carries the state of all the others — which is how a rebuild of a page of
	// interactive blocks came out twenty megabytes.
	const touchedBy = new Map<string, number>();
	for (const click of clicks) {
		for (const key of new Set(click.ops.map(stateKey))) {
			if (key) touchedBy.set(key, (touchedBy.get(key) ?? 0) + 1);
		}
	}
	const pageWide = new Set([...touchedBy].filter(([, n]) => n > Math.max(2, clicks.length * PAGE_WIDE)).map(([key]) => key));
	const keyOf = (op: RecordedOp) => {
		const key = stateKey(op);
		return key && pageWide.has(key) ? null : key;
	};
	const parentOf = clicks.map((_, i) => i);
	const root = (i: number): number => (parentOf[i] === i ? i : (parentOf[i] = root(parentOf[i]!)));
	const join = (i: number, j: number) => (parentOf[root(i)] = root(j));

	const byKey = new Map<string, number>();
	clicks.forEach((click, i) => {
		for (const op of click.ops) {
			const key = keyOf(op);
			if (!key) continue;
			if (byKey.has(key)) join(i, byKey.get(key)!);
			else byKey.set(key, i);
		}
	});
	// A click that changed nothing joins the control of a click close by that did.
	const ancestors = (id: number) => {
		const chain = [id];
		for (let at = tree.parentOf(id); at !== -1 && chain.length <= CONTROL_DISTANCE; at = tree.parentOf(at)) chain.push(at);
		return chain;
	};
	clicks.forEach((click, i) => {
		if (click.ops.length) return;
		const mine = ancestors(click.target);
		const near = clicks.findIndex((other, j) => j !== i && other.ops.length > 0 && ancestors(other.target).some((a) => mine.includes(a)));
		if (near >= 0) join(i, near);
	});

	const keys = new Map<number, Set<string>>();
	const members = new Map<number, number>();
	clicks.forEach((click, i) => {
		const r = root(i);
		members.set(r, (members.get(r) ?? 0) + 1);
		const set = keys.get(r) ?? new Set<string>();
		for (const op of click.ops) {
			const key = keyOf(op);
			if (key) set.add(key);
		}
		keys.set(r, set);
	});
	const out = new Map<object, Set<string>>();
	clicks.forEach((click, i) => {
		const r = root(i);
		const size = members.get(r) ?? 0;
		// One member is not a control, and a group the size of a page is not one either.
		if (size > 1 && size <= CONTROL_MEMBERS) out.set(click, keys.get(r)!);
	});
	return out;
}

/**
 * What every attribute, property, text run and subtree held at any moment, from the changes and
 * the values they replaced. A subtree that had not been replaced yet holds what the transplant
 * has, which the player reads from the page when it starts.
 */
function stateTimeline(recording: DomRecording, tree: ComponentTree) {
	const history = new Map<string, RecordedOp[]>();
	for (const op of recording.ops) {
		const key = stateKey(op);
		if (!key) continue;
		const list = history.get(key) ?? [];
		list.push(op);
		history.set(key, list);
	}
	const opAt = (key: string, t: number): TapeOp[] => {
		const list = history.get(key);
		if (!list?.length) return [];
		let last: RecordedOp | null = null;
		for (const op of list) {
			if (op[0] >= t) break;
			last = op;
		}
		const [kind, id, name] = [list[0]![1] as string, list[0]![2] as number, list[0]![3]];
		if (last) return [played(last, 0)];
		const first = list[0]!;
		switch (kind) {
			case "a":
			case "p":
				return first.length > 5 ? [[0, kind, id, name, first[5]]] : [];
			case "t":
				return first.length > 4 ? [[0, "t", id, first[4]]] : [];
			case "c":
				// Null markup: the subtree as the page was transplanted, numbered from its first child.
				return id >= 0 && id < tree.baselineNodes ? [[0, "c", id, null, id + 1]] : [];
			default:
				return [];
		}
	};
	return { keyOf: stateKey, opAt };
}
