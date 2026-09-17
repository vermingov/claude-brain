// What a component does as a function of where the pointer is, rather than of when.
//
// A tape replays what happened. That is the whole story for a demo that plays itself, and no
// story at all for the things people actually reach for: a button that leans toward the cursor, a
// blob that bulges where it is touched, a slider that follows a drag, a card that tilts. Those
// answer a position, and a recording of one pass through them is one frame of an answer.
//
// So the capture sweeps the pointer across the control — a lattice of points over its box, then a
// drag from one side to the other — and marks every sample with where the pointer was, in
// thousandths of the box. What lands between two marks is that sample's answer. Here those
// samples become a surface: for each piece of state the control moved, the value at each point,
// with the numbers pulled out of it.
//
// The rebuild then interpolates. Between sampled points it is an average weighted by distance,
// which for a nine-point lattice is close enough that a hand moving across the element feels like
// the page rather than like a lookup table — and it is the page's own numbers, not a guess at its
// easing.
//
// What this cannot do is invent behaviour between samples that is not smooth: a control that
// snaps at a threshold reads as a slope, and one whose answer depends on speed or on where the
// drag began reads as if it depends only on where the pointer is now. Those need the component's
// own code, which is a different thing entirely (behaviour-port.ts).

import type { RecordedOp } from "./dom-ops";
import { stateKey } from "./dom-ops";

/** A value with its numbers taken out: "translate(12px, -4px)" is ["translate(", "px, ", "px)"]. */
export interface Shape {
	parts: string[];
	count: number;
}

export interface Sample {
	/** Where the pointer was, in thousandths of the element's box. */
	u: number;
	v: number;
	numbers: number[];
}

export interface Surface {
	/** The element the pointer has to be over: the one that was swept. */
	over: number;
	/** What is set: an attribute, a property, or a text run. */
	kind: "a" | "p" | "t";
	/** The node being set, which is often not the one under the pointer. */
	target: number;
	name: string;
	shape: Shape;
	/** How the pointer was: over the element, or dragging across it. */
	on: "move" | "drag";
	samples: Sample[];
}

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;
/** Below this many samples a surface is a coincidence rather than a shape. */
const LEAST_SAMPLES = 3;
/** A value that never moves says nothing about the pointer. */
const LEAST_SPREAD = 0.5;

/** The text of a value with its numbers removed, and the numbers. */
export function split(value: string): { shape: Shape; numbers: number[] } {
	const numbers: number[] = [];
	const parts: string[] = [];
	let at = 0;
	for (const match of value.matchAll(NUMBER)) {
		parts.push(value.slice(at, match.index));
		numbers.push(Number(match[0]));
		at = match.index + match[0].length;
	}
	parts.push(value.slice(at));
	return { shape: { parts, count: numbers.length }, numbers };
}

const sameShape = (a: Shape, b: Shape) => a.count === b.count && a.parts.length === b.parts.length && a.parts.every((part, i) => part === b.parts[i]);

/**
 * The surfaces in a recording: every piece of state that answered the pointer while a control was
 * being swept. Ops that belong to a sample are returned too, so the tapes can leave them out —
 * they are the answer to a question the harness asked, not something the page did on its own.
 */
export function surfacesOf(recording: { ops: RecordedOp[] }): { surfaces: Surface[]; sampled: Set<unknown[]> } {
	const sampled = new Set<unknown[]>();
	// key -> the samples taken of it, per swept element and gesture
	const collected = new Map<string, { surface: Omit<Surface, "samples">; samples: Sample[]; shapes: Shape[] }>();
	let at: { over: number; on: Surface["on"]; u: number; v: number } | null = null;

	for (const op of recording.ops) {
		if (op[1] === "m") {
			const kind = op[3] as string;
			const [u, v] = [op[4] as number | undefined, op[5] as number | undefined];
			at = kind === "at" || kind === "drag" || kind === "grab"
				? u === undefined || v === undefined
					? null
					: { over: op[2] as number, on: kind === "at" ? "move" : "drag", u, v }
				: null;
			continue;
		}
		if (!at) continue;
		const kind = op[1] as string;
		if (kind !== "a" && kind !== "p" && kind !== "t") continue;
		const value = kind === "t" ? op[3] : op[4];
		if (typeof value !== "string") continue;
		sampled.add(op);

		const { shape, numbers } = split(value);
		if (numbers.length === 0) continue;
		const key = `${at.over}${at.on}${stateKey(op)}`;
		const held = collected.get(key);
		if (!held) {
			collected.set(key, {
				surface: {
					over: at.over,
					on: at.on,
					kind,
					target: op[2] as number,
					name: kind === "t" ? "" : String(op[3]),
					shape,
				},
				samples: [{ u: at.u, v: at.v, numbers }],
				shapes: [shape],
			});
			continue;
		}
		if (!sameShape(held.surface.shape, shape)) continue;
		// One sample per point: the last value at a point is what the control settled on there.
		const existing = held.samples.find((sample) => sample.u === at!.u && sample.v === at!.v);
		if (existing) existing.numbers = numbers;
		else held.samples.push({ u: at.u, v: at.v, numbers });
	}

	const surfaces: Surface[] = [];
	for (const { surface, samples } of collected.values()) {
		if (samples.length < LEAST_SAMPLES) continue;
		// Something has to move with the pointer, or this is a constant wearing a surface's clothes.
		const moves = surface.shape.count > 0 && Array.from({ length: surface.shape.count }, (_, i) => {
			const values = samples.map((sample) => sample.numbers[i] ?? 0);
			return Math.max(...values) - Math.min(...values);
		}).some((spread) => spread >= LEAST_SPREAD);
		if (!moves) continue;
		surfaces.push({ ...surface, samples });
	}
	return { surfaces, sampled };
}
