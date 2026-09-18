// A copy that completes itself.
//
// A recording holds what one visit touched. The visit is thorough — it scrolls everything into
// view and presses what can be pressed — but a site is larger than any visit: a dialog nobody
// opened has pictures in it, a route nobody followed has a chunk of its own. Asked for one of
// those, the copy had nothing, and the page showed a hole where the site shows a face.
//
// So what is missing is asked for once, from the site, and kept with the rest; the next time it is
// the recording that answers. Only what could not have mattered to ask anyway:
//
//   a GET, because asking again for something to read changes nothing, and sending a POST for the
//   page would be doing things on the site in the user's name;
//
//   from a host the page was already seen talking to, so the page gains nowhere new to send
//   anything — it runs fenced precisely so that it cannot choose where requests go;
//
//   through the same guard as every other fetch this package makes, which refuses this machine
//   and its network whatever a name resolves to.

import type { ArchiveEntry, SiteArchive } from "./site-archive";
import { type FetchLimits, type GuardedResponse, type Rejected, guardedFetch } from "./url-guard";

const FILL_LIMITS: FetchLimits = { maxBytes: 48 * 1024 * 1024, timeoutMs: 20_000, stallMs: 8_000, accept: [] };

type Fetcher = (url: string, limits: FetchLimits) => Promise<GuardedResponse | Rejected>;

/** What the site has already refused, so it is asked once: a page asks for a missing picture on every render. */
const refused = new WeakMap<SiteArchive, Set<string>>();
const asking = new WeakMap<SiteArchive, Map<string, Promise<ArchiveEntry | null>>>();

/** Hosts this page has an answer from, which is every host it could already reach. */
function knownHosts(archive: SiteArchive): Set<string> {
	const hosts = new Set([new URL(archive.manifest.document).host]);
	for (const entry of archive.manifest.entries) hosts.add(new URL(entry.url).host);
	return hosts;
}

export function mayFill(archive: SiteArchive, url: string): boolean {
	try {
		return knownHosts(archive).has(new URL(url).host);
	} catch {
		return false;
	}
}

export function fillIn(archive: SiteArchive, url: string, fetcher: Fetcher = guardedFetch): Promise<ArchiveEntry | null> {
	const gaveUp = refused.get(archive) ?? new Set<string>();
	refused.set(archive, gaveUp);
	const underWay = asking.get(archive) ?? new Map<string, Promise<ArchiveEntry | null>>();
	asking.set(archive, underWay);
	if (gaveUp.has(url) || !mayFill(archive, url)) return Promise.resolve(null);

	const already = underWay.get(url);
	if (already) return already;
	const answer = (async () => {
		const fetched = await fetcher(url, FILL_LIMITS);
		if ("reject" in fetched) {
			gaveUp.add(url);
			return null;
		}
		const mime = fetched.contentType.split(";")[0]!.trim();
		const headers: Array<[string, string]> = fetched.contentType ? [["content-type", fetched.contentType]] : [];
		// Kept under the address that was asked for; where the site sent the request on to is its
		// business, and the page will ask for this one again.
		return archive.add({ url, method: "GET", status: fetched.status, headers, mime, kind: "Filled" }, fetched.bytes);
	})().finally(() => underWay.delete(url));
	underWay.set(url, answer);
	return answer;
}
