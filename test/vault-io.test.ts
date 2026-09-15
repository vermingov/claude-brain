// Writing the day's log and opening one note are tool calls now, so they have to work on
// a vault that names its journal folder however it likes — and never outside it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalFolder } from "../src/vault-io";

const dir = join(tmpdir(), `brain-vaultio-${process.pid}`);
const vault = join(dir, "vault");
const config = join(dir, "config");

/** The helpers read the user's config, so they are exercised in their own process. */
function run(body: string): { out: string; code: number } {
	const proc = Bun.spawnSync(["bun", "-e", body], {
		env: { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: new TextDecoder().decode(proc.stdout).trim(), code: proc.exitCode };
}

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(vault, "01 Journals", "2026"), { recursive: true });
	mkdirSync(join(vault, "Notes"), { recursive: true });
	mkdirSync(join(vault, "Worklogs"), { recursive: true });
	writeFileSync(join(vault, "01 Journals", "2026", "2026-09-01.md"), "# 2026-09-01\n\nyesterday\n");
	writeFileSync(join(vault, "Notes", "alpha.md"), "---\ntags: [x]\n---\n# Alpha\n\nBody of alpha.\n");
	mkdirSync(join(config, "claude-brain"), { recursive: true });
	writeFileSync(join(config, "claude-brain", "config.json"), JSON.stringify({ vault }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("journal", () => {
	test("finds the folder this vault actually keeps dated entries in", () => {
		expect(journalFolder(vault)).toBe("01 Journals");
	});

	test("falls back to a new Journal when the vault has none", () => {
		const bare = join(dir, "bare");
		mkdirSync(join(bare, "Notes"), { recursive: true });
		expect(journalFolder(bare)).toBe("Journal");
	});

	test("starts today's entry, then appends to it under headings", () => {
		const src = join(import.meta.dir, "..", "src", "vault-io.ts");
		const first = run(`const { appendJournal } = await import("${src}"); console.log(JSON.stringify(await appendJournal("did a thing", "Work")));`);
		const parsed = JSON.parse(first.out) as { ok: boolean; path: string; created: boolean };
		expect(parsed.ok).toBe(true);
		expect(parsed.created).toBe(true);
		expect(parsed.path.startsWith("01 Journals/")).toBe(true);

		const second = run(`const { appendJournal } = await import("${src}"); console.log(JSON.stringify(await appendJournal("and another")));`);
		expect((JSON.parse(second.out) as { created: boolean }).created).toBe(false);

		const text = readFileSync(join(vault, parsed.path), "utf-8");
		expect(text).toContain("## Work");
		expect(text).toContain("did a thing");
		expect(text).toContain("and another");
		// One heading, one entry: appending must not restate the day.
		expect(text.match(/^# \d{4}-\d{2}-\d{2}$/gm)).toHaveLength(1);
	});

	test("nothing to record is not an entry", () => {
		const src = join(import.meta.dir, "..", "src", "vault-io.ts");
		const out = run(`const { appendJournal } = await import("${src}"); console.log(JSON.stringify(await appendJournal("   ")));`);
		expect((JSON.parse(out.out) as { ok: boolean }).ok).toBe(false);
	});
});

describe("read", () => {
	test("returns a note that is on disk but not yet indexed, without its frontmatter", () => {
		const src = join(import.meta.dir, "..", "src", "vault-io.ts");
		const out = run(`const { readNote } = await import("${src}"); console.log(JSON.stringify(readNote("Notes/alpha.md")));`);
		const parsed = JSON.parse(out.out) as { ok: boolean; title: string; text: string };
		expect(parsed.ok).toBe(true);
		expect(parsed.title).toBe("Alpha");
		expect(parsed.text).toContain("Body of alpha");
		expect(parsed.text).not.toContain("tags:");
	});

	test("cannot be walked out of the vault", () => {
		const src = join(import.meta.dir, "..", "src", "vault-io.ts");
		const out = run(`const { readNote } = await import("${src}"); console.log(JSON.stringify(readNote("../../../etc/hosts")));`);
		expect((JSON.parse(out.out) as { ok: boolean }).ok).toBe(false);
	});
});
