// Quick capture into the vault: a new file per thought, titled by what it says.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeVaultFolder, vaultReady, vaultRoot } from "./config";

const MAX_TITLE = 80;

/**
 * The first sentence or line. The title is the strongest-weighted field in the index,
 * and a capture titled by its clock — the old `# Inbox 2026-09-07 2033` — put nothing
 * searchable there. Two thirds of one real vault had ended up titled that way.
 */
export function noteTitle(text: string): string {
	const line =
		text
			.split(/\r?\n/)
			.map((l) => l.replace(/^#+\s*/, "").trim())
			.find((l) => l.length > 0) ?? "note";
	const sentence = line.split(/(?<=[.!?])\s/)[0]!;
	return sentence.length > MAX_TITLE ? `${sentence.slice(0, MAX_TITLE - 3).trimEnd()}…` : sentence;
}

export type CaptureResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * New file per capture — the vault protocol forbids editing existing notes unasked. The
 * filename is a second-resolution stamp: minute resolution collided whenever a session
 * recorded several thoughts at once, and each "(2)" copy was indexed as another note.
 */
export async function captureNote(text: string, folder = "Inbox"): Promise<CaptureResult> {
	const root = vaultRoot();
	if (!root || !vaultReady()) return { ok: false, reason: "no vault selected — run `claude-brain` and pick one in Settings" };
	const body = text.trim();
	if (!body) return { ok: false, reason: "nothing to capture" };
	const safe = safeVaultFolder(folder);
	if (!safe) return { ok: false, reason: `not a folder claude-brain will write into: ${folder}` };
	const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "");
	const dir = join(root, safe);
	mkdirSync(dir, { recursive: true });
	let path = join(dir, `${stamp}.md`);
	for (let i = 2; existsSync(path); i++) path = join(dir, `${stamp} (${i}).md`);
	await Bun.write(path, `# ${noteTitle(body)}\n\n${body}\n`);
	return { ok: true, path };
}
