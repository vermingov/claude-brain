// Break-point-scored markdown chunker (after tobi/qmd): instead of cutting at a fixed
// character count, score candidate split lines and cut at the best one within a lookback
// window, so chunks end at headings / fences / blank lines rather than mid-paragraph.

export interface NoteChunk {
	heading: string;
	pos: number;
	text: string;
	startLine: number;
}

const TARGET_CHARS = 2400;
const MIN_CHARS = 400;
const LOOKBACK_CHARS = 900;

function breakScore(line: string, insideFence: boolean): number {
	if (insideFence) return 0;
	if (/^#\s/.test(line)) return 100;
	if (/^#{2,4}\s/.test(line)) return 90;
	if (/^```/.test(line)) return 80;
	if (/^(-{3,}|\*{3,})\s*$/.test(line)) return 60;
	if (line.trim() === "") return 20;
	if (/^\s*[-*+]\s/.test(line)) return 5;
	return 0;
}

export function stripFrontmatter(raw: string): string {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** A title that is only a capture stamp, a date, or a "(2)" copy of one — no cue in it. */
export const TIMESTAMP_TITLE = /^(inbox\s+)?\d{4}-\d{2}-\d{2}(\s+\d{4,6})?(\s+\(\d+\))?$/i;

function firstMeaningfulLine(body: string, from: number): string {
	for (const raw of body.slice(from).split(/\r?\n/)) {
		const line = raw.replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim();
		if (line.length < 4 || line.startsWith("---") || line.startsWith("![")) continue;
		return line.length > 90 ? `${line.slice(0, 87).trimEnd()}…` : line;
	}
	return "";
}

/**
 * The H1, else the filename — unless that is a timestamp. The title is the strongest
 * field in the index (FTS weight 3, and prefixed into every chunk embedding), and a
 * quick capture titled by its clock puts noise exactly there. Its first real line says
 * what it is about; a bare date (a journal) keeps the date in front so the day itself
 * stays findable.
 */
export function titleOf(body: string, fallback: string): string {
	const h = body.match(/^#\s+(.+)$/m);
	const title = h?.[1] ? h[1].trim() : fallback;
	if (!TIMESTAMP_TITLE.test(title)) return title;
	const line = firstMeaningfulLine(body, h ? (h.index ?? 0) + h[0].length : 0);
	if (!line) return title;
	// Only a bare date is worth keeping: that is a journal day. A clock time or a "(2)"
	// is capture bookkeeping and says nothing about the note.
	const journal = /^\d{4}-\d{2}-\d{2}$/.test(title);
	return journal ? `${title} ${line}` : line;
}

/**
 * Split a note body into chunks of ~TARGET_CHARS, cutting at the highest-scoring
 * break line within the trailing window. Distance decay prefers cuts near the
 * target size: score × (1 − (distance/window)² × 0.7).
 */
export function chunkNote(body: string): NoteChunk[] {
	const lines = body.split(/\r?\n/);
	const chunks: NoteChunk[] = [];
	let heading = "";
	let insideFence = false;

	let acc: string[] = [];
	let accStart = 0;
	let size = 0;
	// Candidate cut: index into acc + its decayed score, tracked as lines stream in.
	let cutAt = -1;
	let cutScore = 0;

	const flush = (upTo: number) => {
		const text = acc
			.slice(0, upTo)
			.join("\n")
			.trim();
		if (text) chunks.push({ heading, pos: chunks.length, text, startLine: accStart });
		const rest = acc.slice(upTo);
		accStart += upTo;
		acc = rest;
		size = rest.reduce((n, l) => n + l.length + 1, 0);
		cutAt = -1;
		cutScore = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const hm = line.match(/^(#{1,4})\s+(.+)$/);
		if (hm?.[2] && !insideFence) {
			// Headings always start a fresh chunk and update the running section label.
			if (size > MIN_CHARS) flush(acc.length);
			heading = hm[2].trim();
		}
		if (/^```/.test(line)) insideFence = !insideFence;

		acc.push(line);
		size += line.length + 1;

		const raw = breakScore(line, insideFence);
		if (raw > 0 && size > MIN_CHARS) {
			const distance = Math.min(size, LOOKBACK_CHARS);
			const decayed = raw * (1 - (1 - distance / LOOKBACK_CHARS) ** 2 * 0.7);
			if (decayed >= cutScore) {
				cutScore = decayed;
				cutAt = acc.length;
			}
		}
		if (size >= TARGET_CHARS) flush(cutAt > 0 ? cutAt : acc.length);
	}
	flush(acc.length);
	return chunks;
}
