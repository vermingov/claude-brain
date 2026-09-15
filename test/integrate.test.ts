// Integration must be automatic and reversible: the daemon wires Claude Code on start,
// an upgrade re-wires it, and `--remove` is a decision the daemon respects. Everything
// runs against a throwaway HOME and XDG tree — no real ~/.claude is touched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = join(tmpdir(), `brain-integrate-${process.pid}`);
const home = join(scratch, "home");
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: join(scratch, "config"),
	XDG_DATA_HOME: join(scratch, "data"),
	XDG_CACHE_HOME: join(scratch, "cache"),
	XDG_STATE_HOME: join(scratch, "state"),
};
const cli = join(import.meta.dir, "..", "bin", "claude-brain.ts");

function run(...args: string[]): { code: number; out: string } {
	const proc = Bun.spawnSync(["bun", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout) };
}

/**
 * One daemon boot's worth of the automatic pass, in its own process: the modules read
 * HOME and the XDG dirs at import time, and bun test shares one module cache across
 * files, so an in-process call would see whichever environment loaded first.
 */
function boot(version: string, homeDir: string, configDir: string): string {
	const src = join(import.meta.dir, "..", "src");
	const proc = Bun.spawnSync(
		[
			"bun",
			"-e",
			`const { openBrainDb } = await import("${join(src, "index-db.ts")}");
			 openBrainDb("${join(scratch, "data", "claude-brain", "boot.sqlite")}");
			 const { autoIntegrate } = await import("${join(src, "integrate.ts")}");
			 console.log(JSON.stringify(await autoIntegrate("${version}")));`,
		],
		{ env: { ...env, HOME: homeDir, XDG_CONFIG_HOME: configDir }, stdout: "pipe", stderr: "pipe" },
	);
	return new TextDecoder().decode(proc.stdout).trim();
}

const claudeJson = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8")) as Record<string, unknown>;
const settings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as { hooks: Record<string, unknown> };
const config = () => JSON.parse(readFileSync(join(scratch, "config", "claude-brain", "config.json"), "utf-8")) as { autoIntegrate: boolean };

beforeAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(join(home, ".claude"), { recursive: true });
	// What a real machine looks like: Claude Code state that must survive untouched.
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "x" } } }));
	writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo" }] }] } }));
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("integrate", () => {
	test("wires everything and preserves what was there", () => {
		expect(run("integrate").code).toBe(0);
		const servers = claudeJson().mcpServers as Record<string, Record<string, unknown>>;
		expect(servers.other).toEqual({ type: "stdio", command: "x" });
		expect((servers["claude-brain"]!.args as string[]).at(-1)).toBe("mcp");
		expect(claudeJson().numStartups).toBe(3);
		expect(Object.keys(settings().hooks).sort()).toEqual(["PreToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
		expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf-8")).toContain("`recall` tool");
		expect(existsSync(join(home, ".claude", "skills", "claude-brain", "SKILL.md"))).toBe(true);
		expect(config().autoIntegrate).toBe(true);
	});

	test("remove unwires everything and turns the automatic pass off", () => {
		expect(run("integrate", "--remove").code).toBe(0);
		expect(claudeJson().mcpServers).toEqual({ other: { type: "stdio", command: "x" } });
		expect(Object.keys(settings().hooks)).toEqual(["PreToolUse"]);
		expect(existsSync(join(home, ".claude", "skills", "claude-brain"))).toBe(false);
		expect(config().autoIntegrate).toBe(false);
	});

	test("the automatic pass respects a removal, and re-arms after an explicit integrate", () => {
		expect(boot("9.9.9", home, join(scratch, "config"))).toBe("null");
		expect(claudeJson().mcpServers).toEqual({ other: { type: "stdio", command: "x" } });

		expect(run("integrate").code).toBe(0);
		expect(config().autoIntegrate).toBe(true);
		expect(Object.keys(claudeJson().mcpServers as object).sort()).toEqual(["claude-brain", "other"]);
	});

	test("a version the daemon has not integrated yet triggers one pass, then none", () => {
		const home2 = join(scratch, "home2");
		mkdirSync(join(home2, ".claude"), { recursive: true });
		const config2 = join(scratch, "config2");
		const first = JSON.parse(boot("1.0.0", home2, config2)) as { mcp: boolean } | null;
		expect(first?.mcp).toBe(true);
		expect(existsSync(join(home2, ".claude", "skills", "claude-brain", "SKILL.md"))).toBe(true);
		// Same version again: nothing to do.
		expect(boot("1.0.0", home2, config2)).toBe("null");
		// An upgrade: wires again so the block and skill text catch up.
		expect(boot("1.0.1", home2, config2)).not.toBe("null");
	});
});
