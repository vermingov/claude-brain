// One recorded change, and the parts of it a rebuild plays.
//
// The recorder (dom-recording.ts) writes each change as an array: when it happened, what kind it
// was, which node it was to, and then the kind's own fields — an attribute's name and its new
// value, a text run's text, the markup of a subtree that was replaced. Every change also carries
// the value it replaced, which is what makes it possible to say what state something was in at a
// given moment; that part is for building tapes, and is left behind when they are written.

/** A change as recorded: the time it happened, its kind, its node, then the kind's own fields. */
export type RecordedOp = [number, ...unknown[]];

/** A change as a tape carries it: a delay instead of a time, and nothing the player will not use. */
export type TapeOp = [number, ...unknown[]];

/** The fields of each kind a rebuild plays; the rest — the value replaced — is for building. */
export const PLAYED_LENGTH: Record<string, number> = { a: 5, p: 5, t: 4, w: 5, c: 5 };

export const played = (op: unknown[], delay: number): TapeOp => [Math.round(delay), ...op.slice(1, PLAYED_LENGTH[op[1] as string] ?? op.length)];

/** The one thing an op sets — an attribute, a property, a text run, a subtree — or null. */
export function stateKey(op: RecordedOp): string | null {
	switch (op[1]) {
		case "a":
		case "p":
			return `${op[1]}${op[2]}${op[3]}`;
		case "t":
		case "c":
			return `${op[1]}${op[2]}`;
		default:
			return null;
	}
}
