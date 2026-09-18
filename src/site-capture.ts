// Everything a page asked the network for, kept so the page can be run again without it.
//
// A transplant is a page's DOM and its rules, and the tapes are what its script was seen doing to
// them. Neither is the script. A stepper rebuilt that way shows the number it showed; it does not
// count. A checklist plays back the ticks the capture made and ignores everyone else's. What a
// component does when someone uses it is decided by its code, and there is no recording of code
// running that stands in for the code.
//
// So the code is kept, and with it everything the code needs in order to start: the document as the
// server sent it, every script and chunk, the stylesheets, fonts and pictures, and the answers the
// page's API gave. Played back to the same code, the same requests get the same answers, and the
// page boots and behaves as itself (site-serve.ts, runtime/site-worker.js).
//
// The browser is asked rather than a proxy placed in front of it. It has already decoded, decrypted
// and decompressed every response, it knows which request a redirect belonged to, and it sees the
// requests a page makes from a worker or a module graph the same as any other.

import type { Page } from "./cdp";
import { type FetchLimits, guardedFetch } from "./url-guard";

/** One request the page made, and what came back. */
export interface Exchange {
	url: string;
	method: string;
	/** SHA-256 of the request's body, which is what tells one POST to an endpoint from the next. */
	bodyHash?: string;
	status: number;
	headers: Array<[string, string]>;
	mime: string;
	/** "Document", "Script", "XHR", "Fetch"… as the browser classed it. */
	kind: string;
	/** Absent when the browser had already let go of it and asking the site again failed too. */
	body?: Uint8Array;
}

export interface SiteRecording {
	/** The address the document ended up at, once any redirects had run. */
	document: string;
	exchanges: Exchange[];
	/** Addresses that answered with a redirect, and where each one sent the browser. */
	redirects: Array<[from: string, to: string]>;
	/** What could not be kept, counted by reason, for the notes. */
	skipped: Record<string, number>;
}

/** The browser holds response bodies in a buffer of its own; these keep a whole visit in it. */
const BROWSER_BUFFER_BYTES = 768 * 1024 * 1024;
const BROWSER_RESOURCE_BYTES = 128 * 1024 * 1024;
/** Past this a body is a film, not a page, and the copy does without it. */
const MAX_BODY_BYTES = 96 * 1024 * 1024;
/** How long the end of a visit waits for bodies still being read out. */
const DRAIN_TIMEOUT_MS = 30_000;

const REFETCH_LIMITS: FetchLimits = { maxBytes: MAX_BODY_BYTES, timeoutMs: 20_000, stallMs: 8_000, accept: [] };

interface Pending {
	url: string;
	method: string;
	kind: string;
	postData?: string;
	hasPostData: boolean;
	response?: { status: number; headers: Record<string, string>; mimeType: string };
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const isHttp = (url: string) => url.startsWith("http://") || url.startsWith("https://");

/**
 * Start keeping the page's traffic. Called before the page is opened, so the document itself is
 * the first thing kept; `stop` reads out whatever is still in the browser and returns the visit.
 */
export async function recordSite(page: Page): Promise<{ stop(): Promise<SiteRecording> }> {
	// Re-enabled rather than enabled: the buffer sizes are only read when the domain comes up.
	await page.send("Network.disable");
	await page.send("Network.enable", { maxTotalBufferSize: BROWSER_BUFFER_BYTES, maxResourceBufferSize: BROWSER_RESOURCE_BYTES });
	// A cached answer has no body to hand over, and a site's own service worker would answer in the
	// network's place with whatever it had decided to keep.
	await page.send("Network.setCacheDisabled", { cacheDisabled: true });
	await page.send("Network.setBypassServiceWorker", { bypass: true });

	const pending = new Map<string, Pending>();
	const exchanges: Exchange[] = [];
	const redirects: Array<[string, string]> = [];
	const skipped: Record<string, number> = {};
	const reads: Array<Promise<void>> = [];
	let document = "";
	const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

	const keep = async (requestId: string, entry: Pending) => {
		const response = entry.response;
		if (!response) return;
		const postData = entry.hasPostData && entry.postData === undefined ? await requestBody(page, requestId) : entry.postData;
		const exchange: Exchange = {
			url: entry.url,
			method: entry.method,
			status: response.status,
			headers: Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
			mime: response.mimeType,
			kind: entry.kind,
		};
		if (postData !== undefined) exchange.bodyHash = sha256(postData);
		const body = await responseBody(page, requestId);
		if (body && body.byteLength <= MAX_BODY_BYTES) exchange.body = body;
		else if (body) skip("larger than a copy should carry");
		exchanges.push(exchange);
	};

	const stopListening = [
		page.on("Network.requestWillBeSent", (params) => {
			const requestId = String(params.requestId);
			const request = params.request as { url: string; method: string; postData?: string; hasPostData?: boolean };
			if (!isHttp(request.url)) return;
			const earlier = pending.get(requestId);
			// The same request again with a redirect attached: the first address sent it to this one.
			if (earlier && params.redirectResponse) redirects.push([earlier.url, request.url]);
			if (params.type === "Document" && !document) document = request.url;
			else if (params.type === "Document" && earlier?.url === document) document = request.url;
			pending.set(requestId, {
				url: request.url,
				method: request.method,
				kind: String(params.type ?? "Other"),
				postData: request.postData,
				hasPostData: Boolean(request.hasPostData),
			});
		}),
		page.on("Network.responseReceived", (params) => {
			const entry = pending.get(String(params.requestId));
			if (entry) entry.response = params.response as Pending["response"];
		}),
		page.on("Network.loadingFinished", (params) => {
			const requestId = String(params.requestId);
			const entry = pending.get(requestId);
			if (!entry) return;
			pending.delete(requestId);
			reads.push(keep(requestId, entry));
		}),
		page.on("Network.loadingFailed", (params) => {
			if (pending.delete(String(params.requestId))) skip(params.canceled ? "given up on by the page" : "failed on the way");
		}),
		page.on("Network.webSocketCreated", () => skip("web sockets, which cannot be played back")),
	];

	return {
		async stop() {
			for (const off of stopListening) off();
			await Promise.race([Promise.allSettled(reads), Bun.sleep(DRAIN_TIMEOUT_MS)]);
			await refetchMissing(exchanges, skip);
			return { document, exchanges: lastAnswers(exchanges), redirects, skipped };
		},
	};
}

async function responseBody(page: Page, requestId: string): Promise<Uint8Array | null> {
	try {
		const result = (await page.send("Network.getResponseBody", { requestId }, 60_000)) as { body?: string; base64Encoded?: boolean };
		if (result.body === undefined) return null;
		return result.base64Encoded ? new Uint8Array(Buffer.from(result.body, "base64")) : new TextEncoder().encode(result.body);
	} catch {
		// Evicted from the browser's buffer, or a response that never had a body to keep.
		return null;
	}
}

async function requestBody(page: Page, requestId: string): Promise<string | undefined> {
	try {
		const result = (await page.send("Network.getRequestPostData", { requestId })) as { postData?: string };
		return result.postData;
	} catch {
		return undefined;
	}
}

/** Bodies the browser no longer had are asked for once more, from here, through the guard. */
async function refetchMissing(exchanges: Exchange[], skip: (why: string) => void): Promise<void> {
	const bodiless = new Set([101, 204, 205, 304]);
	for (const exchange of exchanges) {
		if (exchange.body || exchange.method !== "GET" || exchange.status >= 300 || bodiless.has(exchange.status)) continue;
		const again = await guardedFetch(exchange.url, REFETCH_LIMITS);
		if ("reject" in again) skip("gone from the browser and not given twice");
		else exchange.body = again.bytes;
	}
}

/**
 * One answer per request. A page that asks the same thing twice — a poll, a retry, a chunk two
 * components both import — is given, on playback, the last good answer it got.
 */
function lastAnswers(exchanges: Exchange[]): Exchange[] {
	const byRequest = new Map<string, Exchange>();
	for (const exchange of exchanges) {
		const key = `${exchange.method} ${exchange.url} ${exchange.bodyHash ?? ""}`;
		const held = byRequest.get(key);
		const better = !held || exchange.status < 400 || held.status >= 400;
		if (better) byRequest.set(key, exchange);
	}
	return [...byRequest.values()];
}
