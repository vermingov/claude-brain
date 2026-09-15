// Reading and writing the vault on the brain's terms: one note at a time, and an append
// to today's journal. These exist so an agent never has a reason to walk the directory —
// everything the recording protocol asks for is a tool call.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripFrontmatter } from "./chunker";
import { vaultReady, vaultRoot } from "./config";
import { noteDetail } from "./graph-builder";

/** Bigger than this and a note is being used as a database; the reader gets the head. */
const MAX_NOTE_CHARS = 60_000;

export type ReadResult = { ok: true; path: string; title: string; text: string; truncated: boolean } | { ok: false; reason: string };

export function readNote(path: string): ReadResult {
	const root = vaultRoot();
	if (!root || !vaultReady()) return { ok: false, reason: "no vault is available right now" };
	const clean = path.replace(/^\/+/, "").replace(/\.\.(\/|$)/g, "");
	const detail = noteDetail(clean, root);
	if (detail) {
		const text = detail.content.slice(0, MAX_NOTE_CHARS);
		return { ok: true, path: clean, title: detail.node.title, text, truncated: detail.content.length > text.length };
	}
	// A note written moments ago is on disk before it is in the index.
	try {
		const raw = stripFrontmatter(readFileSync(join(root, clean), "utf-8")).trim();
		const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? clean.split("/").pop() ?? clean;
		return { ok: true, path: clean, title, text: raw.slice(0, MAX_NOTE_CHARS), truncated: raw.length > MAX_NOTE_CHARS };
	} catch {
		return { ok: false, reason: `no note at ${clean}` };
	}
}

function isDirectory(absolute: string): boolean {
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * The folder this vault keeps its journal in. Vaults name it differently ("Journal",
 * "01 Journals"), so the one already holding dated entries wins; failing that, the first
 * folder that reads like a journal; failing that, a new "Journal".
 */
export function journalFolder(root: string): string {
	let best: { name: string; dated: number } | null = null;
	for (const entry of readdirSync(root)) {
		if (!/journal|diary|daily|log/i.test(entry)) continue;
		const full = join(root, entry);
		if (!isDirectory(full)) continue;
		let dated = 0;
		const count = (dir: string, depth: number) => {
			for (const child of readdirSync(dir)) {
				const path = join(dir, child);
				if (DATE_FILE.test(child)) dated++;
				else if (depth < 2 && isDirectory(path)) count(path, depth + 1);
			}
		};
		try {
			count(full, 0);
		} catch {
			/* unreadable, score it zero */
		}
		if (!best || dated > best.dated) best = { name: entry, dated };
	}
	return best?.name ?? "Journal";
}

export type JournalResult = { ok: true; path: string; created: boolean } | { ok: false; reason: string };

/**
 * Append to today's journal entry, creating it if this is the first thing written today.
 * Appending is the one edit to existing vault content the recording protocol asks for;
 * everything else stays the user's to change.
 */
export async function appendJournal(text: string, heading?: string): Promise<JournalResult> {
	const root = vaultRoot();
	if (!root || !vaultReady()) return { ok: false, reason: "no vault is available right now" };
	const body = text.trim();
	if (!body) return { ok: false, reason: "nothing to record" };

	const folder = journalFolder(root);
	const day = new Date();
	const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
	const dir = join(root, folder);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${stamp}.md`);
	const created = !existsSync(path);
	const previous = created ? `# ${stamp}\n` : readFileSync(path, "utf-8").replace(/\s+$/, "");
	const section = heading?.trim() ? `\n\n## ${heading.trim()}\n\n${body}\n` : `\n\n${body}\n`;
	await Bun.write(path, `${previous}${section}`);
	return { ok: true, path: `${folder}/${stamp}.md`, created };
}
