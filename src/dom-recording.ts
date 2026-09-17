// What a page's JavaScript does to its own DOM, recorded so a rebuild can do it again.
//
// A transplant is the page at one instant. Most of what makes a page feel alive is not in that
// instant: a demo that types into a search field when it scrolls into view, cards that light up
// in sequence, stars that twinkle, a tab indicator that slides. On the page, script does all of
// it by changing the DOM — a class here, an inline style there, a text node, a panel swapped for
// another. Those changes are data, and data can be recorded and played back without the script.
//
// The recording is tied to the transplant by one idea: node identity by serialisation order.
// The moment the transplant is serialised, every node that will exist in the rebuild is given a
// number by walking the live DOM in exactly the order the serialised document will be parsed
// back — skipping what the transplant removes, merging text nodes the parser will merge. The
// rebuild's runtime walks its own DOM with the same code and arrives at the same numbers. A
// change recorded against node 1412 is then a change to node 1412 on both sides.
//
// Every change carries the time it happened, and the scroll position is recorded as it moves, so
// the tapes built from this (dom-tapes.ts) can say not just what changed but what set it off: the
// page loading, an element coming into view, a pointer, a click.
//
// Real time, not the virtual clock the scene capture uses. A page's DOM animation is driven by
// its timers and CSS transitions as much as by animation frames, and those run on the wall clock;
// stamped on a virtual clock that fell behind it, a typing demo was recorded compressed and played
// back several times too fast. So the recording visit runs without that clock, and the recorder
// reads Date.now, which no harness here virtualises, in case one is installed anyway.

import type { Page } from "./cdp";
import { readLarge } from "./parity-hooks";

/**
 * The walk both sides share: capture and the rebuild's runtime. Plain JavaScript, installed as
 * `window.__brainWalk`. `visit(node, id)` is called for each node in order; a text run — adjacent
 * text nodes the HTML parser will merge into one — is visited once, as an array of its nodes.
 */
export const CANON_WALKER = String.raw`
window.__brainWalk = window.__brainWalk || (function () {
	const REMOVED = /^(SCRIPT|NOSCRIPT|IFRAME|OBJECT|EMBED)$/;
	// What the transplant leaves out. A <style> in the document is folded into the rebuild's own
	// stylesheet; one inside a shadow root is the only thing styling that root, so it stays.
	const removed = (el, inShadow) => {
		if (REMOVED.test(el.tagName)) return true;
		if (el.tagName === "STYLE") return !inShadow;
		if (el.tagName === "LINK") return /\b(preload|prefetch|modulepreload|stylesheet)\b/i.test(el.getAttribute("rel") || "");
		return false;
	};
	// One sequence of siblings as the serialised document will have it: removed elements gone,
	// empty text gone, and consecutive text nodes — including ones only separated by something
	// removed — as a single run.
	const sequence = (nodes, inShadow, out) => {
		let run = null;
		for (const node of nodes) {
			if (node.nodeType === 3) {
				if (node.data.length === 0) continue;
				if (run) run.push(node);
				else { run = [node]; out.push([run, inShadow]); }
				continue;
			}
			if (node.nodeType === 1 && removed(node, inShadow)) continue;
			run = null;
			if (node.nodeType === 1 || node.nodeType === 8) out.push([node, inShadow]);
		}
	};
	// A shadow host serialises its shadow root first, as a declarative template, then its light
	// children; the two never share a text run.
	const children = (parent, inShadow) => {
		const out = [];
		if (parent.shadowRoot) sequence(Array.from(parent.shadowRoot.childNodes), true, out);
		sequence(Array.from(parent.childNodes), inShadow, out);
		return out;
	};
	return function walk(root, firstId, visit) {
		let next = firstId;
		const step = (node, inShadow) => {
			visit(node, next++);
			if (Array.isArray(node) || node.nodeType !== 1 || node.tagName === "TEMPLATE") return;
			for (const [child, childInShadow] of children(node, inShadow)) step(child, childInShadow);
		};
		for (const [child, childInShadow] of children(root, false)) step(child, childInShadow);
		return next;
	};
})();
`;

/**
 * Installed before the page's own scripts. It wraps what a MutationObserver cannot see — a value
 * typed into an input, a scroll offset set from script, an animation started through the Web
 * Animations API — and waits. `window.__domRecorder.start()` is called by the transplant at the
 * instant it serialises, so the numbering and the first recorded change share a baseline.
 */
export const RECORDER_SCRIPT = String.raw`(() => {
	if (window.__domRecorder) return;
	${CANON_WALKER}
	const MAX_OPS = 250000;
	const recorder = { on: false, ops: [], ids: new WeakMap(), next: 0, scroll: [], rects: [], dropped: 0 };
	window.__domRecorder = recorder;
	// The wall clock. performance.now may be a harness's virtual clock, and a page's timers and
	// transitions — most of what moves its DOM — do not run on that.
	const now = () => Date.now();
	const push = (op) => {
		if (!recorder.on) return;
		if (recorder.ops.length >= MAX_OPS) { recorder.dropped++; return; }
		recorder.ops.push([now()].concat(op));
	};
	const idOf = (node) => (node ? recorder.ids.get(node) : undefined);

	// Properties the DOM does not reflect into attributes.
	const wrapSetter = (proto, name) => {
		const d = proto && Object.getOwnPropertyDescriptor(proto, name);
		if (!d || !d.set) return;
		Object.defineProperty(proto, name, Object.assign({}, d, {
			set(value) {
				const id = idOf(this);
				const read = () => (name === "scrollTop" || name === "scrollLeft" ? Math.round(d.get.call(this)) : String(d.get.call(this)));
				const before = id !== undefined ? read() : undefined;
				d.set.call(this, value);
				if (id !== undefined) push(["p", id, name, read(), before]);
			},
		}));
	};
	wrapSetter(HTMLInputElement.prototype, "value");
	wrapSetter(HTMLTextAreaElement.prototype, "value");
	wrapSetter(HTMLInputElement.prototype, "checked");
	wrapSetter(Element.prototype, "scrollTop");
	wrapSetter(Element.prototype, "scrollLeft");
	// Scrolling inside the page — a reel that slides to the next panel, a list that follows its
	// selection — reaches the DOM through neither an attribute nor a setter that can be wrapped: a
	// page may call scrollTo, or start a smooth scroll that runs over many frames. So the scroll
	// events themselves are recorded, at most one every 50 ms per element, and always the position
	// the element settles on.
	const SCROLL_SAMPLE_MS = 50;
	const SCROLL_SETTLE_MS = 120;
	const scrolled = new Map();
	const readScroll = (el, id) => {
		const state = scrolled.get(id);
		const [left, top] = [Math.round(el.scrollLeft), Math.round(el.scrollTop)];
		if (state.left !== left) push(["p", id, "scrollLeft", left, state.left]);
		if (state.top !== top) push(["p", id, "scrollTop", top, state.top]);
		state.left = left;
		state.top = top;
	};
	addEventListener(
		"scroll",
		(event) => {
			const el = event.target;
			if (!recorder.on || !el || el === document || el === document.documentElement || el === window) return;
			const id = idOf(el);
			if (id === undefined) return;
			let state = scrolled.get(id);
			if (!state) {
				state = { left: null, top: null, at: 0, timer: 0 };
				scrolled.set(id, state);
			}
			const now = Date.now();
			if (now - state.at >= SCROLL_SAMPLE_MS) {
				state.at = now;
				readScroll(el, id);
			}
			clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				state.at = Date.now();
				readScroll(el, id);
			}, SCROLL_SETTLE_MS);
		},
		true,
	);

	const animate = Element.prototype.animate;
	if (animate) {
		Element.prototype.animate = function (keyframes, options) {
			const id = idOf(this);
			if (id !== undefined) {
				// Infinity, the usual iteration count of a loop, is not JSON; it travels as a string.
				const plain = (value) => JSON.parse(JSON.stringify(value, (key, v) => (v === Infinity ? "Infinity" : v)));
				try { push(["w", id, plain(keyframes), typeof options === "number" ? { duration: options } : plain(options || {})]); } catch (e) { /* keyframes that will not serialise */ }
			}
			return animate.apply(this, arguments);
		};
	}

	// The same cleaning the transplant applies to what it serialises.
	const absolute = (value) => { try { return new URL(value, location.href).href; } catch (e) { return value; } };
	const serialise = (parent) => {
		const html = parent.getHTML ? parent.getHTML({ serializableShadowRoots: true }) : parent.innerHTML;
		const template = document.createElement("template");
		template.innerHTML = html;
		const clean = (root, inShadow) => {
			for (const node of Array.from(root.querySelectorAll("script, noscript, iframe, object, embed, link[rel=preload], link[rel=prefetch], link[rel=modulepreload], link[rel=stylesheet]" + (inShadow ? "" : ", style")))) node.remove();
			for (const node of Array.from(root.querySelectorAll("*"))) {
				for (const attr of Array.from(node.attributes || [])) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
				const href = node.getAttribute("href");
				if (href && /^javascript:/i.test(href)) node.removeAttribute("href");
				else if (node.tagName === "A" && href && !href.startsWith("#")) node.setAttribute("href", absolute(href));
				if (node.tagName === "TEMPLATE") clean(node.content, inShadow || node.hasAttribute("shadowrootmode"));
			}
		};
		clean(template.content, false);
		return template.innerHTML;
	};
	// Number a subtree's descendants from the recorder's counter, in the shared order.
	const number = (root) => {
		recorder.next = window.__brainWalk(root, recorder.next, (node, id) => {
			if (Array.isArray(node)) for (const part of node) recorder.ids.set(part, id);
			else recorder.ids.set(node, id);
		});
	};

	// The harness says what it is about to do, so the changes that follow can be filed under it.
	recorder.mark = (kind, id) => { if (recorder.on) recorder.ops.push([now(), "m", id, kind]); };
	// Elements a person could plausibly interact with, on screen now, as ids. Links that go
	// somewhere and submit buttons are left alone: following them would end the recording. A link
	// to a fragment stays — tabs are often exactly that.
	recorder.interactive = (limit) => {
		const found = [];
		const seen = new Set();
		recorder.targets = new Map();
		const candidates = document.querySelectorAll('[role=tab], [role=button], [aria-controls], [aria-expanded], [aria-selected], [data-state], button, summary, [tabindex="0"], label');
		const pointer = Array.from(document.querySelectorAll("body *")).filter((el) => el.childElementCount < 6 && getComputedStyle(el).cursor === "pointer");
		for (const el of [...Array.from(candidates), ...pointer]) {
			if (found.length >= limit) break;
			if (seen.has(el)) continue;
			seen.add(el);
			if (el.closest("a[href]:not([href^='#'])") || (el.tagName === "BUTTON" && (el.type === "submit")) || el.closest("form")) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
			const id = recorder.ids.get(el);
			if (id === undefined) continue;
			recorder.targets.set(id, el);
			found.push(id);
		}
		return found;
	};
	// Where to put the pointer for a target now: pages move while they are probed — a demo
	// re-renders, a panel opens — and a point read a few probes ago may be over something else.
	// Null when the target is gone, off screen, or covered.
	recorder.pointAt = (id) => {
		const el = recorder.targets && recorder.targets.get(id);
		if (!el || !el.isConnected) return null;
		const r = el.getBoundingClientRect();
		if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
		const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2));
		const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2));
		const hit = document.elementFromPoint(x, y);
		return hit && (hit === el || el.contains(hit)) ? [x, y] : null;
	};

	// What has changed in a band of the page since a given op, so a sweep can tell whether what it
	// is looking at has finished. A node made after the baseline has no box; it belongs to whatever
	// was re-rendered, which is what is being watched.
	const inBand = (index, top, bottom, visit) => {
		for (let i = Math.max(0, index); i < recorder.ops.length; i++) {
			const id = recorder.ops[i][2];
			const box = recorder.boxes.get(id);
			if (!box || (box[0] < bottom && box[1] > top)) visit(id);
		}
	};
	/** Which nodes changed in the band: the page's own background churn, when read from elsewhere. */
	recorder.movers = (index, top, bottom) => {
		const seen = new Set();
		inBand(index, top, bottom, (id) => seen.add(id));
		return Array.from(seen);
	};
	/** How many changes in the band were to anything other than those nodes. */
	recorder.activityBesides = (index, top, bottom, known) => {
		const ignore = new Set(known);
		let n = 0;
		inBand(index, top, bottom, (id) => {
			if (!ignore.has(id)) n++;
		});
		return n;
	};

	recorder.start = () => {
		recorder.ids = new WeakMap();
		recorder.next = 0;
		number(document.body);
		// The tree, and where every element was in document coordinates, so a tape can find the
		// component a change belongs to and say when it came into view from the scroll alone.
		// [id, parent id, top, bottom]; -1 for a node with no box. The body is the root, id -1.
		const rects = [];
		window.__brainWalk(document.body, 0, (node, id) => {
			const first = Array.isArray(node) ? node[0] : node;
			const parentNode = first.parentNode && first.parentNode.host ? first.parentNode.host : first.parentNode;
			const parent = parentNode === document.body ? -1 : (recorder.ids.get(parentNode) ?? -1);
			if (Array.isArray(node) || node.nodeType !== 1) { rects.push([id, parent, -1, -1]); return; }
			const r = node.getBoundingClientRect();
			rects.push(r.width || r.height ? [id, parent, Math.round(r.top + scrollY), Math.round(r.bottom + scrollY)] : [id, parent, -1, -1]);
		});
		recorder.rects = rects;
		recorder.boxes = new Map(rects.filter((r) => r[2] >= 0).map((r) => [r[0], [r[2], r[3]]]));
		recorder.base = now();
		recorder.on = true;

		const observer = new MutationObserver((records) => {
			if (!recorder.on) return;
			// A parent whose children changed is serialised once, as it stands after the batch;
			// anything else the batch did inside it is already in that serialisation.
			const rebuilt = new Set();
			for (const r of records) if (r.type === "childList" && idOf(r.target) !== undefined) rebuilt.add(r.target);
			const inside = (node) => { for (let p = node; p; p = p.parentNode || (p.host || null)) if (rebuilt.has(p)) return p !== node || false; return false; };
			for (const parent of rebuilt) {
				let covered = false;
				for (let p = parent.parentNode; p; p = p.parentNode || p.host) if (rebuilt.has(p)) { covered = true; break; }
				if (covered) continue;
				const first = recorder.next;
				number(parent);
				push(["c", idOf(parent), serialise(parent), first]);
			}
			for (const r of records) {
				if (r.type === "childList") continue;
				const target = r.type === "characterData" ? r.target : r.target;
				if (inside(target)) continue;
				const id = idOf(target);
				if (id === undefined) continue;
				// Each change carries the value it replaced, so a tape can say what state an element was
				// in at any moment, not only what changed.
				if (r.type === "attributes") push(["a", id, r.attributeName, target.getAttribute(r.attributeName), r.oldValue]);
				else if (r.type === "characterData") {
					// The run's whole text, which is what the rebuild holds as one node.
					let text = "";
					let old = "";
					const parent = target.parentNode;
					if (parent) {
						for (const n of parent.childNodes) {
							if (n.nodeType !== 3 || recorder.ids.get(n) !== id) continue;
							text += n.data;
							old += n === target ? (r.oldValue ?? "") : n.data;
						}
					}
					push(["t", id, text, old]);
				}
			}
		});
		observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
		recorder.observer = observer;
		// Stamped from the scroll event itself. An IntersectionObserver reacting to the same scroll
		// runs later in that frame; sampling scrollY on the next animation frame instead filed the
		// reaction to leaving view as something that happened while still in it.
		let lastY = -1;
		const track = () => {
			if (!recorder.on || scrollY === lastY) return;
			recorder.scroll.push([now(), Math.round(scrollY)]);
			lastY = scrollY;
		};
		addEventListener("scroll", track, { passive: true });
		track();
		return recorder.next;
	};
})()`;

export interface DomRecording {
	/** When the baseline was taken, in wall-clock milliseconds; every op time is later. */
	base: number;
	/** When recording stopped. */
	end?: number;
	viewport: { width: number; height: number };
	ops: Array<[number, ...unknown[]]>;
	/** [time, scrollY] whenever the scroll position changed. */
	scroll: Array<[number, number]>;
	/** [id, parent id, top, bottom] of every node at the baseline; -1 where there is no box or parent. */
	rects: Array<[number, number, number, number]>;
	dropped: number;
}

export interface ExploreOptions {
	viewport: { width: number; height: number };
	/** Nothing but time, at the top of the page. */
	idleFrames?: number;
	/** How far each scroll step moves, as a share of the viewport, and how long it rests. */
	stepShare?: number;
	dwellFrames?: number;
	/** The longest the sweep stays with a screen that is still changing, and how long it waits
	 * after the last thing changed before moving on. */
	watchFrames?: number;
	patienceFrames?: number;
	/** The longest a section still going when the sweep left it is watched for again. */
	revisitFrames?: number;
	/** How many elements per screen are hovered and clicked. 0 skips interaction. */
	probesPerScreen?: number;
	/** Called as the page is driven, with what is happening and how far through it is. */
	onProgress?: (stage: string, progress: number, detail?: string) => void;
}

/**
 * Drive the page the way a reader would — wait, scroll down through it, come back up — then go
 * back to anything that was still changing when the sweep moved on and watch it until it stops or
 * has run long enough to loop, and last, in each screen, hover and click what looks interactive.
 */
export async function explore(page: Page, options: ExploreOptions): Promise<DomRecording | null> {
	const { viewport } = options;
	const say = options.onProgress ?? (() => {});
	const idle = options.idleFrames ?? 300;
	const dwell = options.dwellFrames ?? 120;
	const step = Math.round(viewport.height * (options.stepShare ?? 0.6));
	// Frames at sixty a second, waited in real time.
	const advance = (frames: number) => Bun.sleep(Math.round((frames * 1000) / 60));

	say("settling at the top of the page", 0);
	await advance(idle);
	const height = (await page.evaluate<number>("document.documentElement.scrollHeight")) ?? viewport.height;
	// Down the page, staying with a screen while something new is moving in it. New matters: a star
	// field twinkles whether or not anyone is there, and waiting for it to stop would mean waiting
	// for the whole page. So on arrival the sweep notes which nodes in this band were changing while
	// it was elsewhere — the background — and then counts only changes to anything else. A demo that
	// steps once every ten seconds keeps the sweep there; the stars around it do not.
	const watch = options.watchFrames ?? 1_500;
	const patience = options.patienceFrames ?? 480;
	const opsLength = async () => (await page.evaluate<number>("window.__domRecorder.ops.length")) ?? 0;
	const busy: Array<{ y: number; changes: number }> = [];
	let elsewhere = 0;
	for (let y = step; y < height; y += step) {
		say("reading down the page", 0.05 + 0.5 * (y / height), `${Math.round((y / height) * 100)}% of the way down`);
		await page.evaluate(`window.scrollTo(0, ${y}); true`);
		const arrival = await opsLength();
		const band = `${y}, ${y + viewport.height}`;
		const background = (await page.evaluate<number[]>(`window.__domRecorder.movers(${elsewhere}, ${band})`)) ?? [];
		const others = JSON.stringify(background);
		let [waited, quiet, changes, sawNew] = [0, 0, 0, false];
		do {
			const mark = await opsLength();
			await advance(dwell);
			waited += dwell;
			const fresh = (await page.evaluate<number>(`window.__domRecorder.activityBesides(${mark}, ${band}, ${others})`)) ?? 0;
			changes += fresh;
			if (fresh > 0) {
				sawNew = true;
				quiet = 0;
			} else {
				quiet += dwell;
			}
		} while (waited < watch && (sawNew ? quiet < patience : waited < dwell));
		elsewhere = arrival;
		if (waited >= watch) busy.push({ y, changes });
	}
	await advance(dwell);
	say("reading back up", 0.56);
	for (let y = height; y > 0; y -= step * 2) {
		await page.evaluate(`window.scrollTo(0, ${Math.max(0, y)}); true`);
		await advance(Math.round(dwell / 2));
	}
	await page.evaluate("window.scrollTo(0, 0); true");
	await advance(dwell);

	// Whatever was still going when the sweep gave up on it gets one longer look, busiest first.
	const revisit = options.revisitFrames ?? 1_800;
	const watching = busy.sort((a, b) => b.changes - a.changes).slice(0, 3);
	for (const [index, { y }] of watching.entries()) {
		say("watching what is still moving", 0.62 + 0.1 * (index / Math.max(1, watching.length)), `${index + 1} of ${watching.length}`);
		await page.evaluate(`window.scrollTo(0, ${y}); true`);
		await advance(revisit);
	}
	// Interaction: in each screen, hover what looks interactive, move away, click it. Every probe
	// is announced with a marker so its effects can be told from what was already moving.
	const probes = options.probesPerScreen ?? 8;
	if (probes > 0) {
		// The document, not the fragment: a tab that is a link to #design changes the hash and is
		// still the same page.
		const documentUrl = async () => ((await page.evaluate<string>("location.href")) ?? "").split("#")[0];
		const origin = await documentUrl();
		const away = { x: 2, y: viewport.height - 2 };
		// Nothing a probe does may take the recording's document away: a navigation to a new
		// document is failed at the network before it can replace this one.
		const unblock = page.on("Fetch.requestPaused", (params) => {
			page.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" }).catch(() => {});
		});
		await page.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
		probing: for (let y = 0; y < height; y += viewport.height) {
			say("hovering and clicking what looks interactive", 0.72 + 0.27 * (y / height), `${Math.round((y / height) * 100)}% of the way down`);
			await page.evaluate(`window.scrollTo(0, ${y}); true`);
			// Whatever this screen reveals on arrival plays out before anything is touched.
			await advance(120);
			const targets = (await page.evaluate<number[]>(`window.__domRecorder.interactive(${probes})`)) ?? [];
			for (const id of targets) {
				const point = await page.evaluate<[number, number] | null>(`window.__domRecorder.pointAt(${id})`);
				if (!point) continue;
				const [x, cy] = point;
				await page.evaluate(`window.__domRecorder.mark("hover", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: cy });
				await advance(24);
				await page.evaluate(`window.__domRecorder.mark("leave", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
				await advance(18);
				await page.evaluate(`window.__domRecorder.mark("click", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: cy, button: "left", clickCount: 1 });
				await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: cy, button: "left", clickCount: 1 });
				await advance(90);
				await page.evaluate(`window.__domRecorder.mark("end", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
				// A click the page's own router turned into a navigation, without a new document: what
				// it did is not behaviour of this page. It is marked for discarding, and undone.
				if ((await documentUrl()) !== origin) {
					await page.evaluate(`window.__domRecorder.mark("navigated", ${id}); history.back(); true`);
					await advance(90);
					await page.evaluate(`window.__domRecorder.mark("resumed", ${id}); true`);
					if ((await documentUrl()) !== origin) break probing;
				}
				// A fragment link may have scrolled; the next probe is for this screen.
				await page.evaluate(`if (Math.abs(scrollY - ${y}) > 2) window.scrollTo(0, ${y}); true`);
			}
		}
		await page.send("Fetch.disable").catch(() => ({}));
		unblock();
		await page.evaluate("window.scrollTo(0, 0); true");
	}
	await advance(30);

	say("reading the recording out of the page", 0.99);
	const json = await readLarge(
		page,
		`(() => { const r = window.__domRecorder; r.on = false; return { base: r.base, end: Date.now(), viewport: { width: innerWidth, height: innerHeight }, ops: r.ops, scroll: r.scroll, rects: r.rects, dropped: r.dropped }; })()`,
	);
	return json ? (JSON.parse(json) as DomRecording) : null;
}
