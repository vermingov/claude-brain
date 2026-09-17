// Plays back what a page's script did to its DOM, on the rebuild made of that page.
//
// Read at generation time and written into the rebuild's runtime script, after the shared walker
// (window.__brainWalk). The tapes come from dom-tapes.ts. Every node is found by the number the
// walker gives it, which is the number the recorder gave the same node on the live page.
//
// Nothing here knows what any site is doing. A tape is a list of changes, each with a delay, and
// a trigger: the page loading, its component entering or leaving the viewport for the n-th time,
// a hover, a click. Some repeat: from a given delay, every so many milliseconds.

function startDomPlayer(data) {
	if (!data || !window.__brainWalk) return;
	const tapes = data.tapes || [];
	const interactions = data.interactions || [];
	if (!tapes.length && !interactions.length && !(data.surfaces && data.surfaces.length)) return;
	// What the player has done, for anyone checking a rebuild from devtools or a harness.
	const state = (window.__brainPlayer = { tapes: tapes.length, observed: 0, entered: 0, exited: 0, applied: 0, missing: 0, failed: 0, interactions: 0, loops: 0, pointer: 0 });
	const nodes = new Map();
	const idOf = new WeakMap();
	const number = (root, first) =>
		window.__brainWalk(root, first, (node, id) => {
			const element = Array.isArray(node) ? node[0] : node;
			nodes.set(id, element);
			idOf.set(element, id);
		});
	number(document.body, 0);
	nodes.set(-1, document.body);

	const markupOf = (node) => (node.getHTML ? node.getHTML({ serializableShadowRoots: true }) : node.innerHTML);
	// A click that puts a subtree back the way the page was transplanted needs that markup, read
	// before anything has played.
	const transplanted = new Map();
	for (const interaction of interactions) {
		for (const op of interaction.ops) {
			if (op[1] === "c" && op[3] === null && nodes.has(op[2]) && !transplanted.has(op[2])) transplanted.set(op[2], markupOf(nodes.get(op[2])));
		}
	}

	// Motion, rather than the steps a recording is made of.
	//
	// The page that was recorded wrote its transform, its width, its custom properties as often as
	// it could; the browser doing the recording was software-rendering a whole page and could not
	// keep up, so what came back is twenty or thirty samples a second, unevenly spaced. Applying
	// those as they arrive replays the capture's stutter rather than the page's motion.
	//
	// Between two samples the page moved continuously, so this moves continuously too: a value
	// whose text is the same apart from its numbers — "translate(14px, 3px)", "opacity: .42" — is
	// carried from one sample to the next on the viewer's own frames, at whatever rate their
	// display runs. Anything else (a class, a word, a replaced subtree) still lands as it did.
	const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;
	const split = (value) => {
		const numbers = [];
		const parts = [];
		let at = 0;
		for (const match of String(value).matchAll(NUMBER)) {
			parts.push(String(value).slice(at, match.index));
			numbers.push(Number(match[0]));
			at = match.index + match[0].length;
		}
		parts.push(String(value).slice(at));
		return { parts, numbers };
	};
	const sameShape = (a, b) => a.numbers.length === b.numbers.length && a.parts.length === b.parts.length && a.parts.every((part, i) => part === b.parts[i]);
	const valueOf = (op) => (op[1] === "t" ? op[3] : op[1] === "a" || op[1] === "p" ? op[4] : null);
	const keyOf = (op) => (op[1] === "a" || op[1] === "p" ? op[1] + ":" + op[2] + ":" + op[3] : op[1] === "t" ? "t:" + op[2] : null);
	/** The longest gap still worth carrying a value across; past this it was a jump, not motion. */
	const GLIDE_MS = 900;

	// Each ops list is looked at once: which op continues which, and what their numbers are.
	const glides = new WeakMap();
	const prepare = (ops) => {
		let plan = glides.get(ops);
		if (plan) return plan;
		plan = { shape: new Map(), next: new Map() };
		const last = new Map();
		for (let i = 0; i < ops.length; i++) {
			const key = keyOf(ops[i]);
			const raw = valueOf(ops[i]);
			if (key === null || typeof raw !== "string") continue;
			const shape = split(raw);
			if (!shape.numbers.length) continue;
			plan.shape.set(i, shape);
			const before = last.get(key);
			if (before !== undefined) {
				const from = plan.shape.get(before);
				if (from && sameShape(from, shape) && ops[i][0] - ops[before][0] <= GLIDE_MS) plan.next.set(before, i);
			}
			last.set(key, i);
		}
		glides.set(ops, plan);
		return plan;
	};

	// What is being carried right now, by the op that started it.
	const gliding = new Map();
	const write = (op, shape, numbers) => {
		let text = "";
		for (let i = 0; i < shape.parts.length; i++) {
			text += shape.parts[i];
			if (i < numbers.length) text += Math.round(numbers[i] * 1000) / 1000;
		}
		apply(op[1] === "t" ? [op[0], "t", op[2], text] : [op[0], op[1], op[2], op[3], text]);
	};
	const glide = (now) => {
		for (const [key, run] of gliding) {
			const share = Math.min(1, (now - run.start) / run.span);
			write(run.op, run.shape, run.from.map((n, i) => n + (run.to[i] - n) * share));
			if (share >= 1) gliding.delete(key);
		}
	};

	const apply = (op) => {
		const kind = op[1];
		const node = nodes.get(op[2]);
		if (!node) {
			state.missing++;
			return;
		}
		state.applied++;
		try {
			if (kind === "a") {
				if (node.nodeType !== 1 || node.tagName === "CANVAS") return;
				if (op[4] === null) node.removeAttribute(op[3]);
				else node.setAttribute(op[3], op[4]);
			} else if (kind === "t") {
				if (node.nodeType === 3) node.data = op[3];
			} else if (kind === "p") {
				if (op[3] === "scrollTop" || op[3] === "scrollLeft") node[op[3]] = Number(op[4]);
				else if (op[3] === "checked") node.checked = op[4] === "true";
				else node[op[3]] = op[4];
			} else if (kind === "w") {
				const options = Object.assign({}, op[4]);
				for (const key of ["iterations", "duration"]) if (options[key] === "Infinity") options[key] = Infinity;
				if (node.animate) node.animate(op[3], options);
			} else if (kind === "c") {
				if (node === document.body || node.tagName === "CANVAS") return;
				const markup = op[3] === null ? transplanted.get(op[2]) : op[3];
				if (markup === undefined) return;
				if (node.setHTMLUnsafe) node.setHTMLUnsafe(markup);
				else node.innerHTML = markup;
				number(node, op[4]);
			}
		} catch (e) {
			state.failed++;
		}
	};

	// Running tapes. A tape plays its ops once, in order; one with a loop then carries on through
	// its cycle — the ops from `from` to `from + period` — again and again, picking up exactly where
	// the recorded ops left off in that cycle.
	const playing = [];
	const play = (ops, loop, clock) => {
		if (!ops || !ops.length) return null;
		const run = { ops, start: performance.now(), next: 0, shift: 0, limit: ops.length, cycle: null, clock: clock || null };
		if (loop && loop[1] > 0) {
			const [from, period] = loop;
			const first = ops.findIndex((op) => op[0] >= from);
			let last = ops.findIndex((op) => op[0] >= from + period);
			if (last < 0) last = ops.length;
			if (first >= 0 && last > first) run.cycle = { from, period, first, last };
		}
		playing.push(run);
		return run;
	};
	const stop = (run) => {
		const index = playing.indexOf(run);
		if (index >= 0) playing.splice(index, 1);
	};
	// Where a looping tape goes when it runs out of ops to play; false when it is done.
	const wrap = (run, elapsed) => {
		const cycle = run.cycle;
		if (!cycle) return false;
		if (run.limit === run.ops.length) {
			const played = run.ops[run.ops.length - 1][0];
			run.shift = Math.max(0, Math.floor((played - cycle.from) / cycle.period)) * cycle.period;
			run.next = cycle.first;
			while (run.next < cycle.last && run.ops[run.next][0] + run.shift <= played) run.next++;
			run.limit = cycle.last;
			state.loops++;
			if (run.next < cycle.last) return true;
		}
		run.shift += cycle.period;
		run.next = cycle.first;
		// A tab in the background gets no frames; it does not owe the cycles it missed.
		const behind = elapsed - (run.ops[run.next][0] + run.shift);
		if (behind > cycle.period) run.shift += Math.floor(behind / cycle.period) * cycle.period;
		return true;
	};
	const tick = () => {
		const now = performance.now();
		for (let i = playing.length - 1; i >= 0; i--) {
			const run = playing[i];
			// A tape that only runs while its component is on screen has its own clock.
			const elapsed = run.clock ? run.clock() : now - run.start;
			for (let guard = 0; guard < 100000; guard++) {
				if (run.next < run.limit) {
					if (run.ops[run.next][0] + run.shift > elapsed) break;
					const index = run.next++;
					const op = run.ops[index];
					apply(op);
					// If the page went on from here, go on from here too, on this viewer's frames.
					const plan = prepare(run.ops);
					const after = plan.next.get(index);
					const shape = plan.shape.get(index);
					if (after !== undefined && shape) {
						const target = plan.shape.get(after);
						const span = run.ops[after][0] - op[0];
						if (target && span > 0) {
							gliding.set(keyOf(op), { op, shape, from: shape.numbers, to: target.numbers, start: now, span });
						}
					}
				} else if (!wrap(run, elapsed)) {
					playing.splice(i, 1);
					break;
				}
			}
		}
		glide(now);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);

	// Hovers, leaves and clicks. Listened for on the document and matched by node number, so an
	// element a tape has since re-rendered still answers.
	const handlers = new Map();
	for (const interaction of interactions) {
		const key = interaction.on + ":" + interaction.target;
		if (!handlers.has(key)) handlers.set(key, interaction.ops);
	}
	const handlerFor = (on, from) => {
		for (let el = from; el && el !== document; el = el.parentNode || el.host) {
			const id = idOf.get(el);
			const ops = id === undefined ? undefined : handlers.get(on + ":" + id);
			if (ops) return { el, ops };
		}
		return null;
	};
	// Entering and leaving the element that has the tape, not each child on the way across it.
	const dispatch = (on, event, crossing) => {
		const hit = handlerFor(on, event.target);
		if (!hit || (crossing && event.relatedTarget && hit.el.contains(event.relatedTarget))) return;
		state.interactions++;
		play(hit.ops);
	};
	document.addEventListener("click", (e) => dispatch("click", e, false), true);
	document.addEventListener("pointerover", (e) => dispatch("hover", e, true), true);
	document.addEventListener("pointerout", (e) => dispatch("leave", e, true), true);

	// What answers the pointer rather than the clock. The capture swept a lattice of points over
	// each control and a drag across it, and kept what each position produced (dom-surfaces.ts);
	// here that becomes the control's answer to a pointer that is not the capture's — an average
	// of the nearest samples, weighted by how close they are, with the page's own numbers.
	const surfaces = data.surfaces || [];
	if (surfaces.length) {
		const byElement = new Map();
		for (const surface of surfaces) {
			const element = nodes.get(surface.over);
			if (!element || element.nodeType !== 1) continue;
			const held = byElement.get(element) || { move: [], drag: [] };
			held[surface.on === "drag" ? "drag" : "move"].push(surface);
			byElement.set(element, held);
		}

		const near = (surface, u, v) => {
			// Inverse distance, over the four nearest samples: smooth between the points that were
			// taken, and exactly the sample's own value when the pointer is on one.
			const sorted = surface.samples
				.map((sample) => ({ sample, d: Math.hypot(sample.u - u, sample.v - v) }))
				.sort((a, b) => a.d - b.d)
				.slice(0, 4);
			if (!sorted.length) return null;
			if (sorted[0].d < 1) return sorted[0].sample.numbers;
			let weight = 0;
			const out = new Array(surface.shape.count).fill(0);
			for (const { sample, d } of sorted) {
				const w = 1 / (d * d);
				weight += w;
				for (let i = 0; i < out.length; i++) out[i] += (sample.numbers[i] || 0) * w;
			}
			return out.map((n) => n / weight);
		};

		const write = (surface, numbers) => {
			const node = nodes.get(surface.target);
			if (!node) return;
			let text = "";
			for (let i = 0; i < surface.shape.parts.length; i++) {
				text += surface.shape.parts[i];
				if (i < numbers.length) text += Math.round(numbers[i] * 1000) / 1000;
			}
			try {
				if (surface.kind === "a" && node.nodeType === 1) node.setAttribute(surface.name, text);
				else if (surface.kind === "p") node[surface.name] = text;
				else if (surface.kind === "t" && node.nodeType === 3) node.data = text;
				state.pointer++;
			} catch (e) {
				state.failed++;
			}
		};

		const answer = (element, list, event) => {
			const box = element.getBoundingClientRect();
			if (!box.width || !box.height) return;
			const u = ((event.clientX - box.left) / box.width) * 1000;
			const v = ((event.clientY - box.top) / box.height) * 1000;
			for (const surface of list) {
				const numbers = near(surface, u, v);
				if (numbers) write(surface, numbers);
			}
		};

		for (const [element, held] of byElement) {
			if (held.move.length) {
				element.addEventListener("pointermove", (e) => answer(element, held.move, e));
			}
			if (held.drag.length) {
				let dragging = false;
				element.addEventListener("pointerdown", (e) => {
					dragging = true;
					answer(element, held.drag, e);
				});
				// On the window, not the element: a drag that leaves the control still drags it.
				window.addEventListener("pointermove", (e) => {
					if (dragging) answer(element, held.drag, e);
				});
				window.addEventListener("pointerup", () => {
					dragging = false;
				});
			}
		}
	}

	for (const tape of tapes) {
		play(tape.before, tape.loop);
		if (!tape.episodes.length && !tape.whileSeen) continue;
		if (tape.anchor === -1) {
			play(tape.episodes[0].enter, tape.episodes[0].loop);
			continue;
		}
		const element = nodes.get(tape.anchor);
		if (!element || element.nodeType !== 1 || typeof IntersectionObserver === "undefined") continue;
		let entries = 0;
		let inside = false;
		let running = null;
		const threshold = tape.threshold || 0;
		// Time the component has spent on screen, which is the only clock some behaviour runs on.
		let seen = 0;
		let seenSince = 0;
		if (tape.whileSeen) {
			play(tape.whileSeen.ops, tape.whileSeen.loop, () => seen + (inside ? performance.now() - seenSince : 0));
		}
		new IntersectionObserver((records) => {
			const last = records[records.length - 1];
			const now = !!last && last.isIntersecting && (threshold === 0 || last.intersectionRatio >= threshold - 0.005);
			if (!last || now === inside) return;
			inside = now;
			const episode = tape.episodes[Math.max(0, Math.min(inside ? entries : entries - 1, tape.episodes.length - 1))];
			if (inside) seenSince = performance.now();
			else seen += performance.now() - seenSince;
			if (!tape.episodes.length) return;
			if (inside) {
				entries++;
				state.entered++;
				running = play(episode.enter, episode.loop);
			} else if (episode) {
				state.exited++;
				// What was going on while in view stops when it leaves, as it did on the page.
				if (running && running.cycle) stop(running);
				running = null;
				play(episode.exit);
			}
		}, { threshold: threshold > 0 ? [0, threshold] : 0 }).observe(element);
		state.observed++;
	}
}
