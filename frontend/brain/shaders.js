// Every node, halo and spark is a camera-facing quad expanded on the GPU. The CPU never
// rotates a billboard or rebuilds a vertex buffer per frame: a frame costs one uniform
// (time) and whatever the camera did. Breathing halos and travelling sparks are
// functions of time inside the vertex shader.

import { Effect } from "@babylonjs/core/Materials/effect";

const FOG = `
uniform float fogDensity; uniform vec3 fogColor;
float fogFactor(float depth) { float d = depth * fogDensity; return clamp(exp(-d * d), 0.0, 1.0); }`;

/** Static sprite: the quad sits at `position`, sized by `size`, pulsing by `phase` when `pulse` > 0. */
Effect.ShadersStore.brainSpriteVertexShader = `
precision highp float;
attribute vec3 position; attribute vec2 corner; attribute vec4 tint; attribute float size; attribute float phase;
uniform mat4 view; uniform mat4 projection; uniform float time; uniform float pulse;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
void main() {
	vec4 viewPos = view * vec4(position, 1.0);
	float s = size * (1.0 + pulse * 0.08 * sin(time * 1.4 + phase));
	viewPos.xy += corner * s;
	gl_Position = projection * viewPos;
	vTint = tint; vCorner = corner; vDepth = -viewPos.z;
}`;

/** A spark rides its edge from `position` to `target`, restarting when it arrives. */
Effect.ShadersStore.brainSparkVertexShader = `
precision highp float;
attribute vec3 position; attribute vec3 target; attribute vec2 corner; attribute vec4 tint; attribute float size; attribute float phase;
uniform mat4 view; uniform mat4 projection; uniform float time;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
void main() {
	float t = fract(phase + time * size);
	float arc = sin(t * 3.14159265);
	vec4 viewPos = view * vec4(mix(position, target, t), 1.0);
	viewPos.xy += corner * (1.6 + arc * 1.2);
	gl_Position = projection * viewPos;
	vTint = vec4(tint.rgb, tint.a * arc); vCorner = corner; vDepth = -viewPos.z;
}`;

/** A lit sphere drawn on a disc: the normal comes from the disc, so no geometry is needed. */
Effect.ShadersStore.brainCoreFragmentShader = `
precision highp float;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${FOG}
void main() {
	float d2 = dot(vCorner, vCorner);
	if (d2 > 1.0) discard;
	vec3 normal = vec3(vCorner, sqrt(1.0 - d2));
	float light = 0.55 + 0.45 * max(dot(normal, normalize(vec3(-0.4, 0.6, 0.75))), 0.0);
	vec3 color = vTint.rgb * light;
	gl_FragColor = vec4(mix(fogColor, color, fogFactor(vDepth)), 1.0);
}`;

/** Additive radial glow with a steep falloff, so halos read as rims instead of washing the scene out. */
Effect.ShadersStore.brainGlowFragmentShader = `
precision highp float;
varying vec4 vTint; varying vec2 vCorner; varying float vDepth;
${FOG}
void main() {
	float a = smoothstep(1.0, 0.0, length(vCorner));
	a = pow(a, 4.0) * vTint.a * fogFactor(vDepth);
	gl_FragColor = vec4(vTint.rgb * a, 1.0);
}`;
