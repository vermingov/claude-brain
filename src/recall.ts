// Public recall API over both memory systems, plus the compact markdown rendering the
// CLI, the MCP server and the Claude Code hooks consume.

import { basename } from "node:path";
import { alreadyInjected, markInjected } from "./episodic";
import { hybridRecall, type RecallHit, type RecallOptions } from "./hybrid-search";
import { reindex } from "./indexer";

export type { RecallHit, RecallOptions };

export async function recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
	return hybridRecall(query, options);
}

/**
 * Mark hits whose text this session has already been shown. Related queries overlap
 * heavily — the second and third recall in a thread tend to return the same top notes —
 * and re-sending a section that is still in the context window is pure waste.
 */
function flagSeen(hits: RecallHit[], sessionId: string): RecallHit[] {
	const notes = hits.filter((h) => h.kind === "note");
	if (notes.length === 0) return hits;
	const seen = alreadyInjected(sessionId, notes.map((h) => h.path));
	const flagged = hits.map((h) => (h.kind === "note" && seen.has(h.path) ? { ...h, seen: true } : h));
	markInjected(sessionId, notes.map((h) => h.path));
	return flagged;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A "last used" older than this is trivia; inside it, it is a thread worth picking up. */
const LAST_USED_HORIZON = 30 * DAY;

export function ago(ts: number, now = Date.now()): string {
	const delta = Math.max(0, now - ts);
	if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))}m ago`;
	if (delta < DAY) return `${Math.round(delta / HOUR)}h ago`;
	if (delta < 30 * DAY) return `${Math.round(delta / DAY)}d ago`;
	return `${Math.round(delta / (30 * DAY))}mo ago`;
}

function noteHeader(h: RecallHit, index: number, now: number): string {
	const where = h.heading && h.heading !== h.title ? `${h.title} › ${h.heading}` : h.title;
	const via = h.via ? ` — recalled via ${h.via}` : "";
	const copies = h.copies ? ` (+${h.copies} ${h.copies === 1 ? "copy" : "copies"})` : "";
	const used =
		h.lastUsed && now - h.lastUsed.ts < LAST_USED_HORIZON
			? ` — last used ${ago(h.lastUsed.ts, now)}${h.lastUsed.cwd ? ` in ${basename(h.lastUsed.cwd)}` : ""}`
			: "";
	return `### ${index + 1}. ${where}${via}${copies}\n\`${h.path}\` (score ${h.score})${used}`;
}

/**
 * Notes render in full because they are the answer; episodes render as one-liners
 * because their job is to say "you have been here before", not to re-explain it.
 * A weak best score is said out loud: a least-bad guess that looks like an answer is the
 * one thing worse than no answer.
 */
export function renderHits(hits: RecallHit[], query: string, now = Date.now()): string {
	const notes = hits.filter((h) => h.kind === "note");
	const episodes = hits.filter((h) => h.kind === "episode");
	if (notes.length === 0 && episodes.length === 0) return `No memory of: ${query}`;

	const sections: string[] = [];
	const corrected = hits.find((h) => h.corrected)?.corrected;
	if (corrected) sections.push(`(searched as: ${corrected})`);
	if (notes.some((h) => h.weak)) sections.push("(weak match — the vault may not cover this; treat these as guesses)");
	if (notes.length > 0) {
		sections.push(
			notes
				.map((h, i) => {
					const head = noteHeader(h, i, now);
					// Its text is already above in this session; the pointer is enough.
					return h.seen ? `${head} — already shown this session` : `${head}\n\n${h.snippet}`;
				})
				.join("\n\n---\n\n"),
		);
	}
	if (episodes.length > 0) {
		sections.push(
			["## Episodic — you have been here before"]
				.concat(episodes.map((h) => `- [${h.when ? ago(h.when, now) : "?"}, ${h.title}] ${h.snippet}`))
				.join("\n"),
		);
	}
	return sections.join("\n\n");
}

export async function recallMarkdown(query: string, options: RecallOptions = {}): Promise<string> {
	const hits = await recall(query, options);
	return renderHits(options.sessionId ? flagSeen(hits, options.sessionId) : hits, query);
}

/** Direct-import path for the CLI when the server is down: index once, then search. */
export async function recallMarkdownStandalone(query: string, options: RecallOptions = {}): Promise<string> {
	await reindex();
	return recallMarkdown(query, options);
}
