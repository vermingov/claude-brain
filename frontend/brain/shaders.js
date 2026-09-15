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

Effect.ShadersStore.brainCellVertexShader = `
precision highp float;
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size;
attribute float fireAt; attribute float fireGain;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth; varying float vFire;
${SPIKE}
void main() {
	vTint = tint; vCorner = corner; vDepth = 0.0; vFire = 0.0;
	if (size <= 0.0) { ${CULL} return; }
	float fire = spike(time - fireAt) * fireGain;
	vec4 viewPos = view * vec4(position, 1.0);
	viewPos.xy += corner * size * (1.0 + 0.5 * fire);
	gl_Position = projection * viewPos;
	vDepth = -viewPos.z; vFire = fire;
}`;

/**
 * A cell at rest is membrane, not light: rim-lit, hollow in the middle, so a thousand of
 * them read as tissue you can see through rather than a field of dots. Firing is the only
 * thing that crosses the bloom threshold.
 */
Effect.ShadersStore.brainCellFragmentShader = `
precision highp float;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth; varying float vFire;
${FOG}
void main() {
	float d = length(vCorner);
	// The rim is blended over one screen pixel, so a disc has no staircase edge.
	float edge = max(fwidth(d), 0.0015);
	float coverage = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, d);
	if (coverage <= 0.003) discard;
	float facing = sqrt(max(1.0 - d * d, 0.0));
	vec3 normal = vec3(vCorner, facing);
	float rim = pow(1.0 - facing, 2.2);
	float lambert = 0.45 + 0.55 * max(dot(normal, normalize(vec3(-0.35, 0.55, 0.76))), 0.0);
	vec3 resting = vTint.rgb * lambert;
	// Keeps enough of the lobe's hue to say which part of the brain is working.
	vec3 firing = mix(vTint.rgb, vec3(1.0), 0.45) * 2.8;
	vec3 color = mix(resting, firing, clamp(vFire, 0.0, 1.0));
	float alpha = clamp(vTint.a * (0.3 + 0.7 * rim) + vFire * 0.9, 0.0, 1.0) * coverage;
	gl_FragColor = vec4(mix(fogColor, color, fogFactor(vDepth)), alpha);
}`;

/** The flare around a firing cell. Nothing at all until it fires. */
Effect.ShadersStore.brainFlareVertexShader = `
precision highp float;
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size;
attribute float fireAt; attribute float fireGain;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${SPIKE}
void main() {
	vTint = vec4(0.0); vCorner = corner; vDepth = 0.0;
	float fire = spike(time - fireAt) * fireGain;
	if (fire <= 0.004 || size <= 0.0) { ${CULL} return; }
	vec4 viewPos = view * vec4(position, 1.0);
	viewPos.xy += corner * size * (0.45 + 0.55 * fire);
	gl_Position = projection * viewPos;
	vTint = vec4(tint.rgb, tint.a * fire); vDepth = -viewPos.z;
}`;

/** A signal riding one synapse: alive between fireAt and fireAt + travel, then gone. */
Effect.ShadersStore.brainImpulseVertexShader = `
precision highp float;
attribute vec3 position; attribute vec3 target; attribute vec2 corner; attribute vec4 tint;
attribute float size; attribute float fireAt; attribute float travel;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
void main() {
	vTint = vec4(0.0); vCorner = corner; vDepth = 0.0;
	float t = (time - fireAt) / max(travel, 0.001);
	if (t < 0.0 || t > 1.0) { ${CULL} return; }
	float envelope = sin(t * 3.14159265);
	vec4 viewPos = view * vec4(mix(position, target, t), 1.0);
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
void main() {
	gl_Position = worldViewProjection * vec4(position, 1.0);
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
