// Spelling correction against the index's own vocabulary. A cue that matches nothing
// lexically is usually a typo of something the vault says all the time — and the writer
// knows which word was meant because it is their vocabulary, not a dictionary's.
//
// The vocabulary is the FTS index's term list, post-stemming, so a correction feeds
// straight back into the same index. Loaded once per process, refreshed when the index
// changes; tens of thousands of terms, a few hundred KB.

import { openBrainDb } from "./index-db";

interface VocabEntry {
	term: string;
	/** Documents (chunks) the term occurs in — the tie-breaker between candidates. */
	df: number;
}

/** Bucketed by first letter: a typo in the first letter is rare, and it cuts the scan 20x. */
let cache: { key: string; byFirst: Map<string, VocabEntry[]> } | null = null;

const MIN_QUERY_TERM = 5;
const MIN_VOCAB_TERM = 4;
const MAX_DISTANCE = 2;
/** A stem is shorter than its word by at most a suffix. */
const MAX_STEM_GAP = 4;

function indexKey(): string {
	const { db } = openBrainDb();
	const chunks = (db.query("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
	const last = (db.query("SELECT value FROM meta WHERE key = 'last_index'").get() as { value: string } | null)?.value ?? "";
	return `${chunks}:${last}`;
}

function vocabulary(): Map<string, VocabEntry[]> {
	const key = indexKey();
	if (cache?.key === key) return cache.byFirst;
	const { db } = openBrainDb();
	const byFirst = new Map<string, VocabEntry[]>();
	try {
		const rows = db
			.query(`SELECT term, doc AS df FROM chunks_vocab WHERE length(term) >= ${MIN_VOCAB_TERM}`)
			.all() as VocabEntry[];
		for (const row of rows) {
			const first = row.term[0]!;
			const list = byFirst.get(first) ?? [];
			list.push(row);
			byFirst.set(first, list);
		}
	} catch {
		/* fts5vocab unavailable — no correction, recall still works */
	}
	cache = { key, byFirst };
	return byFirst;
}

/**
 * Damerau-Levenshtein (optimal string alignment), so a transposition — the most common
 * typing slip — costs one edit, not two. Bails out as soon as no path can stay within
 * `max`, which is what makes scanning a whole letter bucket affordable.
 */
export function editDistance(a: string, b: string, max = MAX_DISTANCE): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const rows: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		rows.push(new Array<number>(b.length + 1).fill(0));
		rows[i]![0] = i;
	}
	for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Number.POSITIVE_INFINITY;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d = Math.min(d, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = d;
			if (d < rowMin) rowMin = d;
		}
		if (rowMin > max) return max + 1;
	}
	return rows[a.length]![b.length]!;
}

/**
 * The vault's nearest term to `term`, or null when the term is already known or nothing
 * lies within two edits. "Known" allows for stemming: the index holds `tailscal`, the
 * query says `tailscale`, and that is a match, not a misspelling. Ties go to the more
 * common candidate — the likelier intended word.
 */
export function nearestTerm(term: string): string | null {
	if (term.length < MIN_QUERY_TERM) return null;
	const bucket = vocabulary().get(term[0]!);
	if (!bucket) return null;
	for (const entry of bucket) {
		const gap = term.length - entry.term.length;
		if (gap >= 0 && gap <= MAX_STEM_GAP && term.startsWith(entry.term)) return null;
		if (gap < 0 && gap >= -MAX_DISTANCE && entry.term.startsWith(term)) return null;
	}
	let best: VocabEntry | null = null;
	let bestDistance = MAX_DISTANCE + 1;
	for (const entry of bucket) {
		const d = editDistance(term, entry.term);
		if (d > MAX_DISTANCE) continue;
		if (d < bestDistance || (d === bestDistance && best && entry.df > best.df)) {
			best = entry;
			bestDistance = d;
		}
	}
	return best?.term ?? null;
}

/** `terms` with every correctable one replaced, or null when nothing needed correcting. */
export function correctTerms(terms: string[]): string[] | null {
	let changed = false;
	const out = terms.map((term) => {
		const fixed = nearestTerm(term);
		if (fixed) changed = true;
		return fixed ?? term;
	});
	return changed ? out : null;
}
