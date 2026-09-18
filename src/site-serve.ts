// Serving a recorded site so that its own code runs again.
//
// Each copy gets an origin to itself — <key>.localhost, which every browser resolves to this
// machine without being told to — and is served there at the paths it had. That is what lets the
// page's code run unedited: an address written "/assets/app.js" still means what it meant, the
// router still sees the path it was written for, and nothing in a bundle has to be found and
// rewritten. It also keeps a stranger's script off the dashboard's origin, where it would be able
// to read everything the dashboard can.
//
// The copy's origin answers three things and nothing else:
//
//   /__brain/worker.js   the service worker that stands in for the network (runtime/site-worker.js)
//   /__brain/r           one recorded answer, to the worker and only to the worker
//   anything else        a page that installs the worker and reloads — never the recording itself
//
// The last is the fence. The page's code is only ever handed over through the worker, to a
// document the worker controls, where every request it makes is answered from the recording or
// refused. A reload that skips the worker, an address typed by hand, the page trying to register a
// worker of its own: each gets the installer, which is this package's code and nobody else's.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveEntry, SiteArchive } from "./site-archive";

const WORKER_SOURCE = readFileSync(join(import.meta.dir, "runtime", "site-worker.js"), "utf-8");
const OURS = "/__brain/";
const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The copy a request is for, from the host it was sent to; null for the dashboard's own hosts. */
export function mirrorKey(host: string | null): string | null {
	const name = (host ?? "").toLowerCase().replace(/:\d+$/, "");
	if (!name.endsWith(".localhost")) return null;
	const key = name.slice(0, -".localhost".length);
	return KEY.test(key) ? key : null;
}

export const mirrorOrigin = (key: string, port: number) => `http://${key}.localhost:${port}`;

/**
 * Headers that described the connection the recording was made over, or that would let the
 * recorded site rearrange the copy's own origin: its cookies, its framing, its policy, its worker.
 */
const NOT_REPLAYED = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"location",
	"set-cookie",
	"set-cookie2",
	"strict-transport-security",
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"clear-site-data",
	"alt-svc",
	"report-to",
	"reporting-endpoints",
	"nel",
]);

/** Destinations a browser names when it means to show the answer as a page. */
const SHOWN_AS_A_PAGE = new Set(["document", "iframe", "frame", "embed", "object"]);

export interface MirrorOptions {
	/** Origins allowed to show the copy in a frame: the dashboard's own. */
	embedders: string[];
	/** Asks the site for what the visit never caught and keeps it (site-fill.ts); absent, the copy stays as recorded. */
	fill?: (url: string) => Promise<ArchiveEntry | null>;
	/** Told of each request that went unanswered all the same. */
	onMiss?: (method: string, url: string) => void;
}

export async function serveMirror(req: Request, archive: SiteArchive, options: MirrorOptions): Promise<Response> {
	const url = new URL(req.url);
	if (url.pathname === `${OURS}worker.js`) return worker(archive);
	if (url.pathname === `${OURS}r`) return recorded(req, url, archive, options);
	return html(INSTALLER);
}

function worker(archive: SiteArchive): Response {
	const site = { origin: new URL(archive.manifest.document).origin };
	return new Response(`const SITE = ${JSON.stringify(site)};\n${WORKER_SOURCE}`, {
		headers: {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-store",
			// Its own path is under /__brain/; this is what lets it speak for the whole origin.
			"service-worker-allowed": "/",
		},
	});
}

async function recorded(req: Request, url: URL, archive: SiteArchive, options: MirrorOptions): Promise<Response> {
	// Asked for by a worker's fetch, this is data. Opened as a page it would be the recorded
	// site's code running on this origin with no worker over it.
	if (SHOWN_AS_A_PAGE.has(req.headers.get("sec-fetch-dest") ?? "")) return new Response("not a page", { status: 403 });

	const asked = url.searchParams.get("u") ?? "";
	const method = (url.searchParams.get("m") ?? "GET").toUpperCase();
	const navigating = url.searchParams.get("nav") === "1";
	const reading = method === "GET" || method === "HEAD";
	const entry =
		archive.find(reading ? "GET" : method, asked, url.searchParams.get("h") ?? undefined) ?? (reading && options.fill ? await options.fill(asked) : null);
	const path = entry ? archive.bodyPath(entry) : null;
	if (!entry || (!path && entry.bytes > 0)) {
		options.onMiss?.(method, asked);
		return navigating ? html(notRecorded(asked, archive), 404) : new Response(null, { status: 404 });
	}

	const headers = replayedHeaders(entry);

	if (navigating && isHtml(entry)) {
		headers.set("content-security-policy", documentPolicy(options.embedders));
		const markup = path ? await Bun.file(path).text() : "";
		return new Response(preparedDocument(markup), { status: entry.status, headers });
	}
	const body = method === "HEAD" || !path ? null : Bun.file(path);
	return new Response(body, { status: entry.status, headers });
}

function replayedHeaders(entry: ArchiveEntry): Headers {
	const headers = new Headers({ "cache-control": "no-store" });
	for (const [name, recordedValue] of entry.headers) {
		if (NOT_REPLAYED.has(name)) continue;
		// The browser reports a header sent several times as one value with line breaks in it.
		for (const value of recordedValue.split("\n")) {
			try {
				headers.append(name, value);
			} catch {
				// A header this runtime will not carry is left out; the answer still goes.
			}
		}
	}
	if (!headers.has("content-type") && entry.mime) headers.set("content-type", entry.mime);
	return headers;
}

const isHtml = (entry: ArchiveEntry) => /html/i.test(entry.mime);

/**
 * What the copy's document may do that a request cannot be made to show: open a socket. Every
 * http(s) request reaches the worker and is answered from the recording; a web socket never does,
 * so it is the one way out, and it is closed here. The page's own policy is not kept — it names
 * the origin the page used to live at.
 */
const documentPolicy = (embedders: string[]) => `connect-src http: https: data: blob:; frame-ancestors ${embedders.join(" ") || "'none'"}`;

/** Run ahead of the page's own scripts, in its document. */
const DOCUMENT_PREAMBLE = `<script>(() => {
	try { sessionStorage.removeItem("brain-site-tries"); } catch (e) {}
	// The copy already has a worker, and it is the recording. A page that registers its own is
	// told it has one, rather than being left to fetch a script that is not there.
	const workers = navigator.serviceWorker;
	if (workers) workers.register = () => workers.ready;
})();</script>`;

function preparedDocument(markup: string): string {
	const withoutPolicy = markup.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
	const head = withoutPolicy.match(/<head\b[^>]*>/i);
	if (!head || head.index === undefined) return DOCUMENT_PREAMBLE + withoutPolicy;
	const at = head.index + head[0].length;
	return withoutPolicy.slice(0, at) + DOCUMENT_PREAMBLE + withoutPolicy.slice(at);
}

const html = (markup: string, status = 200) =>
	new Response(markup, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

function notRecorded(asked: string, archive: SiteArchive): string {
	const home = new URL(archive.manifest.document);
	return `<!doctype html><meta charset="utf-8"><title>Not in this copy</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem">
<h1 style="font-size:1.25rem;font-weight:600">This page is not in the copy</h1>
<p><code>${escapeHtml(asked)}</code> was never opened while the site was being recorded, so there is nothing to play back for it.</p>
<p><a href="${escapeHtml(home.pathname + home.search)}">Back to the recorded page</a></p>`;
}

/**
 * The page every address on the copy's origin gives to anything that is not the worker: it
 * installs the worker and reloads, and the reload is the recording. Blank unless it cannot start.
 */
const INSTALLER = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Opening the copy</title>
<body style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem">
<p id="note"></p>
<script>
(async () => {
	const note = (text) => { document.getElementById("note").textContent = text; };
	if (!("serviceWorker" in navigator)) return note("This browser will not run a service worker here, and the copy cannot be played without one.");
	let tries = 0;
	try { tries = Number(sessionStorage.getItem("brain-site-tries") || "0"); } catch (e) {}
	const remember = (count) => { try { count ? sessionStorage.setItem("brain-site-tries", String(count)) : sessionStorage.removeItem("brain-site-tries"); } catch (e) {} };
	if (tries >= 3) { remember(0); return note("The copy's service worker did not take control of this page. Reload to try again."); }
	remember(tries + 1);
	await navigator.serviceWorker.register("${OURS}worker.js", { scope: "/" });
	await navigator.serviceWorker.ready;
	location.reload();
})().catch((error) => { document.getElementById("note").textContent = "The copy could not start: " + error.message; });
</script>`;
