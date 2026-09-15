// Where something has just landed, and when.
//
// The shaders animate an arrival entirely from the clock: given a point and a start time
// they know how far the shove has travelled and how much of it is left. So this holds the
// handful of points currently settling and hands them over as one small uniform, rather
// than moving anything itself. A burst of twenty new notes still costs eight vec4s.
//
// The oldest is what gets dropped when more arrive at once than there is room for. A note
// landing now matters more than one that is already halfway settled, and the one being
// pushed out is the one whose wave has nearly finished anyway.

import { MAX_ARRIVALS } from "./shaders.js";

/** Must match ARRIVAL_LIFE in the shader: past this an entry animates nothing. */
const LIFE_SECONDS = 1.8;
/** How far the shove carries, as a share of how far the notes themselves spread. */
const RANGE_OF_SPREAD = 0.28;

export function arrivalRange(spread) {
	return Math.max(spread * RANGE_OF_SPREAD, 40);
}

export function createArrivals() {
	const data = new Float32Array(MAX_ARRIVALS * 4);
	const started = new Float32Array(MAX_ARRIVALS).fill(Number.NEGATIVE_INFINITY);
	let count = 0;
	/** True once the layers have been told there is nothing left, so they stop being told. */
	let quiet = true;

	return {
		/** @param {{x: number, y: number, z: number}} at @param {number} now  seconds, on the shader's clock */
		add(at, now) {
			const slot = count < MAX_ARRIVALS ? count++ : oldest();
			data.set([at.x, at.y, at.z, now], slot * 4);
			started[slot] = now;
			quiet = false;
		},

		/**
		 * The current set, or null when nothing has changed since the layers last saw it.
		 * Expired entries are compacted out so the shader's loop has nothing to weigh.
		 */
		pack(now) {
			const live = count > 0 && prune(now);
			if (!live && quiet) return null;
			quiet = count === 0;
			return { data, count };
		},
	};

	function oldest() {
		let slot = 0;
		for (let i = 1; i < count; i++) if (started[i] < started[slot]) slot = i;
		return slot;
	}

	/** @returns {boolean} whether anything is still settling. */
	function prune(now) {
		let kept = 0;
		for (let i = 0; i < count; i++) {
			if (now - started[i] > LIFE_SECONDS) continue;
			if (kept !== i) {
				data.copyWithin(kept * 4, i * 4, i * 4 + 4);
				started[kept] = started[i];
			}
			kept++;
		}
		count = kept;
		return count > 0;
	}
}
