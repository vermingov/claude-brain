// What gets installed in a page before its own scripts, so a live page and its rebuild can be
// run on the same clock and compared frame by frame.
//
//   virtual clock   every real animation frame advances page time by exactly 1/60 s and runs
//                   the queued callbacks once. The page sees a perfect 60 Hz display however
//                   long software rendering takes, which is what makes two runs comparable —
//                   and what keeps delta-driven easing out of the regime where a two-second
//                   frame blows it up. Only performance.now and frame callbacks are virtual:
//                   Date.now and timers stay real, because slowing them broke page boot.
//   draw skipping   rasterisation is skipped, everything else still happens: uniforms upload,
//                   state moves. A 50-second recording then takes 50 seconds, not hours.
//   uniform log     at each draw, the named uniforms are read back off the GPU with
//                   getUniform, keyed by frame, framebuffer and viewport.

import type { Page } from "./cdp";

export const VIRTUAL_CLOCK = String.raw`(() => {
	if (window.__vclock) return;
	const realRaf = window.requestAnimationFrame.bind(window);
	const STEP = 1000 / 60;
	const clock = { now: performance.now(), frame: 0, pauseAt: -1, paused: false, queue: new Map(), nextId: 1 };
	window.__vclock = clock;
	performance.now = () => clock.now;
	window.requestAnimationFrame = (cb) => { const id = clock.nextId++; clock.queue.set(id, cb); return id; };
	window.cancelAnimationFrame = (id) => { clock.queue.delete(id); };
	const pump = () => {
		realRaf(pump);
		if (clock.pauseAt >= 0 && clock.frame >= clock.pauseAt) clock.paused = true;
		if (clock.paused) return;
		clock.now += STEP;
		clock.frame++;
		const batch = clock.queue;
		clock.queue = new Map();
		for (const cb of batch.values()) {
			try { cb(clock.now); } catch (e) { console.error(e); }
		}
	};
	realRaf(pump);
})()`;

export const SKIP_DRAWS = String.raw`(() => {
	window.__skipDraws = true;
	for (const P of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
		if (!P || P.prototype.__skippable) continue;
		P.prototype.__skippable = true;
		for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "clear"]) {
			const original = P.prototype[name];
			if (typeof original !== "function") continue;
			P.prototype[name] = function () { if (window.__skipDraws) return; return original.apply(this, arguments); };
		}
	}
})()`;

/**
 * The uniform log. Installed after SKIP_DRAWS so it runs first: values are read whether or not
 * the draw then happens. The scene's first frame is the first draw to the screen that declares
 * a watched uniform, and the clock holds there so a harness polling for it misses nothing.
 */
export function uniformLog(watch: string[] | "all"): string {
	return String.raw`(() => {
	if (window.__uniformLog) return;
	const WATCH = ${JSON.stringify(watch)};
	const ALL = WATCH === "all";
	// With every uniform watched, only changes are written: a pass's first frame carries all of
	// its values and later frames carry what moved. expandRecording() puts them back.
	const lastByPass = [];
	const log = { frames: [], sceneStart: -1 };
	window.__uniformLog = log;
	const info = new WeakMap();
	const fboIds = new WeakMap();
	let nextProgram = 1, nextFbo = 1;
	for (const P of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
		if (!P || P.prototype.__logged) continue;
		P.prototype.__logged = true;
		let bound = null;
		const bindFramebuffer = P.prototype.bindFramebuffer;
		P.prototype.bindFramebuffer = function (target, fbo) { bound = fbo; return bindFramebuffer.apply(this, arguments); };
		const describe = (gl, program) => {
			let entry = info.get(program);
			if (entry) return entry;
			entry = { id: nextProgram++, locations: {} };
			const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
			for (let i = 0; i < count; i++) {
				const u = gl.getActiveUniform(program, i);
				if (!u) continue;
				const name = u.name.replace(/\[0\]$/, "");
				if (ALL || WATCH.includes(name)) entry.locations[name] = gl.getUniformLocation(program, name);
			}
			info.set(program, entry);
			return entry;
		};
		for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
			const original = P.prototype[name];
			if (typeof original !== "function") continue;
			P.prototype[name] = function () {
				try {
					const program = this.getParameter(this.CURRENT_PROGRAM);
					const entry = program && describe(this, program);
					const names = entry ? Object.keys(entry.locations) : [];
					if (names.length) {
						const frame = window.__vclock ? window.__vclock.frame : -1;
						let row = log.frames[log.frames.length - 1];
						if (!row || row.f !== frame) {
							row = { f: frame, draws: [] };
							log.frames.push(row);
							if (log.frames.length > 20000) log.frames.shift();
						}
						const u = {};
						for (const n of names) {
							const v = this.getUniform(program, entry.locations[n]);
							u[n] = typeof v === "number" || typeof v === "boolean" ? [Number(v)] : Array.from(v);
						}
						if (ALL) {
							const slot = row.draws.length;
							const last = lastByPass[slot];
							if (last && last.p === entry.id) {
								for (const n of Object.keys(u)) {
									const a = u[n], b = last.u[n];
									if (b && a.length === b.length && a.every((x, i) => x === b[i])) delete u[n];
									else last.u[n] = a;
								}
							} else {
								lastByPass[slot] = { p: entry.id, u: Object.assign({}, u) };
							}
						}
						let fbo = 0;
						if (bound) { fbo = fboIds.get(bound) || nextFbo++; fboIds.set(bound, fbo); }
						const vp = this.getParameter(this.VIEWPORT);
						row.draws.push({ p: entry.id, fbo, vp: [vp[2], vp[3]], cw: this.canvas.width, ch: this.canvas.height, u });
						if (log.sceneStart < 0 && fbo === 0) {
							log.sceneStart = frame;
							if (window.__vclock) window.__vclock.pauseAt = frame;
						}
					}
				} catch (e) { /* never break the page */ }
				return original.apply(this, arguments);
			};
		}
	}
})()`;
}

export async function install(page: Page, watch: string[] | "all"): Promise<void> {
	await page.addInitScript(VIRTUAL_CLOCK);
	await page.addInitScript(SKIP_DRAWS);
	await page.addInitScript(uniformLog(watch));
}

/** Run the clock until it has completed `target`, and leave it paused there. */
export async function runTo(page: Page, target: number, timeoutMs = 300_000): Promise<number> {
	await page.evaluate(`window.__vclock.pauseAt = ${target}; window.__vclock.paused = false`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await page.evaluate<{ f: number; p: boolean }>("({ f: window.__vclock.frame, p: window.__vclock.paused })");
		if (state?.p && state.f >= target) return state.f;
		await Bun.sleep(25);
	}
	throw new Error(`the page never reached frame ${target}`);
}

export async function sceneStart(page: Page, timeoutMs = 60_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const start = (await page.evaluate<number>("window.__uniformLog ? window.__uniformLog.sceneStart : -1")) ?? -1;
		if (start >= 0) return start;
		await Bun.sleep(100);
	}
	throw new Error("the scene never drew");
}

/**
 * The frame a scene last (re)mounted on, found by a uniform taking its first-frame value.
 *
 * Pages remount scenes on timers raced against observers, so the first draw is not always the
 * mount that stays; aligning two runs at their first draws can put them frames apart.
 */
export async function lastMount(page: Page, start: number, marker: { name: string; value: number } | null, within = 30): Promise<number> {
	if (!marker) return start;
	await runTo(page, start + within);
	const found = await page.evaluate<number>(`(() => {
		let found = ${start};
		for (const r of window.__uniformLog.frames) {
			if (r.f > ${start + within}) break;
			for (const d of r.draws) {
				const v = d.u[${JSON.stringify(marker.name)}];
				if (v && Math.abs(v[0] - ${marker.value}) < 1e-5) found = r.f;
			}
		}
		return found;
	})()`);
	return found ?? start;
}

/** A value too large to come back from Runtime.evaluate in one piece. */
export async function readLarge(page: Page, expression: string): Promise<string> {
	const length = await page.evaluate<number>(`(() => { window.__big = JSON.stringify(${expression}); return window.__big.length; })()`, 120_000);
	if (!length) return "";
	let out = "";
	for (let from = 0; from < length; from += 1_000_000) {
		out += (await page.evaluate<string>(`window.__big.slice(${from}, ${from + 1_000_000})`, 60_000)) ?? "";
	}
	return out;
}

export interface RecordedPass {
	p: number;
	fbo: number;
	vp: [number, number];
	cw: number;
	ch: number;
	u: Record<string, number[]>;
}
export interface Recording {
	sceneStart: number;
	mount: number;
	frames: Array<{ f: number; draws: RecordedPass[] }>;
	innerWidth: number;
	innerHeight: number;
	mouse: Array<[number, number, number]>;
}

/**
 * A change-only recording with every value put back: each pass carries forward what it held
 * the frame before, unless the program in that slot changed, in which case it starts over.
 */
export function expandRecording(recording: Recording): Recording {
	const held: Array<{ p: number; u: Record<string, number[]> }> = [];
	const frames = recording.frames.map((row) => ({
		f: row.f,
		draws: row.draws.map((pass, slot) => {
			const before = held[slot];
			const u = before && before.p === pass.p ? { ...before.u, ...pass.u } : { ...pass.u };
			held[slot] = { p: pass.p, u };
			return { ...pass, u };
		}),
	}));
	return { ...recording, frames };
}

/**
 * How far apart two recordings are when the second is shifted by `offset` frames: the worst
 * difference in any non-clock uniform, over a sample of frames. Used to line two runs up
 * without knowing anything about the scene — the offset with the smallest error is the one
 * where both mounted.
 */
export function alignmentError(a: Recording, b: Recording, offset: number, clocks: string[], sample = 240): number {
	const rowsA = new Map(a.frames.map((r) => [r.f - a.mount, r]));
	const rowsB = new Map(b.frames.map((r) => [r.f - b.mount + offset, r]));
	let worst = 0;
	let seen = 0;
	for (let k = 0; k < sample; k++) {
		const x = rowsA.get(k), y = rowsB.get(k);
		if (!x || !y) continue;
		seen++;
		for (let pass = 0; pass < Math.min(x.draws.length, y.draws.length); pass++) {
			for (const [name, values] of Object.entries(x.draws[pass]!.u)) {
				if (clocks.includes(name)) continue;
				const other = y.draws[pass]!.u[name];
				if (!other) continue;
				for (let i = 0; i < values.length; i++) worst = Math.max(worst, Math.abs(values[i]! - (other[i] ?? Number.NaN)) || 0);
			}
		}
	}
	return seen === 0 ? Number.POSITIVE_INFINITY : worst;
}
