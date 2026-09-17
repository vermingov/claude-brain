// From a recording of everything a page's script did to its DOM, to tapes a rebuild can play.
//
// A recorded change says what happened and when. What a rebuild needs is what set it off,
// because the person reading the rebuild will not scroll the way the capture did. So each change
// is filed under the component it belongs to, and that component's time on screen is worked out
// from the recorded scroll position and where the component sat on the page:
//
//   ambient    what kept changing while nobody could see it — a star field that twinkles, a
//              ticker — runs on its own clock, and plays from page load. Judged one piece of state
//              at a time, because a section can hold both: stars that never stop above a demo that
//              waits to be looked at.
//   before     changes to any other component before it was ever on screen: an image loading.
//   on enter   changes after the component came into view, timed from that moment: a demo that
//              starts typing, cards that light up in turn. One set per time it entered, so a page
//              that plays something differently the second time round does so here too.
//   on exit    changes in the moments after it left: a class taken away, a demo reset.
//   while seen a carousel that turns every few seconds and stops when it is scrolled away, then
//              carries on where it left off rather than starting again. Its clock is the time the
//              component has spent on screen, and nothing else.
//
// What was still going when the watching stopped — the ambient clock at the end of the recording,
// a demo still typing when it scrolled away — did not stop on the page, so it does not stop in
// the rebuild: it loops, on the cycle the recording shows when there is one, over what was seen
// when there is not.
//
// And what a hover or a click did is kept apart from all of that (see the interactions below).
//
// "The component" is the change's own element, climbed up to the largest ancestor that is still
// no taller than about a screen. That keeps the parts of one demo on one clock — the field that is
// typed into and the list that filters are the same thing starting — without tying a demo to the
// page itself, which is always in view and would make everything play at load.
//
// Except for what only ever changed right after a scroll. That was the page reacting to something
// coming into or out of view, and a page's observer watches what it animates, often more closely
// than the component around it: a figure that activates once most of it is showing and
// deactivates the moment it leaves, inside a section still on screen. Such changes are filed under
// the nearest box, from the changed element up, whose visible share every one of those scrolls
// moved, with the share it had to reach — the threshold the rebuild's observer uses.

import type { DomRecording } from "./dom-recording";
import { type ComponentTree, componentTree, scrollReactions, visibilityOf } from "./dom-geometry";
import { interactionsOf } from "./dom-interactions";
import { PLAYED_LENGTH, type RecordedOp, type TapeOp, played, stateKey } from "./dom-ops";

export type { TapeOp };

/** From this delay on, the ops play again every `period` milliseconds. */
export type Loop = [from: number, period: number];

export interface Tape {
	/** The element whose visibility starts this tape; -1 is the page itself. */
	anchor: number;
	/** The share of the anchor that has to be showing for it to count as in view; 0 is any of it. */
	threshold?: number;
	before: TapeOp[];
	/** Set when `before` is ambient behaviour that was still running when the recording stopped. */
	loop?: Loop;
	/** Behaviour that runs only while the anchor is on screen, timed by how long it has been. */
	whileSeen?: { ops: TapeOp[]; loop?: Loop };
	episodes: Array<{ enter: TapeOp[]; exit: TapeOp[]; loop?: Loop }>;
}

/** What a hover, a pointer leaving, or a click on one element did, timed from the input. */
export interface Interaction {
	target: number;
	on: "hover" | "leave" | "click";
	ops: TapeOp[];
}

export interface DomTapes {
	tapes: Tape[];
	interactions: Interaction[];
	/** Recorded changes that were dropped, and why, for the notes. */
	skipped: Record<string, number>;
}

/** How long after leaving view a change still counts as a reaction to leaving. */
const EXIT_WINDOW_MS = 1_500;
/** A change this soon after the page scrolled was the page reacting to the scroll. */
const SCROLL_REACTION_MS = 300;
/** A component that changed this often out of view runs on its own clock. */
const AMBIENT_OPS = 5;
const AMBIENT_SPAN_MS = 3_000;
/** How many changes at the start of a visit are compared to decide whether it plays again. */
const RESTART_OPS = 4;
/** A loop needs something changed at least this often, over at least this long. */
const LOOP_REPEATS = 3;
const LOOP_MIN_MS = 2_000;
/** Activity that ended longer ago than this before the watching stopped, had stopped… */
const STILL_GOING_MS = 1_500;
/** …unless it was still within this many turns of its own cycle. */
const MISSED_CYCLES = 1.5;
/** …unless it had run so long that a pause this share of its length is nothing. */
const RAN_SHARE = 0.05;
/** Changes closer together than this are one moment. */
const MOMENT_MS = 50;

export function buildTapes(recording: DomRecording): DomTapes {
	const tree = componentTree(recording);
	const end = recording.end ?? Math.max(recording.base, ...recording.ops.map((op) => op[0]), ...recording.scroll.map(([t]) => t));
	const visibility = visibilityOf(recording, tree);

	const skipped: Record<string, number> = {};
	const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
	const { interactions, claimed } = interactionsOf(recording, tree);

	const reactive = scrollReactions(recording, tree, visibility, claimed);
	// Loops are read from the page left to itself: once the harness starts hovering and clicking,
	// what it interrupted is no measure of what the page does on its own.
	const undisturbed = recording.ops.find((op) => op[1] === "m")?.[0] ?? end;
	const byAnchor = new Map<string, { anchor: number; threshold: number; ops: RecordedOp[] }>();
	for (const op of recording.ops) {
		if (op[1] === "m" || claimed.has(op)) continue;
		const [, kind, target] = op as [number, string, number];
		if (kind === "c" && target === -1) {
			skip("changes to the body's own children");
			continue;
		}
		if (kind === "a" && typeof op[3] === "string" && op[3].startsWith("data-brain-")) {
			skip("capture markers");
			continue;
		}
		const reaction = reactive.get(stateKey(op) ?? "");
		const [anchor, threshold] = reaction ? [reaction.anchor, reaction.threshold] : [tree.anchorOf(target), 0];
		const group = byAnchor.get(`${anchor}:${threshold}`) ?? { anchor, threshold, ops: [] };
		group.ops.push(op);
		byAnchor.set(`${anchor}:${threshold}`, group);
	}

	const tapes: Tape[] = [];
	for (const { anchor, threshold, ops } of byAnchor.values()) {
		const episodes = anchor === -1 ? [] : visibility.episodesOf(anchor, threshold);
		const { ambient, triggered } = splitAmbient(ops, episodes, anchor === -1);
		if (ambient.length) {
			const tape: Tape = { anchor, before: ambient.map((op) => played(op, op[0] - recording.base)), episodes: [] };
			const loop = loopOf(
				ambient.filter((op) => op[0] < undisturbed),
				recording.base,
				Math.min(end, undisturbed),
				tree,
			);
			if (loop) tape.loop = loop;
			tapes.push(tape);
		}
		if (!triggered.length) continue;
		// Does it start again each time, or carry on where it left off?
		const tape = restarts(triggered, episodes)
			? triggeredTape(anchor, triggered, episodes, recording.base, end, undisturbed, tree)
			: whileSeenTape(anchor, triggered, episodes, end, undisturbed, tree);
		if (threshold > 0) tape.threshold = threshold;
		tapes.push(tape);
	}
	return { tapes, interactions, skipped };
}

/**
 * Which of a component's changes ran on their own clock, one piece of state at a time: the ones
 * that went on changing, for long enough, while the component was out of sight. A section is often
 * both at once — stars that twinkle whether or not anyone is there, above a demo that waits until
 * it is looked at.
 */
function splitAmbient(ops: RecordedOp[], episodes: Array<{ enter: number; exit: number }>, all: boolean) {
	if (all) return { ambient: ops, triggered: [] as RecordedOp[] };
	const seen = (t: number) => episodes.some((e) => e.enter <= t && t < e.exit + EXIT_WINDOW_MS);
	const unseenByKey = new Map<string, RecordedOp[]>();
	for (const op of ops) {
		if (seen(op[0])) continue;
		const key = stateKey(op) ?? `${op[1]}:${op[2]}`;
		unseenByKey.set(key, [...(unseenByKey.get(key) ?? []), op]);
	}
	const ambientKeys = new Set<string>();
	for (const [key, unseen] of unseenByKey) {
		if (unseen.length >= AMBIENT_OPS && unseen[unseen.length - 1]![0] - unseen[0]![0] >= AMBIENT_SPAN_MS) ambientKeys.add(key);
	}
	const ambient: RecordedOp[] = [];
	const triggered: RecordedOp[] = [];
	for (const op of ops) (ambientKeys.has(stateKey(op) ?? `${op[1]}:${op[2]}`) ? ambient : triggered).push(op);
	return { ambient, triggered };
}

/**
 * Whether a component plays the same thing each time it is looked at. Two visits that begin with
 * the same changes, in the same order, are a thing that restarts — a reveal, a demo that types its
 * line again. Visits that carry on from one another are a carousel that keeps its place.
 */
function restarts(ops: RecordedOp[], episodes: Array<{ enter: number; exit: number }>): boolean {
	const starts: string[][] = [];
	for (const episode of episodes) {
		const inside = ops.filter((op) => op[0] >= episode.enter && op[0] < episode.exit);
		if (inside.length) starts.push(inside.slice(0, RESTART_OPS).map((op) => `${op[1]}:${op[2]}:${op[3] ?? ""}`));
	}
	if (starts.length < 2) return true;
	for (let i = 1; i < starts.length; i++) {
		if (starts[i]!.length === starts[0]!.length && starts[i]!.every((key, k) => key === starts[0]![k])) return true;
	}
	return false;
}

/**
 * A component that only moves while it is being looked at, and picks up where it stopped: its ops
 * are timed by how long the component had been on screen, added up across visits.
 */
function whileSeenTape(anchor: number, ops: RecordedOp[], episodes: Array<{ enter: number; exit: number }>, end: number, undisturbed: number, tree: ComponentTree): Tape {
	const seenBy = (t: number) => {
		let total = 0;
		for (const episode of episodes) {
			if (episode.enter >= t) break;
			total += Math.min(episode.exit, end, t) - episode.enter;
		}
		return Math.max(0, total);
	};
	const onScreen: RecordedOp[] = ops.map((op) => [seenBy(op[0]), ...op.slice(1)] as RecordedOp);
	const watched = seenBy(Math.min(end, undisturbed));
	const loop = loopOf(
		onScreen.filter((op) => op[0] <= watched),
		0,
		watched,
		tree,
	);
	const tape: Tape = { anchor, before: [], episodes: [], whileSeen: { ops: onScreen.map((op) => played(op, op[0])) } };
	if (loop) tape.whileSeen!.loop = loop;
	return tape;
}

/** A component whose changes follow it coming into and out of view. */
function triggeredTape(anchor: number, ops: RecordedOp[], episodes: Array<{ enter: number; exit: number }>, base: number, end: number, undisturbed: number, tree: ComponentTree): Tape {
	const tape: Tape = { anchor, before: [], episodes: episodes.map(() => ({ enter: [], exit: [] })) };
	const entered: RecordedOp[][] = episodes.map(() => []);
	for (const op of ops) {
		const t = op[0];
		let index = -1;
		for (let i = 0; i < episodes.length; i++) if (episodes[i]!.enter <= t) index = i;
		if (index < 0) {
			tape.before.push(played(op, t - base));
			continue;
		}
		const episode = episodes[index]!;
		if (t >= episode.exit && t - episode.exit <= EXIT_WINDOW_MS) {
			tape.episodes[index]!.exit.push(played(op, t - episode.exit));
		} else {
			tape.episodes[index]!.enter.push(played(op, t - episode.enter));
			entered[index]!.push(op);
		}
	}

	// A visit that was cut short while something was still going saw less of it than the longest
	// visit did; on that entry the rebuild plays what the longest visit saw.
	const windows = episodes.map((e) => Math.min(e.exit, end) - e.enter);
	const loops = episodes.map((e, i) =>
		loopOf(
			entered[i]!.filter((op) => op[0] < undisturbed),
			e.enter,
			Math.min(e.exit, end, undisturbed),
			tree,
		),
	);
	let longest = -1;
	for (let i = 0; i < episodes.length; i++) if (entered[i]!.length && (longest < 0 || windows[i]! > windows[longest]!)) longest = i;
	for (let i = 0; i < episodes.length; i++) {
		const episode = tape.episodes[i]!;
		if (longest >= 0 && i !== longest && stillGoing(entered[i]!, episodes[i]!.enter + windows[i]!) && windows[i]! < windows[longest]!) {
			episode.enter = tape.episodes[longest]!.enter;
			if (loops[longest]) episode.loop = loops[longest];
		} else if (loops[i]) {
			episode.loop = loops[i];
		}
	}
	// Visits where nothing happened still count — the second entry plays the second set — but
	// empty ones at the end are nothing to play.
	while (tape.episodes.length) {
		const last = tape.episodes[tape.episodes.length - 1]!;
		if (last.enter.length || last.exit.length) break;
		tape.episodes.pop();
	}
	return tape;
}

// ---- loops ---------------------------------------------------------------------------------

/** What the rebuild compares to decide two recorded ops did the same thing. */
const sameness = (op: RecordedOp, tree: ComponentTree) =>
	JSON.stringify([op[1], tree.stableId(op[2] as number), ...op.slice(3, op[1] === "c" ? 4 : (PLAYED_LENGTH[op[1] as string] ?? op.length))]);

/**
 * How often this behaviour comes round: the slowest thing in it that keeps happening.
 *
 * Measured per piece of state, not across the ops as a whole, because one turn of a carousel is
 * a burst — a class off one panel, a class on the next, a subtree swapped, half a dozen styles —
 * and the gaps inside that burst say a few hundred milliseconds where the beat is five seconds.
 * The panel that changes every five seconds is the beat; the styles that move with it are not.
 */
function rhythmOf(ops: RecordedOp[]): number {
	const times = new Map<string, number[]>();
	for (const op of ops) {
		const key = stateKey(op) ?? `${op[1]}:${op[2]}`;
		times.set(key, [...(times.get(key) ?? []), op[0]]);
	}
	let slowest = 0;
	for (const moments of times.values()) {
		if (moments.length < 3) continue;
		const gaps = moments
			.slice(1)
			.map((t, i) => t - moments[i]!)
			.filter((gap) => gap > MOMENT_MS)
			.sort((a, b) => a - b);
		if (gaps.length) slowest = Math.max(slowest, gaps[gaps.length >> 1]!);
	}
	return slowest;
}

/**
 * Whether activity was still going when the watching stopped. The quiet at the end is judged
 * against the behaviour's own rhythm and against how long it had run: two quiet seconds end a
 * one-second flourish, not five minutes of twinkling.
 */
function stillGoing(ops: RecordedOp[], until: number): boolean {
	if (ops.length < 2) return false;
	const ran = ops[ops.length - 1]![0] - ops[0]![0];
	return until - ops[ops.length - 1]![0] <= Math.max(STILL_GOING_MS, MISSED_CYCLES * rhythmOf(ops), RAN_SHARE * ran);
}

/**
 * Whether ops watched from `start` to `until` were a behaviour still running when the watching
 * stopped, and if so how it repeats: on the exact cycle in the recording's tail when there is one
 * — the same changes, to the same nodes, on the same beat, at least twice over — and otherwise over
 * everything that was seen.
 */
function loopOf(ops: RecordedOp[], start: number, until: number, tree: ComponentTree): Loop | undefined {
	if (ops.length < LOOP_REPEATS + 1 || until - start < LOOP_MIN_MS || !Number.isFinite(until)) return undefined;
	const changes = new Map<string, number>();
	for (const op of ops) {
		const key = `${op[1]}:${op[2]}:${op[1] === "a" || op[1] === "p" ? op[3] : ""}`;
		changes.set(key, (changes.get(key) ?? 0) + 1);
	}
	if (Math.max(...changes.values()) < LOOP_REPEATS || !stillGoing(ops, until)) return undefined;

	const tail = ops.slice(-4_000);
	const keys = tail.map((op) => sameness(op, tree));
	const n = tail.length;
	for (let k = 1; k * 2 <= n; k++) {
		let j = n - k - 1;
		while (j >= 0 && keys[j] === keys[j + k]) j--;
		const first = j + 1;
		if (n - k - first < k) continue;
		const period = tail[first + k]![0] - tail[first]![0];
		if (period < 200) continue;
		let steady = true;
		for (let i = first; i + k < n && steady; i++) steady = Math.abs(tail[i + k]![0] - tail[i]![0] - period) <= Math.max(80, period * 0.1);
		if (steady) return [Math.round(tail[first]![0] - start), Math.round(period)];
	}
	return [0, Math.round(until - start)];
}

/** Every op the tapes carry, once each — episodes can share one list — for rewriting what they point at. */
export function eachTapeOp(tapes: DomTapes, visit: (op: TapeOp) => void): void {
	const seen = new Set<TapeOp>();
	const each = (ops: TapeOp[]) => {
		for (const op of ops) {
			if (seen.has(op)) continue;
			seen.add(op);
			visit(op);
		}
	};
	for (const tape of tapes.tapes) {
		each(tape.before);
		if (tape.whileSeen) each(tape.whileSeen.ops);
		for (const e of tape.episodes) {
			each(e.enter);
			each(e.exit);
		}
	}
	for (const interaction of tapes.interactions) each(interaction.ops);
}
