// The network, for a page being run from a recording of it.
//
// Served with a first line the server writes — `const SITE = { origin }`, the origin the page was
// recorded at — and registered over the whole of the copy's own origin. From then on every request
// the page makes comes here first: its document, its scripts and chunks, its pictures, and what it
// asks of its API, on whatever host. Each is turned back into the address the real page asked for
// and answered from the recording (site-serve.ts), or not answered at all. Nothing is passed on to
// the network, so the page cannot tell it is not where it was, and cannot reach anything it was not
// recorded reaching: it is the same code, with the same answers, going nowhere.
//
// Only the copy's own plumbing under /__brain/ goes through untouched.

const OURS = "/__brain/";
/** Statuses the platform refuses to build a response with a body for. */
const BODILESS = new Set([101, 204, 205, 304]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.protocol !== "http:" && url.protocol !== "https:") return;
	if (url.origin === self.location.origin && url.pathname.startsWith(OURS)) return;
	event.respondWith(replay(event.request, url));
});

/** The address the real page would have been asking for. */
function recordedAddress(url) {
	return url.origin === self.location.origin ? SITE.origin + url.pathname + url.search : url.href;
}

async function bodyHash(request) {
	if (request.method === "GET" || request.method === "HEAD") return "";
	const bytes = await request.clone().arrayBuffer();
	if (bytes.byteLength === 0) return "";
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function replay(request, url) {
	const asked = new URLSearchParams({ u: recordedAddress(url), m: request.method });
	const hash = await bodyHash(request);
	if (hash) asked.set("h", hash);
	if (request.mode === "navigate") asked.set("nav", "1");
	const recorded = await fetch(OURS + "r?" + asked);
	// Built anew rather than handed on. A response that came from a fetch carries the address it
	// was fetched from, and a stylesheet or a document resolves every relative address inside it
	// against that — so handed on as it is, a page's fonts and chunks are all looked for under
	// /__brain/. One made here has no address of its own and takes the request's.
	return new Response(BODILESS.has(recorded.status) ? null : recorded.body, {
		status: recorded.status,
		statusText: recorded.statusText,
		headers: recorded.headers,
	});
}
