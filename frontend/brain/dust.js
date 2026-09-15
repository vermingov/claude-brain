// The medium the brain hangs in.
//
// Two populations in one draw. Most motes are specks, bright enough to catch the eye as
// they sweep past and far too small to read as objects; a tenth of them are large and
// nearly transparent, and those are the haze — added light rather than blended colour, so
// they thicken the space without ever becoming shapes in it.
//
// Placed once, in world space, inside a cube the shader wraps around the camera. That is
// what makes flying through the brain feel like flying: the near motes streak, the far
// ones barely move, and the dust never runs out however far you go.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createSpriteLayer } from "./sprites.js";

const COUNT = 1600;
/** One in this many is haze rather than a speck. */
const HAZE_EVERY = 9;
const SPECK_SIZE = [0.9, 2.4];
const HAZE_SIZE = [16, 34];
const SPECK_ALPHA = [0.1, 0.5];
const HAZE_ALPHA = [0.012, 0.03];
/** Cold, faintly blue-white — the colour of dust lit by nothing in particular. */
const TINT = [0.62, 0.68, 0.82];

/** Deterministic, so the dust is in the same places every time the brain is opened. */
function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const between = ([low, high], t) => low + (high - low) * t;

/**
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {number} reach  how far the brain itself spreads; the dust cube is built around it
 */
export function createDust(scene, reach) {
	// Big enough that the far wall is never somewhere you can see the dust thin out, small
	// enough that the motes stay dense where you are.
	const cell = Math.max(reach * 3.4, 900);
	const layer = createSpriteLayer(scene, {
		name: "dust",
		count: COUNT,
		vertex: "brainDust",
		fragment: "brainDust",
		blend: "add",
		uniforms: ["cameraPos", "cell"],
		renderingGroup: 0,
	});

	const next = random(0x5eed);
	const positions = new Float32Array(COUNT * 3);
	const tints = new Float32Array(COUNT * 4);
	const sizes = new Float32Array(COUNT);
	for (let i = 0; i < COUNT; i++) {
		positions.set([next() * cell, next() * cell, next() * cell], i * 3);
		const haze = i % HAZE_EVERY === 0;
		sizes[i] = between(haze ? HAZE_SIZE : SPECK_SIZE, next());
		// A little colour spread, or a thousand identical motes read as a texture.
		const warmth = 0.88 + next() * 0.24;
		tints.set(
			[TINT[0] * warmth, TINT[1] * warmth, TINT[2], between(haze ? HAZE_ALPHA : SPECK_ALPHA, next())],
			i * 4,
		);
	}
	layer.set("position", positions);
	layer.set("tint", tints);
	layer.set("size", sizes);
	layer.setFloat("cell", cell);

	return {
		mesh: layer.mesh,
		setTime: layer.setTime,
		/** The cube travels with the camera; the shader needs to know where that is. */
		follow: (position) => layer.setVector3("cameraPos", position ?? Vector3.Zero()),
		dispose: layer.dispose,
	};
}
