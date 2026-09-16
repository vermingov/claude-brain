// The dust, and the one number the arrival wave is bounded by.
//
// This used to hold every shader in the view. The cells, their glows, the synapses and the
// signals in flight are one raymarched-free mesh now (field-shader.js), so what is left
// here is the dust — the only thing still drawn as camera-facing sprites, because a mote
// has no shape of its own to see.

import { Effect } from "@babylonjs/core/Materials/effect";

/** Off-screen: a vertex the rasteriser throws away, for an instance with nothing to draw. */
const CULL = "gl_Position = vec4(2.0, 2.0, 2.0, 1.0);";

/** How many arrivals can be settling at once. Past this the oldest stops being drawn. */
export const MAX_ARRIVALS = 8;

Effect.ShadersStore.brainDustVertexShader = `
precision highp float;
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size;
uniform mat4 view; uniform mat4 projection; uniform float time; uniform vec3 cameraPos; uniform float cell;
varying vec4 vTint; varying vec2 vCorner;
/** The most of the view's height one mote may ever take up, before it is faded out. */
const float MAX_APPARENT = 0.038;
void main() {
	vTint = vec4(0.0); vCorner = corner;
	// Alive when nothing else is: a slow wander, out of phase per mote.
	vec3 drift = vec3(
		sin(time * 0.13 + position.y * 0.011),
		cos(time * 0.11 + position.z * 0.013),
		sin(time * 0.15 + position.x * 0.009)
	) * 19.0;
	// Into the cube that follows the camera.
	vec3 rel = mod(position + drift - cameraPos + cell * 0.5, cell) - cell * 0.5;
	float dist = length(rel);
	// Gone before the cube's edge, so nothing blinks into being at the boundary.
	float fade = smoothstep(cell * 0.5, cell * 0.34, dist);
	// And gone well before it is big on screen. Distance alone is the wrong measure: a haze
	// puff and a speck at the same distance are wildly different amounts of the view, and it
	// is the ones that swell up in front of the lens that pull the eye off the brain. What
	// matters is the angle a mote subtends, which is its size over its distance.
	float apparent = size / max(dist, 1.0);
	fade *= 1.0 - smoothstep(MAX_APPARENT * 0.55, MAX_APPARENT, apparent);
	if (fade <= 0.004) { ${CULL} return; }
	vec4 viewPos = view * vec4(cameraPos + rel, 1.0);
	viewPos.xy += corner * size;
	gl_Position = projection * viewPos;
	// The drift is far too slow to see over a second, which is right for dust and wrong for
	// telling you the picture is live. A slow shimmer, out of phase per mote, does that
	// without turning the dust into weather.
	float twinkle = 0.72 + 0.28 * sin(time * 0.8 + position.x * 0.07 + position.z * 0.05);
	vTint = vec4(tint.rgb, tint.a * fade * twinkle);
}`;

/** A mote: soft, round, and never a hard-edged dot. */
Effect.ShadersStore.brainDustFragmentShader = `
precision highp float;
varying vec4 vTint; varying vec2 vCorner;
void main() {
	float a = smoothstep(1.0, 0.0, length(vCorner));
	gl_FragColor = vec4(vTint.rgb * (a * a * vTint.a), 1.0);
}`;

