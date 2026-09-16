// How the neuron field is lit.
//
// Not lit, really — a fluorescence image has no lamp in it. A cell is bright where you are
// looking through the most of it, which is the rim of every tube, and the rest is emission.
// So the shading is a fresnel term against the surface normal plus whatever the cell is
// currently emitting, with a soft lamp on top for modelling so the tubes read as round
// rather than as flat ribbon.
//
// At rest that emission is almost nothing. Firing is the only thing in the view that makes
// light, and everything animated here is a function of one clock and one small texture of
// per-note state, so the CPU writes twelve hundred texels on a volley and nothing per frame.

import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { MAX_ARRIVALS } from "./shaders.js";

/**
 * Room being made for something new, shared with the sprite layers so the dust and the
 * cells are shoved by the same wave. A note lands and what is around it gets out of the
 * way along an expanding front, then settles back with one overshoot.
 */
const ARRIVAL = `
#define MAX_ARRIVALS ${MAX_ARRIVALS}
uniform vec4 arrivals[MAX_ARRIVALS];
uniform float arrivalCount;
uniform float arrivalRange;

vec3 arrivalPush(vec3 world, float now) {
	vec3 shift = vec3(0.0);
	for (int i = 0; i < MAX_ARRIVALS; i++) {
		vec4 a = arrivals[i];
		float live = step(float(i), arrivalCount - 0.5);
		float age = now - a.w;
		live *= step(0.0, age) * step(age, 1.8);
		vec3 away = world - a.xyz;
		float dist = max(length(away), 0.001);
		float crest = exp(-pow((dist - age * 210.0) / 60.0, 2.0));
		float reach = max(1.0 - dist / arrivalRange, 0.0);
		float settle = exp(-age * 2.2) * cos(age * 5.0);
		shift += (away / dist) * (17.0 * crest * reach * reach * settle * live);
	}
	return shift;
}`;

Effect.ShadersStore.brainFieldVertexShader = `
precision highp float;
attribute vec3 position; attribute vec3 normal; attribute vec4 tint;
attribute float along; attribute float cell; attribute float source; attribute float target; attribute float run;
uniform mat4 viewProjection; uniform vec3 cameraPosition; uniform float time;
/** Two rows per note: what it is doing, and how it is being shown. */
uniform sampler2D noteState; uniform float noteCount;
varying vec3 vNormal; varying vec3 vToEye; varying float vAlong; varying vec4 vTint; varying float vDepth;
varying float vFire; varying float vRun; varying float vSourceFire; varying float vTargetFire;
varying float vGain; varying float vTargetGain; varying float vSince; varying float vCarried;
varying float vEmphasis; varying float vArrive;
${ARRIVAL}

/** One action potential, eased in over a quarter second so it arrives rather than snaps. */
float spike(float since) {
	if (since < 0.0) return 0.0;
	return smoothstep(0.0, 0.26, since) * exp(-since * 1.4);
}

/** Landing: nothing, then a fast swell past its own size, then a wobble down to it. */
float popFlash(float born) {
	return born < 0.0 ? 0.0 : exp(-born * 1.9);
}

vec4 doing(float index) { return texture2D(noteState, vec2((index + 0.5) / noteCount, 0.25)); }
vec4 shown(float index) { return texture2D(noteState, vec2((index + 0.5) / noteCount, 0.75)); }

void main() {
	// A hidden lobe is moved off screen rather than faded, because the field is one opaque
	// mesh: a transparent cell would still be a black hole in front of everything behind it.
	vec4 hereShown = shown(cell);
	vec4 fromShown = shown(source);
	vec4 toShown = shown(target);
	vEmphasis = min(min(hereShown.g, fromShown.g), toShown.g);
	if (vEmphasis <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

	vec3 world = position + arrivalPush(position, time);
	gl_Position = viewProjection * vec4(world, 1.0);
	vNormal = normalize(normal);
	vToEye = normalize(cameraPosition - world);
	vAlong = along;
	vTint = tint;
	vDepth = length(cameraPosition - world);

	vec4 mine = doing(cell);
	float since = time - mine.r;
	vSince = mine.r > 0.0 ? since : -1.0;
	// Never less than what it was already putting out: a cell re-lit mid-spike brightens
	// rather than dropping to nothing and climbing back, which is what flickers.
	vFire = max(spike(since) * mine.g, mine.a * exp(-max(since, 0.0) * 1.4));
	vCarried = mine.b;

	// Both ends of the connection, because either can be the one that fired. Each gets its
	// own packet running its own way, and the fragment draws whichever is brighter.
	vec4 from = doing(source);
	vec4 to = doing(target);
	vSourceFire = time - from.r;
	vTargetFire = time - to.r;
	vGain = from.g;
	vTargetGain = to.g;
	vRun = run;
	vArrive = popFlash(time - hereShown.r);
}`;

Effect.ShadersStore.brainFieldFragmentShader = `
precision highp float;
varying vec3 vNormal; varying vec3 vToEye; varying float vAlong; varying vec4 vTint; varying float vDepth;
varying float vFire; varying float vRun; varying float vSourceFire; varying float vTargetFire;
varying float vGain; varying float vTargetGain; varying float vSince; varying float vCarried;
varying float vEmphasis; varying float vArrive;
uniform float glow; uniform float beads; uniform float halo;
uniform vec3 fogColor; uniform float fogDensity;
/** How long a signal takes to cross one process. Set from the same constant the cascade
 * uses, so the flash at the far end lands when the packet gets there. */
uniform float travel;

float onset(float since) {
	return since < 0.0 ? 0.0 : smoothstep(0.0, 0.26, since);
}

/**
 * One signal on its way down a process, as (packet, wake). The head is how far it has
 * travelled, zero to one, and where is how far along this fragment sits measured from the
 * same end. A tight head you can follow, a comet tail behind it, and a broader wake
 * lifting the tube around it.
 */
vec2 signal(float head, float where, float gain) {
	if (head < 0.0 || head >= 2.4 || gain <= 0.0) return vec2(0.0);
	float fade = 1.0 - smoothstep(1.0, 2.4, head);
	float born = smoothstep(0.0, 0.16, head);
	float at = clamp(head, 0.0, 1.0);
	float d = where - at;
	float packet = exp(-d * d * 400.0);
	float tail = where < at ? 0.4 * exp(-(at - where) * 7.0) : 0.0;
	return vec2((packet + tail) * fade * born * gain, exp(-d * d * 24.0) * fade * born * gain);
}

void main() {
	vec3 n = normalize(vNormal);
	float facing = abs(dot(n, normalize(vToEye)));
	// Looking along the wall of a tube you see through more of it, which is what makes every
	// process in a fluorescence image glow at its edge rather than at its middle.
	float rim = pow(1.0 - facing, 2.0);
	float lambert = 0.35 + 0.65 * max(dot(n, normalize(vec3(-0.4, 0.7, 0.6))), 0.0);

	float core = smoothstep(0.35, 0.0, vAlong);
	float bead = pow(max(sin(vAlong * 30.0 + vTint.r * 40.0), 0.0), 22.0) * step(0.2, vAlong);

	vec3 base = vTint.rgb * vTint.a * vEmphasis;
	// Firing keeps the lobe's colour rather than washing to white, which is the one thing the
	// colour is there to tell you. Past 1.0 every channel clips and everything fires the same
	// shade, so the hue is taken at full saturation and brightness carries the intensity.
	vec3 hue = vTint.rgb / max(max(vTint.rgb.r, max(vTint.rgb.g, vTint.rgb.b)), 0.001);
	vec3 hot = mix(hue, vec3(1.0), 0.15);

	// At rest this is tissue, not light. Nothing here crosses the bloom threshold, so a
	// brain nobody is using sits quiet and dark.
	vec3 colour = base * (0.11 + 0.17 * lambert) + base * rim * glow * 0.5;
	colour += hot * core * glow * 0.14 * vEmphasis;
	colour += base * halo * 0.07 * rim;

	vec2 outward = signal(vSourceFire / travel, vRun, vGain);
	vec2 backward = signal(vTargetFire / travel, 1.0 - vRun, vTargetGain);
	float band = vRun > 0.0 ? max(outward.x, backward.x) : 0.0;
	float wake = vRun > 0.0 ? max(outward.y, backward.y) : 0.0;

	// Light is what firing looks like, and firing is the only thing that makes any. The
	// vesicles come up with it, so a process carrying something is beaded and an idle one is
	// a plain tube.
	float live = max(clamp(vFire, 0.0, 1.0), band);
	colour += hot * bead * beads * (0.1 + 2.6 * live);
	colour += hue * wake * 0.75;
	colour = mix(colour, mix(hue, vec3(1.0), 0.08) * 3.0, clamp(vFire, 0.0, 1.0));
	colour += mix(hue, vec3(1.0), 0.1) * band * 3.2;

	// A cell does not snap back to grey the moment the spike is over: a note that was just
	// used keeps some of its colour for several seconds and loses it smoothly, so the region
	// an agent has been working in stays warm behind it. It starts from whatever was left
	// over, so a cell re-lit brightens rather than blinking out and coming back.
	if (vSince >= 0.0) {
		float ramp = vCarried + (1.0 - vCarried) * onset(vSince);
		colour += hue * ramp * exp(-vSince * 0.3) * vGain * 0.5;
	}
	// And a note that has just arrived in the vault burns white for about a second.
	colour = mix(colour, vec3(1.0, 0.96, 0.9) * 3.2, clamp(vArrive, 0.0, 1.0));

	float fog = clamp(exp(-pow(vDepth * fogDensity, 2.0)), 0.0, 1.0);
	gl_FragColor = vec4(mix(fogColor, colour, fog), 1.0);
}`;

export function createFieldMaterial(scene, options) {
	const material = new ShaderMaterial(
		"brainField",
		scene,
		{ vertex: "brainField", fragment: "brainField" },
		{
			attributes: ["position", "normal", "tint", "along", "cell", "source", "target", "run"],
			uniforms: [
				"viewProjection",
				"cameraPosition",
				"time",
				"noteCount",
				"travel",
				"glow",
				"beads",
				"halo",
				"fogColor",
				"fogDensity",
				"arrivals",
				"arrivalCount",
				"arrivalRange",
			],
			samplers: ["noteState"],
		},
	);
	material.backFaceCulling = true;
	material.alphaMode = Constants.ALPHA_DISABLE;
	material.setFloat("time", 0);
	material.setFloat("noteCount", options.notes);
	material.setFloat("travel", options.travel);
	material.setFloat("glow", 0.75);
	material.setFloat("beads", 1);
	material.setFloat("halo", 0.25);
	material.setFloat("arrivalCount", 0);
	material.setFloat("arrivalRange", options.arrivalRange);
	material.setFloat("fogDensity", scene.fogDensity);
	material.setColor3("fogColor", scene.fogColor);
	return material;
}
