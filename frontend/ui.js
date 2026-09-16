// The DOM/fetch primitives every dashboard tab needs. They lived in settings.js until the
// Designs tab needed the same ones; copying them a second time is how a codebase ends up
// so a new tab does not have to restate them. settings.js and brain.js still carry
// their own copies; folding those in is a separate change from adding a tab.
//
// `api` deliberately takes a relative path. server.ts rejects any POST whose
// Sec-Fetch-Site or Origin says it came from another page, and a relative URL is what
// makes the browser send "same-origin" for both. Never route a POST through a full
// URL or a custom fetch mode — the guard will 403 it.

/** For static markup written in this repo. Anything from a user, a model or the disk
 *  belongs in text() instead. */
export function el(tag, className, html) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

export function text(tag, className, value) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.textContent = value ?? "";
	return node;
}

/**
 * Icons, as geometry. A multiplication sign is not a close icon: the glyph sits wherever
 * the font puts it, which in a system stack is above the optical centre, and no amount of
 * centring the box will centre the mark inside it. Two strokes in a square viewBox are
 * centred by construction, at any size, in any font.
 */
const ICONS = {
	close: '<path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
};

export function icon(name, size = 14) {
	return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

/** A square button whose only content is an icon, and which therefore needs a label. */
export function iconButton(className, name, label) {
	const node = el("button", className, icon(name));
	node.type = "button";
	node.setAttribute("aria-label", label);
	node.title = label;
	return node;
}

/** For the callers that still assemble a string of markup by hand. */

/**
 * Resolves to an object, always. A daemon restarted mid-session answers a plain 404 with a
 * text/plain body, and an endpoint this build does not know about answers the same way —
 * both are ordinary states for a local tool, not programming errors. Rejecting there would
 * abort the caller before it renders anything, leaving a blank tab and a console trace; the
 * failure belongs in the value, where the caller can put it on screen.
 */
export async function api(path, body) {
	let res;
	try {
		res = await fetch(path, body === undefined
			? undefined
			: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		return { error: "the brain is not responding" };
	}
	const data = await res.json().catch(() => null);
	if (data && typeof data === "object") return data;
	return { error: res.ok ? "the brain sent a reply this page cannot read" : `request failed (${res.status})` };
}
