// Talking to the always-on server. The CLI and the MCP server both go through here: one
// model and one index in one process serve every session, and a caller that finds the
// daemon down starts it rather than loading a second copy of everything.

import { join } from "node:path";
import { loadConfig } from "./config";

export function baseUrl(): string {
	return `http://localhost:${loadConfig().port}`;
}

export async function api(path: string, init?: RequestInit): Promise<Response | null> {
	try {
		const res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(8000), ...init });
		return res.ok ? res : null;
	} catch {
		return null;
	}
}

export function postJson(path: string, body: unknown): Promise<Response | null> {
	return api(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export async function serverUp(): Promise<boolean> {
	return (await api("/api/status")) !== null;
}

/** Start the server detached when nothing answers, and wait for it. False if it never came up. */
export async function ensureServer(): Promise<boolean> {
	if (await serverUp()) return true;
	const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server.ts")], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	proc.unref();
	for (let i = 0; i < 40; i++) {
		await Bun.sleep(250);
		if (await serverUp()) return true;
	}
	return false;
}
