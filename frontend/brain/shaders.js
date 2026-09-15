// Every cell, flare and impulse is a camera-facing quad expanded on the GPU, and every
// animation is a function of one `time` uniform and a per-instance firing time. The CPU
// never moves a billboard or rebuilds a buffer per frame: at rest the brain is static
// translucent tissue, and an impulse volley costs one buffer write, not a frame loop.

import { Effect } from "@babylonjs/core/Materials/effect";

const FOG = `
uniform float fogDensity; uniform vec3 fogColor;
float fogFactor(float depth) { float d = depth * fogDensity; return clamp(exp(-d * d), 0.0, 1.0); }`;

/** One action potential: depolarises in about 50 ms, recovers over about two seconds. */
const SPIKE = `
float spike(float since) {
	if (since < 0.0) return 0.0;
	return (1.0 - exp(-since * 22.0)) * exp(-since * 0.9);
}`;

/** Off-screen: a vertex the rasteriser throws away, for an instance with nothing to draw. */
const CULL = "gl_Position = vec4(2.0, 2.0, 2.0, 1.0);";

/** How many arrivals can be settling at once. Past this the oldest stops being drawn. */
export const MAX_ARRIVALS = 8;

/**
 * Room being made for something new.
 *
 * A note does not blink into a gap that was already there — it lands, and what is around
 * it gets out of the way. The shove travels outward as a front rather than moving
 * everything at once, which is what makes it read as a drop hitting a surface instead of
 * the whole brain flinching, and it relaxes back with a little overshoot so the tissue
 * settles rather than snapping.
 *
 * Every layer that draws something positioned in the brain runs this on its vertices, so
 * the cells, their glows, the signals in flight and the synapses between them all move as
 * one piece. Branchless and bounded: eight iterations of a dozen instructions, in the
 * vertex stage, where there are a thousand of them and not a million.
 */
const ARRIVAL = `
#define MAX_ARRIVALS ${MAX_ARRIVALS}
/** xyz where it landed, w when, on the same clock as the time uniform. */
uniform vec4 arrivals[MAX_ARRIVALS];
uniform float arrivalCount;
/** How far the shove carries, in layout units; scales with the brain. */
uniform float arrivalRange;

const float ARRIVAL_LIFE = 1.8;
const float ARRIVAL_SPEED = 210.0;
const float ARRIVAL_WIDTH = 60.0;
const float ARRIVAL_AMPLITUDE = 17.0;

vec3 arrivalPush(vec3 world, float now) {
	vec3 shift = vec3(0.0);
	for (int i = 0; i < MAX_ARRIVALS; i++) {
		vec4 a = arrivals[i];
		float live = step(float(i), arrivalCount - 0.5);
		float age = now - a.w;
		live *= step(0.0, age) * step(age, ARRIVAL_LIFE);
		vec3 away = world - a.xyz;
		float dist = max(length(away), 0.001);
		// The crest of the wave, passing outward.
		float crest = exp(-pow((dist - age * ARRIVAL_SPEED) / ARRIVAL_WIDTH, 2.0));
		// Near things move most, and everything past the range is left alone.
		float reach = max(1.0 - dist / arrivalRange, 0.0);
		// Overshoot, then settle: the sine turns the push back on itself once.
		float settle = exp(-age * 2.2) * cos(age * 5.0);
		shift += (away / dist) * (ARRIVAL_AMPLITUDE * crest * reach * reach * settle * live);
	}
	return shift;
}`;

/** Landing: nothing, then a fast swell past its own size, then a wobble down to it. */
const POP = `
const float POP_TIME = 0.42;
float popScale(float born) {
	if (born < 0.0) return 0.0;
	float t = clamp(born / POP_TIME, 0.0, 1.0);
	float grow = 1.0 - pow(1.0 - t, 3.0);
	return grow * (1.0 + 0.45 * exp(-born * 6.0) * sin(born * 22.0));
}
/** White-hot on landing, and still visibly lit a second later. */
float popFlash(float born) {
	return born < 0.0 ? 0.0 : exp(-born * 1.9);
}`;

/**
 * How much bigger the drawn cell is than its soma. The soma stays `size` — that is what the
 * pointer hits and what the layout spaced the notes by — and the arbor reaches out past it.
 */
const ARBOR = 3.4;

Effect.ShadersStore.brainCellVertexShader = `
precision highp float;
#define ARBOR ${ARBOR}
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size;
attribute float fireAt; attribute float fireGain; attribute float arriveAt; attribute float branches;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth; varying float vFire; varying float vArrive;
varying vec2 vUp; varying float vDetail; varying float vBranches; varying float vSeed;
${SPIKE}
${POP}
${ARRIVAL}
void main() {
	vTint = tint; vCorner = corner; vDepth = 0.0; vFire = 0.0; vArrive = 0.0;
	vUp = vec2(0.0, 1.0); vDetail = 0.0; vBranches = branches; vSeed = 0.0;
	if (size <= 0.0) { ${CULL} return; }
	float born = time - arriveAt;
	float pop = popScale(born);
	if (pop <= 0.001) { ${CULL} return; }
	float fire = spike(time - fireAt) * fireGain;
	vec3 world = position + arrivalPush(position, time);
	vec4 viewPos = view * vec4(world, 1.0);
	viewPos.xy += corner * size * ARBOR * pop * (1.0 + 0.5 * fire);
	gl_Position = projection * viewPos;
	vDepth = -viewPos.z; vFire = fire; vArrive = popFlash(born);

	// Every note sits on the cortex, so "away from the middle of the brain" is the way a
	// real pyramidal cell points: apex and apical dendrite toward the surface, basal
	// dendrites and axon down into the white matter. The whole sheet ends up combed the
	// same way, which is what a cortex actually looks like.
	vec3 outward = (view * vec4(normalize(position + vec3(0.0, 0.0, 0.001)), 0.0)).xyz;
	float lean = length(outward.xy);
	vUp = lean > 0.001 ? outward.xy / lean : vec2(0.0, 1.0);
	// Pointing at or away from the camera, the arbor is foreshortened to nearly nothing;
	// drawing it at full length there would make it swing about as the camera turns.
	vSeed = lean;

	// Detail falls away with apparent size: a cell a few pixels across gets a soma and
	// nothing else, which is most of them in the overview and all of the cost.
	float apparent = size * ARBOR * projection[1][1] / max(-viewPos.z, 1.0);
	vDetail = clamp((apparent - 0.012) / 0.05, 0.0, 1.0);
}`;

/**
 * A cell at rest is membrane, not light: rim-lit, hollow in the middle, so a thousand of
 * them read as tissue you can see through rather than a field of dots. Firing is the only
 * thing that crosses the bloom threshold.
 */
/**
 * A pyramidal cell, drawn procedurally in the quad.
 *
 * The shape is the one a Golgi stain shows: a teardrop soma with its apex toward the
 * cortical surface, one thick apical dendrite rising from that apex and splitting into a
 * tuft, a spray of shorter basal dendrites from the base, and a single thin axon running
 * the other way. How many basal dendrites a cell grows is how many notes link to it, so a
 * hub is visibly a bushier cell and an orphan is a bare soma — the picture says what the
 * graph says without a legend for it.
 *
 * Everything is signed distance, so the processes taper and join smoothly and the whole
 * arbor antialiases against one pixel width.
 */
Effect.ShadersStore.brainCellFragmentShader = `
precision highp float;
#define ARBOR ${ARBOR}
varying vec4 vTint; varying vec2 vCorner; varying float vDepth; varying float vFire; varying float vArrive;
varying vec2 vUp; varying float vDetail; varying float vBranches; varying float vSeed;
${FOG}

/** Distance to a line that thins from radius r0 at a to radius r1 at b. */
float process(vec2 p, vec2 a, vec2 b, float r0, float r1) {
	vec2 pa = p - a;
	vec2 ba = b - a;
	float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	return length(pa - ba * h) - mix(r0, r1, h);
}

float smin(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
	// Into the cell's own frame: y along the cortical normal, soma radius 1.
	vec2 right = vec2(vUp.y, -vUp.x);
	vec2 q = vec2(dot(vCorner, right), dot(vCorner, vUp)) * ARBOR;

	// The soma: a circle pulled into a point at the apex. Squeezing x in proportion to y
	// above the middle is all a teardrop is.
	float taper = 1.0 + 0.55 * max(q.y, 0.0);
	float d = length(vec2(q.x * taper, q.y * 0.92)) - 0.95;

	// Foreshortening: seen end-on there is no length to draw, and a full arbor would swing
	// around as the camera moved.
	float reach = vDetail * (0.35 + 0.65 * vSeed);
	if (reach > 0.02) {
		// The apical dendrite, thickest of the processes, and its tuft.
		vec2 apex = vec2(0.0, 0.8);
		vec2 top = apex + vec2(0.0, 1.85 * reach);
		d = smin(d, process(q, apex, top, 0.26, 0.1), 0.18);
		d = smin(d, process(q, top, top + vec2(-0.5, 0.55) * reach, 0.09, 0.03), 0.1);
		d = smin(d, process(q, top, top + vec2(0.45, 0.6) * reach, 0.09, 0.03), 0.1);

		// Basal dendrites, fanned below the base. One per few links, so the arbor thickens
		// with the note's place in the graph.
		vec2 base = vec2(0.0, -0.55);
		float count = clamp(vBranches, 2.0, 6.0);
		for (int i = 0; i < 6; i++) {
			if (float(i) >= count) break;
			float t = (float(i) + 0.5) / count;
			float angle = mix(-2.5, -0.65, t);
			vec2 dir = vec2(cos(angle), sin(angle));
			// A kink partway along, so they are not a starburst of straight spokes.
			vec2 mid = base + dir * 0.75 * reach;
			vec2 tip = mid + normalize(dir + vec2(0.0, -0.45)) * 0.7 * reach;
			d = smin(d, process(q, base, mid, 0.2, 0.11), 0.14);
			d = smin(d, process(q, mid, tip, 0.11, 0.02), 0.09);
		}

		// The axon: one, thin, and longer than anything else, straight down into the white.
		d = smin(d, process(q, base, base + vec2(0.12, -3.0) * reach, 0.085, 0.045), 0.1);
	}

	float edge = max(fwidth(d), 0.012);
	float coverage = 1.0 - smoothstep(-edge, edge, d);
	if (coverage <= 0.004) discard;

	// The soma is the solid part; the finer the process, the fainter it draws, which is how
	// these look stained and keeps a thousand arbors from filling the view with lines.
	float body = 1.0 - smoothstep(-0.95, 0.15, d);
	float ink = mix(0.42, 1.0, body);

	// Membrane, not a dot: lit across the soma and brightest at its rim. Measured against
	// the soma's own radius — over the whole arbor the curve flattens out and the cell goes
	// nearly transparent.
	float across = clamp(length(q) / 1.05, 0.0, 1.0);
	float facing = sqrt(max(1.0 - across * across, 0.0));
	vec3 normal = normalize(vec3(q / 1.05, facing + 0.2));
	float lambert = 0.45 + 0.55 * max(dot(normal, normalize(vec3(-0.35, 0.55, 0.76))), 0.0);
	float rim = pow(1.0 - facing, 2.2);

	vec3 resting = vTint.rgb * lambert;
	vec3 firing = mix(vTint.rgb, vec3(1.0), 0.45) * 2.8;
	vec3 color = mix(resting, firing, clamp(vFire, 0.0, 1.0));
	color = mix(color, vec3(1.0, 0.96, 0.9) * 3.2, clamp(vArrive, 0.0, 1.0));
	float alpha = clamp(vTint.a * (0.45 + 0.8 * rim) * ink + vFire * 0.9 + vArrive, 0.0, 1.0) * coverage;
	gl_FragColor = vec4(mix(fogColor, color, fogFactor(vDepth)), alpha);
}`;

/** The flare around a firing cell. Nothing at all until it fires. */
Effect.ShadersStore.brainFlareVertexShader = `
precision highp float;
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size;
attribute float fireAt; attribute float fireGain; attribute float arriveAt;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${SPIKE}
${POP}
${ARRIVAL}
void main() {
	vTint = vec4(0.0); vCorner = corner; vDepth = 0.0;
	float fire = spike(time - fireAt) * fireGain;
	float flash = popFlash(time - arriveAt);
	float glow = max(fire, flash);
	if (glow <= 0.004 || size <= 0.0) { ${CULL} return; }
	vec4 viewPos = view * vec4(position + arrivalPush(position, time), 1.0);
	viewPos.xy += corner * size * (0.45 + 0.55 * glow);
	gl_Position = projection * viewPos;
	vTint = vec4(mix(tint.rgb, vec3(1.0, 0.96, 0.9), flash), tint.a * glow); vDepth = -viewPos.z;
}`;

/**
 * Dust hanging in the space the brain sits in.
 *
 * The motes live in one cube that travels with the camera, wrapped into it by a modulo, so
 * there is always dust wherever you fly and a couple of thousand of them cover an infinite
 * volume. They are placed in world space, not on the screen, which is the whole point: fly
 * with WASD and the near ones sweep past while the far ones barely shift, and that parallax
 * is what tells you that you are moving rather than that the brain is turning.
 *
 * A slow drift keeps them alive when the camera is still. The big faint ones are the haze:
 * at a few percent alpha, added rather than blended, they read as depth in the medium
 * rather than as objects.
 */
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

/** A signal riding one synapse: alive between fireAt and fireAt + travel, then gone. */
Effect.ShadersStore.brainImpulseVertexShader = `
precision highp float;
attribute vec3 position; attribute vec3 target; attribute vec2 corner; attribute vec4 tint;
attribute float size; attribute float fireAt; attribute float travel;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${ARRIVAL}
void main() {
	vTint = vec4(0.0); vCorner = corner; vDepth = 0.0;
	float t = (time - fireAt) / max(travel, 0.001);
	if (t < 0.0 || t > 1.0) { ${CULL} return; }
	float envelope = sin(t * 3.14159265);
	vec3 along = mix(position, target, t);
	vec4 viewPos = view * vec4(along + arrivalPush(along, time), 1.0);
	viewPos.xy += corner * size * (0.55 + 0.45 * envelope);
	gl_Position = projection * viewPos;
	vTint = vec4(tint.rgb, tint.a * envelope); vDepth = -viewPos.z;
}`;

/** Additive radial glow with a steep falloff: a point of light, not a wash. */
Effect.ShadersStore.brainGlowFragmentShader = `
precision highp float;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${FOG}
void main() {
	float a = smoothstep(1.0, 0.0, length(vCorner));
	a = pow(a, 3.0) * vTint.a * fogFactor(vDepth);
	gl_FragColor = vec4(vTint.rgb * a, 1.0);
}`;

/**
 * A synapse. Faint at rest; when it conducts, a bright band runs from one end to the
 * other with a fading trail behind it. `travel` carries the direction in its sign.
 */
Effect.ShadersStore.brainSynapseVertexShader = `
precision highp float;
attribute vec3 position; attribute vec4 color; attribute float along;
attribute float fireAt; attribute float travel;
uniform mat4 worldViewProjection; uniform float time;
varying vec4 vColor; varying float vAlong; varying float vT;
${ARRIVAL}
void main() {
	gl_Position = worldViewProjection * vec4(position + arrivalPush(position, time), 1.0);
	vColor = color;
	// Measure along the direction of travel, so a backwards impulse needs no extra data.
	vAlong = travel >= 0.0 ? along : 1.0 - along;
	vT = (time - fireAt) / max(abs(travel), 0.001);
}`;

Effect.ShadersStore.brainSynapseFragmentShader = `
precision highp float;
varying vec4 vColor; varying float vAlong; varying float vT;
void main() {
	float band = 0.0;
	if (vT >= 0.0 && vT < 2.0) {
		float fade = 1.0 - smoothstep(1.0, 2.0, vT);
		float head = clamp(vT, 0.0, 1.0);
		float d = vAlong - head;
		band = exp(-d * d * 14.0) * fade;
		if (vAlong < head) band = max(band, 0.35 * exp(-(head - vAlong) * 3.0) * fade);
	}
	float alpha = clamp(vColor.a + band * 0.95, 0.0, 1.0);
	gl_FragColor = vec4(vColor.rgb + band * 2.0, alpha);
}`;
