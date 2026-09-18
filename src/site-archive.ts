// A recorded visit on disk, and finding in it the answer to a request the page makes again.
//
// The layout is a manifest beside a folder of bodies named by their own hash, so a chunk two pages
// share, or one a site serves under two addresses, is kept once:
//
//   <dir>/manifest.json     what was asked and what came back, without the bodies
//   <dir>/bodies/<sha256>   each distinct body, as the browser decoded it
//
// Finding an answer is exact first. A page run a second time does not ask for exactly what it asked
// the first time, though: it stamps requests with the time, a random number, a build id of the
// session. Those parts are taken out of both sides before a request is given up on, and nothing
// looser than that is tried — the wrong rows from an API are worse than none, because the page
// renders them as if they were right.

import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SiteRecording } from "./site-capture";

export interface ArchiveEntry {
	url: string;
	method: string;
	bodyHash?: string;
	status: number;
	headers: Array<[string, string]>;
	mime: string;
	kind: string;
	/** The body's file under bodies/, or null when the visit never got hold of it. */
	body: string | null;
	bytes: number;
}

export interface ArchiveManifest {
	version: 1;
	document: string;
	capturedAt: string;
	entries: ArchiveEntry[];
	redirects: Array<[string, string]>;
	skipped: Record<string, number>;
}

export interface SiteArchive {
	manifest: ArchiveManifest;
	/** The recorded answer to this request, or null when the visit never saw one like it. */
	find(method: string, url: string, bodyHash?: string): ArchiveEntry | null;
	bodyPath(entry: ArchiveEntry): string | null;
	/** Keep one more answer with the rest, on disk as well as here (site-fill.ts). */
	add(answer: Omit<ArchiveEntry, "body" | "bytes">, body: Uint8Array): Promise<ArchiveEntry>;
}

const MANIFEST = "manifest.json";
const BODIES = "bodies";
const MAX_REDIRECTS = 8;

export async function writeArchive(dir: string, recording: SiteRecording): Promise<ArchiveManifest> {
	// A new recording replaces the old one whole: bodies are named by what is in them, so the ones
	// a site no longer serves would otherwise stay for ever with nothing pointing at them.
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, BODIES), { recursive: true });
	const entries: ArchiveEntry[] = [];
	for (const exchange of recording.exchanges) {
		let body: string | null = null;
		if (exchange.body) {
			body = new Bun.CryptoHasher("sha256").update(exchange.body).digest("hex");
			await Bun.write(join(dir, BODIES, body), exchange.body);
		}
		entries.push({
			url: exchange.url,
			method: exchange.method,
			bodyHash: exchange.bodyHash,
			status: exchange.status,
			headers: exchange.headers,
			mime: exchange.mime,
			kind: exchange.kind,
			body,
			bytes: exchange.body?.byteLength ?? 0,
		});
	}
	const manifest: ArchiveManifest = {
		version: 1,
		document: recording.document,
		capturedAt: new Date().toISOString(),
		entries,
		redirects: recording.redirects,
		skipped: recording.skipped,
	};
	await Bun.write(join(dir, MANIFEST), JSON.stringify(manifest));
	return manifest;
}

/** Archives already read, by folder, with the manifest's age when they were — a page asks for hundreds of things. */
const opened = new Map<string, { writtenAt: number; archive: SiteArchive }>();

export function openArchive(dir: string): SiteArchive | null {
	let manifest: ArchiveManifest;
	let writtenAt: number;
	try {
		writtenAt = statSync(join(dir, MANIFEST)).mtimeMs;
		const held = opened.get(dir);
		if (held?.writtenAt === writtenAt) return held.archive;
		manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf-8")) as ArchiveManifest;
	} catch {
		return null;
	}
	if (manifest.version !== 1 || !manifest.document) return null;

	const exact = new Map<string, ArchiveEntry>();
	const steady = new Map<string, ArchiveEntry>();
	const index = (entry: ArchiveEntry) => {
		exact.set(requestKey(entry.method, entry.url, entry.bodyHash), entry);
		exact.set(requestKey(entry.method, entry.url), entry);
		steady.set(requestKey(entry.method, withoutVolatile(entry.url)), entry);
	};
	manifest.entries.forEach(index);
	const redirects = new Map(manifest.redirects);
	// One write of the manifest at a time, however many answers arrive together.
	let written: Promise<unknown> = Promise.resolve();

	const archive: SiteArchive = {
		manifest,
		find(method, url, bodyHash) {
			let address = stripFragment(url);
			for (let hop = 0; hop < MAX_REDIRECTS && redirects.has(address); hop++) address = redirects.get(address)!;
			return (
				exact.get(requestKey(method, address, bodyHash)) ??
				exact.get(requestKey(method, address)) ??
				steady.get(requestKey(method, withoutVolatile(address))) ??
				null
			);
		},
		bodyPath: (entry) => (entry.body && /^[0-9a-f]{64}$/.test(entry.body) ? join(dir, BODIES, entry.body) : null),
		async add(answer, body) {
			const file = new Bun.CryptoHasher("sha256").update(body).digest("hex");
			await Bun.write(join(dir, BODIES, file), body);
			const entry: ArchiveEntry = { ...answer, body: file, bytes: body.byteLength };
			manifest.entries.push(entry);
			index(entry);
			written = written.then(async () => {
				await Bun.write(join(dir, MANIFEST), JSON.stringify(manifest));
				// This copy in memory is the one just written, so it need not be read back.
				opened.set(dir, { writtenAt: statSync(join(dir, MANIFEST)).mtimeMs, archive });
			});
			await written;
			return entry;
		},
	};
	opened.set(dir, { writtenAt, archive });
	return archive;
}

const requestKey = (method: string, url: string, bodyHash?: string) => `${method.toUpperCase()} ${url}${bodyHash ? ` ${bodyHash}` : ""}`;

function stripFragment(url: string): string {
	const at = url.indexOf("#");
	return at < 0 ? url : url.slice(0, at);
}

/** Names a page gives a parameter whose only job is to be different every time. */
const VOLATILE_NAMES = new Set(["_", "t", "ts", "cb", "cachebust", "cachebuster", "nocache", "rand", "random", "timestamp", "_t", "_ts", "_rsc"]);
/** A clock reading in seconds or milliseconds, or a draw from Math.random(). */
const VOLATILE_VALUE = /^(?:1\d{9}|1\d{12}|0\.\d{6,})$/;

/** The address with its every-time-different parameters taken out, and the rest put in order. */
export function withoutVolatile(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	const kept = [...parsed.searchParams].filter(([name, value]) => !VOLATILE_NAMES.has(name.toLowerCase()) && !VOLATILE_VALUE.test(value));
	kept.sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
	parsed.search = new URLSearchParams(kept).toString();
	parsed.hash = "";
	return parsed.href;
}
