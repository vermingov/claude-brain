// Replaying how the brain was built.
//
// The notes are put back in the order they were written, and the connections come with them
// — a link appears the moment its second note does, because the field culls any process
// with an end that does not exist yet. So the wiring grows in on its own; nothing here has
// to know about edges at all.
//
// The hard part is time. A vault is not written evenly: this one spans five months but was
// only touched on sixty of those days, and two hundred and forty-five notes landed in a
// single afternoon. Played back at a constant rate per note, the shape of that is lost —
// every note looks equally spaced and the storm reads the same as the drought. Played back
// linearly in real time, three fifths of it is an empty screen.
//
// So real time is kept, and idle time is not. Inside a working session the spacing is true
// to the minute; the silence between sessions runs at a fraction of the rate. The date on
// screen is what makes that legible: it crawls while notes are landing and sprints through
// the weeks where nothing happened.

/** Time within this of the previous note is part of the same sitting, and plays at full rate. */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
/** What a second of silence is worth next to a second of work. */
const IDLE_RATE = 0.012;
/** How long the replay runs, per day the vault has existed, and the bounds on that. */
const SECONDS_PER_DAY = 0.25;
const SHORTEST = 18;
const LONGEST = 80;
/**
 * Work out when each note should appear.
 *
 * @param {Array<{created: number}>} nodes
 * @returns {{order: number[], at: number[], stamps: number[], duration: number, span: number}}
 *   `order` is note indexes oldest first, `at` when each lands in seconds of playback,
 *   `stamps` the real date each one carries, and `span` how many days the vault covers.
 */
export function planHistory(nodes) {
	const order = nodes
		.map((node, index) => index)
		.filter((index) => Number.isFinite(nodes[index].created) && nodes[index].created > 0)
		.sort((a, b) => nodes[a].created - nodes[b].created);
	if (order.length === 0) return { order: [], at: [], stamps: [], duration: 0, span: 0 };

	// Cost each gap: real for work, heavily discounted for silence.
	const weights = [0];
	let total = 0;
	for (let i = 1; i < order.length; i++) {
		const gap = nodes[order[i]].created - nodes[order[i - 1]].created;
		const worked = Math.min(gap, SESSION_GAP_MS);
		const idle = Math.max(0, gap - SESSION_GAP_MS);
		total += worked + idle * IDLE_RATE;
		weights.push(total);
	}

	const span = (nodes[order[order.length - 1]].created - nodes[order[0]].created) / 86_400_000;
	// The older the brain, the longer its story takes to tell.
	const duration = Math.max(SHORTEST, Math.min(LONGEST, span * SECONDS_PER_DAY));
	const scale = total > 0 ? duration / total : 0;
	return {
		order,
		at: weights.map((weight) => weight * scale),
		stamps: order.map((index) => nodes[index].created),
		duration,
		span,
	};
}

/**
 * Play a plan. Returns a handle that can be stopped; stopping puts the brain back the way
 * it was rather than leaving it half built.
 *
 * @param {{unbuild: () => void, build: (index: number) => void, rebuilt: () => void}} field
 * @param {(progress: {at: number, of: number, stamp: number, done: boolean}) => void} onProgress
 */
export function playHistory(plan, field, onProgress) {
	if (plan.order.length === 0) return { stop() {} };
	field.unbuild();

	let cursor = 0;
	let frame = 0;
	let stopped = false;
	const started = performance.now();

	function step() {
		if (stopped) return;
		const elapsed = (performance.now() - started) / 1000;
		// Everything whose moment has come, which in a burst is a great many at once.
		while (cursor < plan.order.length && plan.at[cursor] <= elapsed) {
			field.build(plan.order[cursor]);
			cursor++;
		}
		onProgress({
			at: cursor,
			of: plan.order.length,
			stamp: plan.stamps[Math.max(0, cursor - 1)],
			done: cursor >= plan.order.length,
		});
		if (cursor >= plan.order.length) {
			// Leave it whole, and with nothing mid-landing.
			field.rebuilt();
			return;
		}
		frame = requestAnimationFrame(step);
	}
	frame = requestAnimationFrame(step);

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			cancelAnimationFrame(frame);
			field.rebuilt();
		},
	};
}
