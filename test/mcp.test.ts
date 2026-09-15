// The MCP handshake and tool surface, driven through the real binary over stdio the way
// Claude Code drives it. No daemon: only calls that never reach one are made, so the
// suite cannot start a server or touch a real index.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = join(tmpdir(), `brain-mcp-${process.pid}`);
let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();

function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const id = nextId++;
	proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	proc.stdin.flush();
	return new Promise((resolve) => pending.set(id, resolve));
}

beforeAll(async () => {
	mkdirSync(join(scratch, "config"), { recursive: true });
	proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "claude-brain.ts"), "mcp"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: {
			...process.env,
			XDG_CONFIG_HOME: join(scratch, "config"),
			XDG_DATA_HOME: join(scratch, "data"),
			XDG_CACHE_HOME: join(scratch, "cache"),
			XDG_STATE_HOME: join(scratch, "state"),
		},
	});
	void (async () => {
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += new TextDecoder().decode(chunk);
			let nl: number;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { id?: number };
				if (typeof msg.id === "number") pending.get(msg.id)?.(msg as Record<string, unknown>);
			}
		}
	})();
});

afterAll(() => {
	proc.kill();
	rmSync(scratch, { recursive: true, force: true });
});

describe("mcp", () => {
	test("initialize echoes a known protocol version and advertises tools only", async () => {
		const res = await request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		const result = res.result as Record<string, unknown>;
		expect(result.protocolVersion).toBe("2025-03-26");
		expect(Object.keys(result.capabilities as object)).toEqual(["tools"]);
		expect((result.serverInfo as { name: string }).name).toBe("claude-brain");
		// Notifications get no reply; the next request must still be answered.
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		proc.stdin.flush();
		expect((await request("ping")).result).toEqual({});
	});

	test("tools/list names the whole surface with schemas", async () => {
		const res = await request("tools/list");
		const tools = (res.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
		expect(tools.map((t) => t.name)).toEqual([
			"recall",
			"remember",
			"note",
			"read",
			"journal",
			"forget",
			"path",
			"explain",
			"affected",
			"map",
			"status",
			"consolidate",
		]);
		expect(tools.find((t) => t.name === "recall")!.inputSchema.required).toEqual(["query"]);
	});

	test("a tool failure is a result the model can read, not a protocol error", async () => {
		// No vault is configured in the scratch XDG dirs, so `note` fails before any daemon call.
		const res = await request("tools/call", { name: "note", arguments: { text: "hello" } });
		const result = res.result as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("no vault");
	});

	test("unknown methods and tools are refused cleanly", async () => {
		expect(((await request("resources/list")).error as { code: number }).code).toBe(-32601);
		expect(((await request("tools/call", { name: "nope", arguments: {} })).error as { code: number }).code).toBe(-32602);
	});
});
