// Tapes small enough to serve.
//
// A page that draws with an image often carries that image inline, as a data URI inside a style
// rule. The recorder sees the whole rule every time it changes, so a card that animates a border
// radius over a photographed background writes the photograph again sixty times a second. One
// bencho.dev capture came to fifty-four megabytes, of which forty-seven was the same JPEG repeated
// across fifty-four thousand style attributes.
//
// Nothing about that is behaviour, so nothing is lost by saying it once. Every long literal that
// appears more than once — a data URI, a long gradient, any repeated run — is put in a dictionary
// and referred to by a token, and the player puts it back as it applies each change.
//
// The token carries no digits. The player interpolates between recorded values by pulling the
// numbers out of them (dom-player's split), and an index written as digits would read as one more
// number to animate: a background would be tweened into a different dictionary entry.

import type { DomTapes, TapeOp } from "./dom-tapes";
import { eachTapeOp } from "./dom-tapes";

/** What wraps a dictionary reference. Outside the range any page text uses. */
const MARK = "";
/** Shorter than this and the reference costs more than the text it replaces. */
const LEAST_LENGTH = 96;

/** An index as letters, so the number-finder in the player passes over it. */
export function letters(index: number): string {
	let out = "";
	let n = index;
	do {
		out = String.fromCharCode(97 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/** The long literals worth naming: what a page repeats, not what it says once. */
const REPEATED = new RegExp(`data:[^"')\\s]{${LEAST_LENGTH},}`, "g");

/**
 * The tapes with their repeated literals replaced by references, and the dictionary those refer
 * to. The tapes are rewritten where they stand — they are about to be written out — and each op is
 * visited once, so lists that several episodes share are not packed twice.
 */
export function packTapes(tapes: DomTapes): string[] {
	const index = new Map<string, number>();
	const seen = new Map<string, number>();
	// First pass: how often each literal turns up. One use is not worth a dictionary entry.
	const count = (value: string) => {
		for (const [match] of value.matchAll(REPEATED)) seen.set(match, (seen.get(match) ?? 0) + 1);
	};
	const strings = (op: TapeOp, visit: (value: string) => void) => {
		const kind = op[1];
		if (kind === "a" || kind === "p") {
			if (typeof op[4] === "string") visit(op[4]);
		} else if ((kind === "t" || kind === "c") && typeof op[3] === "string") visit(op[3]);
	};
	eachTapeOp(tapes, (op) => strings(op, count));

	const dictionary: string[] = [];
	const swap = (value: string) =>
		value.replace(REPEATED, (match) => {
			if ((seen.get(match) ?? 0) < 2) return match;
			let at = index.get(match);
			if (at === undefined) {
				at = dictionary.length;
				dictionary.push(match);
				index.set(match, at);
			}
			return MARK + letters(at) + MARK;
		});
	eachTapeOp(tapes, (op) => {
		const kind = op[1];
		if (kind === "a" || kind === "p") {
			if (typeof op[4] === "string") op[4] = swap(op[4]);
		} else if ((kind === "t" || kind === "c") && typeof op[3] === "string") op[3] = swap(op[3]);
	});
	return dictionary;
}
