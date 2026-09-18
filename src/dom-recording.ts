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
 * The page's clock, run at sixty frames a second whatever this machine manages.
 *
 * A capture renders in software, on a machine that is also running everything else, and a page of
 * any weight comes out at twenty or thirty frames a second — unevenly. Everything recorded off it
 * is sampled at that rate, so the rebuild moves the way the capture struggled: the stutter is in
 * the data, and no amount of care at playback invents the frames that were never taken.
 *
 * So the page is given a clock of its own. Animation frames are queued rather than run, and one
 * step of exactly a sixtieth of a second is handed out per real frame; `performance.now`,
 * `Date.now`, `setTimeout` and `setInterval` all read and schedule against that step. The page
 * then believes it is running at sixty frames a second and its own maths says so — its easing, its
 * timers, its every-frame writes — and what the recorder stamps is an even sixty-a-second grid.
 * Wall time is only how long the capture takes, which on a slow machine is longer than the page
 * time it bought; that is the trade, and it is the right way round.
 *
 * CSS animations and transitions keep the engine's own clock, which is fine: they are not recorded
 * at all, they are transplanted as the rules they are, and they run natively in the rebuild.
 */
export const PAGE_CLOCK = String.raw`(() => {
	if (window.__pageClock) return;
	const STEP = 1000 / 60;
	const realRaf = window.requestAnimationFrame.bind(window);
	const realNow = performance.now.bind(performance);
	const started = Date.now();
	const clock = { now: realNow(), frame: 0, queue: new Map(), next: 1, timers: new Map(), timerId: 1 };
	window.__pageClock = clock;

	performance.now = () => clock.now;
	Date.now = () => started + clock.now;
	window.requestAnimationFrame = (cb) => {
		const id = clock.next++;
		clock.queue.set(id, cb);
		return id;
	};
	window.cancelAnimationFrame = (id) => clock.queue.delete(id);

	const schedule = (fn, delay, args, repeat) => {
		const id = clock.timerId++;
		clock.timers.set(id, { at: clock.now + Math.max(0, Number(delay) || 0), every: repeat ? Math.max(1, Number(delay) || 0) : 0, fn, args });
		return id;
	};
	window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
	window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
	window.clearTimeout = (id) => clock.timers.delete(id);
	window.clearInterval = (id) => clock.timers.delete(id);

	const pump = () => {
		realRaf(pump);
		clock.now += STEP;
		clock.frame++;
		// Timers first: a page that schedules work for "now" expects it before the frame it drew for.
		for (const [id, timer] of Array.from(clock.timers)) {
			if (timer.at > clock.now) continue;
			if (timer.every) timer.at = clock.now + timer.every;
			else clock.timers.delete(id);
			try {
				if (typeof timer.fn === "function") timer.fn.apply(null, timer.args);
				else if (typeof timer.fn === "string") (0, eval)(timer.fn);
			} catch (e) { /* the page's own timer threw; it would have thrown anyway */ }
		}
		const frame = clock.queue;
		clock.queue = new Map();
		for (const cb of frame.values()) {
			try { cb(clock.now); } catch (e) { /* likewise */ }
		}
	};
	realRaf(pump);
})()`;

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
	const recorder = { on: false, ops: [], ids: new WeakMap(), next: 0, scroll: [], rects: [], dropped: 0, listens: new WeakMap() };
	window.__domRecorder = recorder;

	// Which elements are actually interactive, asked of the page rather than guessed from its
	// styling. A cursor and a role are a guess — and a poor one for a component that puts its
	// handlers on a plain div — while a listener for a pointer is the page saying so itself.
	// Installed before any of the page's own script, which is the only moment it can be.
	const POINTERISH = /^(click|pointerdown|pointerup|pointermove|pointerover|pointerenter|mousedown|mouseup|mousemove|mouseover|mouseenter|touchstart|touchmove|dragstart|wheel)$/;
	const addListener = EventTarget.prototype.addEventListener;
	EventTarget.prototype.addEventListener = function (type, listener, options) {
		try {
			if (POINTERISH.test(String(type)) && this instanceof Element) {
				const kinds = recorder.listens.get(this) || new Set();
				kinds.add(String(type));
				recorder.listens.set(this, kinds);
			}
		} catch (e) {
			/* a page that hands us something strange as a target */
		}
		return addListener.apply(this, arguments);
	};
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
				// Where the page itself is scrolled to belongs to whoever is reading the rebuild. The
				// harness moves down the page to see it; recorded, that is replayed as the page
				// snatching the view away from under them.
				if (id !== undefined && this !== recorder.scroller) push(["p", id, name, read(), before]);
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
			if (!recorder.on || !el || el === document || el === document.documentElement || el === window || el === recorder.scroller) return;
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
	// A mark for a pointer sample carries where the pointer was inside the element, in thousandths
	// of its box, which is what makes the changes that follow a function of position rather than
	// of time.
	recorder.mark = (kind, id, u, v) => {
		if (!recorder.on) return;
		recorder.ops.push(u === undefined ? [now(), "m", id, kind] : [now(), "m", id, kind, u, v]);
	};
	// Elements a person could plausibly interact with, on screen now, as ids. Links that go
	// somewhere and submit buttons are left alone: following them would end the recording. A link
	// to a fragment stays — tabs are often exactly that.
	recorder.interactive = (limit) => {
		const found = [];
		const seen = new Set();
		recorder.targets = new Map();
		// What the page told us listens for a pointer comes first, then the usual shapes of a
		// control, then anything the cursor says is clickable.
		const listening = Array.from(document.querySelectorAll("body *")).filter((el) => recorder.listens.has(el));
		const candidates = document.querySelectorAll('[role=tab], [role=button], [role=radio], [role=slider], [role=switch], [role=option], [aria-controls], [aria-expanded], [aria-selected], [aria-checked], [data-state], button, summary, input, select, [tabindex="0"], label');
		const pointer = Array.from(document.querySelectorAll("body *")).filter((el) => el.childElementCount < 6 && getComputedStyle(el).cursor === "pointer");
		for (const el of [...listening, ...Array.from(candidates), ...pointer]) {
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
	// Where to put the pointer for a target now, and what will actually receive the click there.
	//
	// Pages move while they are probed — a demo re-renders, a panel opens — so a point read a few
	// probes ago may be over something else. And a control is often covered: a card lays a
	// transparent overlay across everything inside it, so the button at that point is not the
	// topmost element. Skipping those meant probing four things on a page with seventy-five; what
	// the pointer would hit is the honest thing to probe, so that is what comes back.
	recorder.pointAt = (id) => {
		const el = recorder.targets && recorder.targets.get(id);
		if (!el || !el.isConnected) return null;
		const r = el.getBoundingClientRect();
		if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
		const at = (fx, fy) => [
			Math.round(Math.min(Math.max(r.left + r.width * fx, 1), innerWidth - 2)),
			Math.round(Math.min(Math.max(r.top + r.height * fy, 1), innerHeight - 2)),
		];
		// The middle first, then four points inside it. A page that lays something across itself —
		// a custom cursor layer, a card's own overlay — covers the middle of everything, and
		// taking the topmost element instead would probe that one layer and call the page done.
		const spots = [at(0.5, 0.5), at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
		let covered = null;
		for (const [x, y] of spots) {
			const hit = document.elementFromPoint(x, y);
			if (!hit) continue;
			if (hit === el || el.contains(hit)) return [x, y, id];
			if (!covered) {
				const over = recorder.ids.get(hit);
				if (over !== undefined) covered = [x, y, over];
			}
		}
		// Covered everywhere. Whatever is on top is what a person clicking here would get.
		return covered;
	};

	// What has changed in a band of the page since a given op, so a sweep can tell whether what it
	// is looking at has finished. A node made after the baseline has no box; it belongs to whatever
	// was re-rendered, which is what is being watched.
	const inBand = (index, top, bottom, visit) => {
		for (let i = Math.max(0, index); i < recorder.ops.length; i++) {
			const op = recorder.ops[i];
			const box = recorder.boxes.get(op[2]);
			if (!box || (box[0] < bottom && box[1] > top)) visit(op[2], op);
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
	// How many times the same thing has changed — the most any one attribute, property, text run
	// or subtree has been set since that op. Three times is two turns of whatever it is doing,
	// which is the point at which a cycle can be read as a cycle rather than guessed at.
	recorder.repeatsBesides = (index, top, bottom, known) => {
		const ignore = new Set(known);
		const counts = new Map();
		let most = 0;
		inBand(index, top, bottom, (id, op) => {
			if (ignore.has(id)) return;
			const key = op[1] + ":" + id + ":" + (op[1] === "a" || op[1] === "p" ? op[3] : "");
			const n = (counts.get(key) || 0) + 1;
			counts.set(key, n);
			if (n > most) most = n;
		});
		return most;
	};

	// While the harness is probing, the page is held where it is: a link is followed by letting
	// the page's own handler run and refusing only the browser's default, and window.open is
	// answered with nothing. A probe is meant to find out what a control does here, not to leave.
	const holdClick = (event) => {
		const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
		const href = link && link.getAttribute("href");
		if (href && !href.startsWith("#")) event.preventDefault();
	};
	const holdSubmit = (event) => event.preventDefault();
	recorder.hold = (on) => {
		if (on) {
			document.addEventListener("click", holdClick, true);
			document.addEventListener("submit", holdSubmit, true);
			if (!recorder.held) {
				// The page's own router is held too. A block that opens itself by pushing a route
				// leaves the document alone but changes the address, and an address that changed is
				// something a harness then wants to undo — which is how going "back" from a route
				// the page had replaced landed on the blank page the tab started at.
				recorder.held = { open: window.open, push: history.pushState, replace: history.replaceState };
				window.open = () => null;
				history.pushState = () => {};
				history.replaceState = () => {};
			}
			return;
		}
		document.removeEventListener("click", holdClick, true);
		document.removeEventListener("submit", holdSubmit, true);
		if (recorder.held) {
			window.open = recorder.held.open;
			history.pushState = recorder.held.push;
			history.replaceState = recorder.held.replace;
			recorder.held = null;
		}
	};

	// What actually scrolls. A page is not always the thing that moves: an app shell pins the
	// document to the viewport and scrolls a panel inside it, and then window.scrollY never leaves
	// zero, scrollTo does nothing, and a capture that trusts either sees the first screen and calls
	// it the whole page. So the scroller is found once and everything — how tall the page is, where
	// a box sits on it, where it is now — is asked of that.
	recorder.scrollerOf = () => {
		const root = document.scrollingElement || document.documentElement;
		if (root && root.scrollHeight > root.clientHeight + 40) return root;
		let best = null;
		for (const el of document.querySelectorAll("*")) {
			if (el.scrollHeight <= el.clientHeight + 40) continue;
			const overflow = getComputedStyle(el).overflowY;
			if (overflow !== "auto" && overflow !== "scroll") continue;
			const box = el.getBoundingClientRect();
			// The one that carries the page, not a list box in a corner of it.
			const covers = Math.min(box.width, innerWidth) * Math.min(box.height, innerHeight);
			if (covers < innerWidth * innerHeight * 0.4) continue;
			if (!best || el.scrollHeight > best.scrollHeight) best = el;
		}
		return best || root;
	};
	/** How far down the page is now, and how far it can go, whatever is doing the scrolling. */
	recorder.scrollTop = () => (recorder.scroller === document.scrollingElement ? scrollY : (recorder.scroller ? recorder.scroller.scrollTop : 0));
	recorder.scrollHeight = () => (recorder.scroller ? recorder.scroller.scrollHeight : document.documentElement.scrollHeight);
	recorder.scrollTo = (y) => {
		if (recorder.scroller === document.scrollingElement) window.scrollTo(0, y);
		else if (recorder.scroller) recorder.scroller.scrollTop = y;
	};

	recorder.start = () => {
		recorder.ids = new WeakMap();
		recorder.next = 0;
		recorder.scroller = recorder.scrollerOf();
		number(document.body);
		// The tree, and where every element was in document coordinates, so a tape can find the
		// component a change belongs to and say when it came into view from the scroll alone.
		// [id, parent id, top, bottom]; -1 for a node with no box. The body is the root, id -1.
		const rects = [];
		const numbered = new Map();
		window.__brainWalk(document.body, 0, (node, id) => {
			numbered.set(id, Array.isArray(node) ? node[0] : node);
			const first = Array.isArray(node) ? node[0] : node;
			const parentNode = first.parentNode && first.parentNode.host ? first.parentNode.host : first.parentNode;
			const parent = parentNode === document.body ? -1 : (recorder.ids.get(parentNode) ?? -1);
			if (Array.isArray(node) || node.nodeType !== 1) { rects.push([id, parent, -1, -1]); return; }
			const r = node.getBoundingClientRect();
			const down = recorder.scrollTop();
			rects.push(r.width || r.height ? [id, parent, Math.round(r.top + down), Math.round(r.bottom + down)] : [id, parent, -1, -1]);
		});
		recorder.rects = rects;
		// Kept so a harness can take hold of any component it numbered, not only the controls the
		// interactive() list last looked for: that map is rebuilt per probe, and is empty until one.
		recorder.nodeAt = numbered;
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
			if (!recorder.on) return;
			const y = recorder.scrollTop();
			if (y === lastY) return;
			recorder.scroll.push([now(), Math.round(y)]);
			lastY = y;
		};
		// Caught on the way down: a scroll event does not bubble, so a panel scrolling inside the
		// page never reaches a listener on the window unless it is heard in the capture phase.
		addEventListener("scroll", track, { passive: true, capture: true });
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
	/** How long the sweep waits after the last thing changed before moving on, and how many times
	 * something has to repeat before it has been seen enough. */
	patienceFrames?: number;
	repeatsWanted?: number;
	/** A stop for a page where something changes forever without ever repeating. Not a budget. */
	watchFrames?: number;
	/** The longest a section still going when the sweep left it is watched for again. */
	revisitFrames?: number;
	/** How long each component is given, once it is fully in view. */
	centreFrames?: number;
	/** The most elements a whole page may be probed at; 0 skips interaction entirely. Every
	 * candidate on a screen is probed — a page of interactive blocks has dozens in one screen and
	 * taking eight of them is taking a tenth of the page. */
	probeLimit?: number;
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

	// The recording is carried out of the page as it is made, not read at the end. A page can
	// take the document away — a probe lands on something that navigates, a script replaces the
	// window — and everything recorded in a fresh document is nothing: one click on bencho.dev
	// put the tab on about:blank and five minutes of watching went with it. Whatever has already
	// been pulled is already safe, and a document that goes away just ends the visit early.
	const kept: DomRecording = { base: 0, end: 0, viewport, ops: [], scroll: [], rects: [], dropped: 0 };
	let alive = true;
	// What has been carried out already. The page keeps its own copy — the sweep points at ops by
	// index while it decides whether a screen is still moving, and taking them out from under it
	// would move the ground it is standing on.
	let takenOps = 0;
	let takenScroll = 0;
	const pull = async (): Promise<boolean> => {
		if (!alive) return false;
		const json = await readLarge(
			page,
			`(() => {
				const r = window.__domRecorder;
				if (!r || !r.on || r.base === undefined) return null;
				return { base: r.base, end: Date.now(), ops: r.ops.slice(${takenOps}), scroll: r.scroll.slice(${takenScroll}), dropped: r.dropped, rects: ${kept.rects.length ? "null" : "r.rects"} };
			})()`,
		);
		const taken = json ? (JSON.parse(json) as DomRecording & { rects: DomRecording["rects"] | null }) : null;
		if (!taken) {
			// The document this was recording is gone; what was pulled before it went still stands.
			alive = false;
			return false;
		}
		kept.base = kept.base || taken.base;
		kept.end = taken.end;
		kept.dropped = taken.dropped;
		if (taken.rects?.length) kept.rects = taken.rects;
		kept.ops.push(...taken.ops);
		kept.scroll.push(...taken.scroll);
		takenOps += taken.ops.length;
		takenScroll += taken.scroll.length;
		return true;
	};
	const idle = options.idleFrames ?? 300;
	const dwell = options.dwellFrames ?? 120;
	const step = Math.round(viewport.height * (options.stepShare ?? 0.6));
	// Waits are counted in the page's own frames, not in seconds of ours. With the page clock
	// installed (PAGE_CLOCK) a frame is a sixtieth of the page's second however long this machine
	// takes to draw it, so "two seconds of this demo" means two seconds of the demo.
	const clockFrame = async () => (await page.evaluate<number>("window.__pageClock ? window.__pageClock.frame : -1")) ?? -1;
	const onItsOwnClock = (await clockFrame()) >= 0;
	const advance = async (frames: number) => {
		if (!onItsOwnClock) {
			await Bun.sleep(Math.round((frames * 1000) / 60));
			return;
		}
		const until = (await clockFrame()) + frames;
		// However slow the machine is, the page gets its frames — but not for ever, in case the
		// page stops drawing altogether.
		const deadline = Date.now() + Math.max(20_000, frames * 200);
		while (Date.now() < deadline) {
			if ((await clockFrame()) >= until) return;
			await Bun.sleep(25);
		}
	};

	say("settling at the top of the page", 0);
	await advance(idle);
	await pull();
	const height = (await page.evaluate<number>("window.__domRecorder.scrollHeight()")) ?? viewport.height;
	// Down the page, staying with a screen while something new is moving in it. New matters: a star
	// field twinkles whether or not anyone is there, and waiting for it to stop would mean waiting
	// for the whole page. So on arrival the sweep notes which nodes in this band were changing while
	// it was elsewhere — the background — and then counts only changes to anything else. A demo that
	// steps once every ten seconds keeps the sweep there; the stars around it do not.
	// There is no clock on how long a screen may be watched. The sweep leaves when what is moving
	// has come round twice — a carousel that turns every five seconds through five panels takes
	// most of a minute to say that, and a marquee says it in a second — or when it stops. The
	// number below is a stop for a page where something changes forever without repeating, so a
	// capture cannot be held open by one; it is not a budget, and nothing normal reaches it.
	const watch = options.watchFrames ?? 36_000;
	const patience = options.patienceFrames ?? 480;
	const repeats = options.repeatsWanted ?? 3;
	const opsLength = async () => (await page.evaluate<number>("window.__domRecorder.ops.length")) ?? 0;
	const busy: Array<{ y: number; changes: number }> = [];
	let elsewhere = 0;
	for (let y = step; y < height; y += step) {
		say("reading down the page", 0.05 + 0.5 * (y / height), `${Math.round((y / height) * 100)}% of the way down`);
		await page.evaluate(`window.__domRecorder.scrollTo(${y}); true`);
		const arrival = await opsLength();
		const band = `${y}, ${y + viewport.height}`;
		const background = (await page.evaluate<number[]>(`window.__domRecorder.movers(${elsewhere}, ${band})`)) ?? [];
		const others = JSON.stringify(background);
		let [waited, quiet, changes, sawNew, seen] = [0, 0, 0, false, 0];
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
			seen = (await page.evaluate<number>(`window.__domRecorder.repeatsBesides(${arrival}, ${band}, ${others})`)) ?? 0;
		} while (waited < watch && seen < repeats && (sawNew ? quiet < patience : waited < dwell));
		elsewhere = arrival;
		if (waited >= watch) busy.push({ y, changes });
		if (!(await pull())) return kept.ops.length ? kept : null;
	}
	await advance(dwell);

	// Coming down a screen at a time shows most of a page but not necessarily all of any one thing:
	// a card a little taller than half the step is cut by the bottom of the screen at one stop and
	// by the top at the next, and is never once whole. Pages wait for that. A demo that begins when
	// it is properly in view — most observers are written that way — then never begins at all, and
	// the capture records a component that does nothing, which is exactly what the rebuild goes on
	// to reproduce. So every component-sized box is brought to the middle of the screen once, the
	// way a reader arriving at it would see it, and given long enough to start.
	const centres =
		(await page.evaluate<Array<[number, number]>>(`(() => {
			const vh = innerHeight;
			const wanted = new Set();
			const out = [];
			for (const [id, box] of window.__domRecorder.boxes) {
				const height = box[1] - box[0];
				if (height < 80 || height > vh) continue;
				const y = Math.max(0, Math.round(box[0] - (vh - height) / 2));
				const key = Math.round(y / 60);
				if (wanted.has(key)) continue;
				wanted.add(key);
				out.push([y, id]);
			}
			return out.sort((a, b) => a[0] - b[0]);
		})()`)) ?? [];
	const settle = options.centreFrames ?? 240;
	// Held from the first touch onwards: what follows presses on the components themselves, and one
	// of them being a link would otherwise end the recording here.
	await page.evaluate("window.__domRecorder.hold(true); true");
	for (const [index, [y, id]] of centres.entries()) {
		say("looking at each thing properly", 0.5 + 0.06 * (index / Math.max(1, centres.length)), `${index + 1} of ${centres.length}`);
		await page.evaluate(`window.__domRecorder.scrollTo(${y}); true`);
		await advance(settle);
		// And dragged across, which is the other thing a pointer does to a component. Probing drags
		// whatever small control it has just hovered — a button, a chip — and a reel that turns under
		// the hand is not any of those: it is the body of the card, which nothing else ever takes hold
		// of. So the component itself is dragged here, while it is centred and whole.
		const box = await page.evaluate<[number, number, number, number] | null>(
			`(() => { const el = window.__domRecorder.nodeAt.get(${id}); if (!el || !el.isConnected || el.nodeType !== 1) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`,
		);
		if (box && box[2] >= 120 && box[3] >= 60) {
			const [bx, by, bw, bh] = box;
			const midY = by + Math.round(bh / 2);
			const spot = (u: number) => Math.round(bx + bw * u);
			if (midY > 1 && midY < viewport.height - 2) {
				// Touched where it is, rather than where a control would be. A card that answers a
				// pointer anywhere on it — lighting up, tilting, opening — holds no button for a list
				// of likely controls to find, so nothing ever asks it.
				await page.evaluate(`window.__domRecorder.mark("hover", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot(0.5), y: midY });
				await advance(20);
				await page.evaluate(`window.__domRecorder.mark("click", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot(0.5), y: midY, button: "left", clickCount: 1 });
				await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot(0.5), y: midY, button: "left", clickCount: 1 });
				await advance(36);
				await page.evaluate(`window.__domRecorder.mark("end", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: viewport.height - 2 });
				await advance(12);
				await page.evaluate(`window.__domRecorder.mark("grab", ${id}, 150, 500); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot(0.15), y: midY });
				await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot(0.15), y: midY, button: "left", buttons: 1, clickCount: 1 });
				await advance(8);
				for (let step = 1; step <= 8; step++) {
					const u = 0.15 + (0.7 * step) / 8;
					await page.evaluate(`window.__domRecorder.mark("drag", ${id}, ${Math.round(u * 1000)}, 500); true`);
					await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot(u), y: midY, button: "left", buttons: 1 });
					await advance(8);
				}
				await page.evaluate(`window.__domRecorder.mark("drop", ${id}, 850, 500); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot(0.85), y: midY, button: "left", clickCount: 1 });
				await advance(24);
				await page.evaluate(`window.__domRecorder.mark("end", ${id}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: viewport.height - 2 });
			}
		}
		if (!(await pull())) return kept.ops.length ? kept : null;
	}

	say("reading back up", 0.56);
	for (let y = height; y > 0; y -= step * 2) {
		await page.evaluate(`window.__domRecorder.scrollTo(${Math.max(0, y)}); true`);
		await advance(Math.round(dwell / 2));
	}
	await page.evaluate("window.__domRecorder.scrollTo(0); true");
	await advance(dwell);

	// Whatever was still going when the sweep gave up on it gets one longer look, busiest first.
	const revisit = options.revisitFrames ?? 1_800;
	const watching = busy.sort((a, b) => b.changes - a.changes).slice(0, 3);
	for (const [index, { y }] of watching.entries()) {
		say("watching what is still moving", 0.62 + 0.1 * (index / Math.max(1, watching.length)), `${index + 1} of ${watching.length}`);
		await page.evaluate(`window.__domRecorder.scrollTo(${y}); true`);
		await advance(revisit);
		if (!(await pull())) return kept.ops.length ? kept : null;
	}
	// Interaction: in each screen, hover what looks interactive, move away, click it. Every probe
	// is announced with a marker so its effects can be told from what was already moving.
	const probeLimit = options.probeLimit ?? 500;
	const probed = new Set<number>();
	if (probeLimit > 0) {
		const away = { x: 2, y: viewport.height - 2 };
		// Wait on the page rather than on a clock: most things do nothing when touched and need no
		// time at all, and the few that start something get as long as they keep going.
		const settle = async (floor: number, cap: number) => {
			let waited = 0;
			let seen = await opsLength();
			await advance(floor);
			waited += floor;
			while (waited < cap) {
				const now = await opsLength();
				if (now === seen) return;
				seen = now;
				await advance(18);
				waited += 18;
			}
		};
		// Nothing a probe does may take the recording's document away. A navigation is answered
		// with 204 No Content, which a browser treats as "nothing to show here" and stays where it
		// is. Failing the request instead can commit an empty document — one click on bencho.dev
		// put the tab on about:blank — and everything recorded in this document goes with it.
		const unblock = page.on("Fetch.requestPaused", (params) => {
			page.send("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: [] }).catch(() => {});
		});
		await page.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
		await page.evaluate("window.__domRecorder.hold(true); true");
		probing: for (let y = 0; y < height; y += viewport.height) {
			await page.evaluate(`window.__domRecorder.scrollTo(${y}); true`);
			// Whatever this screen reveals on arrival plays out before anything is touched.
			await advance(120);
			// The list is read again before every probe. Touching one thing re-renders others —
			// a block that starts playing replaces its own contents — and a list read once goes
			// stale after the first click: every element in it is detached, nothing can be aimed
			// at, and a page with seventy-five controls gets four of them probed.
			for (let round = 0; round < probeLimit; round++) {
				if (probed.size >= probeLimit) break probing;
				const targets = (await page.evaluate<number[]>(`window.__domRecorder.interactive(${probeLimit})`)) ?? [];
				let point: [number, number, number] | null = null;
				for (const id of targets) {
					if (probed.has(id)) continue;
					point = await page.evaluate<[number, number, number] | null>(`window.__domRecorder.pointAt(${id})`);
					if (point && !probed.has(point[2])) {
						probed.add(id);
						break;
					}
					// Nothing to aim at, or whatever is on top has been probed already.
					probed.add(id);
					point = null;
				}
				if (!point) break;
				const [x, cy, hit] = point;
				probed.add(hit);
				say(
					"hovering and clicking what looks interactive",
					0.72 + 0.27 * Math.min(1, probed.size / Math.max(1, targets.length)),
					`${probed.size} of ${targets.length} on this screen`,
				);
				const before = await opsLength();
				await page.evaluate(`window.__domRecorder.mark("hover", ${hit}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: cy });
				await settle(12, 120);
				await page.evaluate(`window.__domRecorder.mark("leave", ${hit}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
				await settle(12, 90);
				await page.evaluate(`window.__domRecorder.mark("click", ${hit}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: cy, button: "left", clickCount: 1 });
				await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: cy, button: "left", clickCount: 1 });
				await settle(24, 300);
				await page.evaluate(`window.__domRecorder.mark("end", ${hit}); true`);
				await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
				// What the thing does as the pointer moves over it, and as it is dragged. A page that
				// answers where the pointer is — a button that leans towards it, a blob that follows
				// it, a slider that tracks it — cannot be replayed from one recorded click: what it
				// does is a function of position, so the position is swept and each sample marked
				// with it. The rebuild interpolates between them (dom-surfaces.ts).
				// Only what answered at all. Something that did nothing when hovered and nothing when
				// clicked will do nothing across a lattice either, and most of a page is that.
				const answered = (await opsLength()) > before;
				const box = answered
					? await page.evaluate<[number, number, number, number] | null>(
							`(() => { const el = window.__domRecorder.targets.get(${hit}); if (!el || !el.isConnected) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })()`,
						)
					: null;
				if (box && box[2] >= 16 && box[3] >= 16) {
					const [bx, by, bw, bh] = box;
					const spot = (u: number, v: number) => [Math.round(bx + bw * u), Math.round(by + bh * v)] as const;
					for (const v of [0.15, 0.5, 0.85]) {
						for (const u of [0.15, 0.5, 0.85]) {
							const [px, py] = spot(u, v);
							if (px < 1 || py < 1 || px > viewport.width - 2 || py > viewport.height - 2) continue;
							await page.evaluate(`window.__domRecorder.mark("at", ${hit}, ${Math.round(u * 1000)}, ${Math.round(v * 1000)}); true`);
							await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
							await advance(10);
						}
					}
					// And the same across a drag, which is the other thing a pointer does.
					const steps = 8;
					const [sx, sy] = spot(0.12, 0.5);
					await page.evaluate(`window.__domRecorder.mark("grab", ${hit}, 120, 500); true`);
					await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy });
					await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1 });
					await advance(10);
					for (let step = 1; step <= steps; step++) {
						const u = 0.12 + (0.76 * step) / steps;
						const [px, py] = spot(u, 0.5);
						await page.evaluate(`window.__domRecorder.mark("drag", ${hit}, ${Math.round(u * 1000)}, 500); true`);
						await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "left", buttons: 1 });
						await advance(8);
					}
					const [ex, ey] = spot(0.88, 0.5);
					await page.evaluate(`window.__domRecorder.mark("drop", ${hit}, 880, 500); true`);
					await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", clickCount: 1 });
					await settle(12, 120);
					await page.evaluate(`window.__domRecorder.mark("end", ${hit}); true`);
					await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
				}
				// A probe puts the page back as it found it. One click opening a dialog is the end of
				// the visit otherwise: everything behind it stops answering to a pointer, and the rest
				// of the page — seventy of the seventy-five things on it — never gets touched.
				const opened = await page.evaluate<boolean>(`!!document.querySelector("dialog[open], [aria-modal=true], [role=dialog]")`);
				if (opened) {
					for (const type of ["keyDown", "keyUp"] as const) {
						await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
					}
					await advance(30);
				}
				// Everything up to here is out of the page already, so a click that takes the document
				// away costs this probe, not the visit. Whether it did is asked of the recorder rather
				// than of the address: an address can change while the document stays, and it is the
				// document this is recording.
				if (!(await pull())) {
					say("the page took its document away; keeping what was recorded", 0.99, `${probed.size} probed`);
					break probing;
				}
				// A fragment link may have scrolled; the next probe is for this screen.
				await page.evaluate(`if (Math.abs(window.__domRecorder.scrollTop() - ${y}) > 2) window.__domRecorder.scrollTo(${y}); true`);
			}
		}
		await page.evaluate("if (window.__domRecorder && window.__domRecorder.hold) window.__domRecorder.hold(false); true").catch(() => ({}));
		await page.send("Fetch.disable").catch(() => ({}));
		unblock();
		await page.evaluate("window.__domRecorder.scrollTo(0); true");
	}
	await advance(30);

	say("reading the recording out of the page", 0.99);
	await pull();
	await page.evaluate("if (window.__domRecorder) window.__domRecorder.on = false; true").catch(() => ({}));
	return kept.ops.length ? kept : null;
}
