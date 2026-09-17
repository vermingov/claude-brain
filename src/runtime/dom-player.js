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
	if (!tapes.length && !interactions.length) return;
	// What the player has done, for anyone checking a rebuild from devtools or a harness.
	const state = (window.__brainPlayer = { tapes: tapes.length, observed: 0, entered: 0, exited: 0, applied: 0, missing: 0, failed: 0, interactions: 0, loops: 0 });
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
					apply(run.ops[run.next++]);
				} else if (!wrap(run, elapsed)) {
					playing.splice(i, 1);
					break;
				}
			}
		}
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
