// A layer of camera-facing quads in one mesh: one draw call however many there are.
// Per-instance attributes are stored four times (once per corner) and rewritten only
// when something changes — a hover, a filter, a reseed — never per frame.

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "./shaders.js";

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {number} spec.count
 * @param {"brainSprite"|"brainSpark"} spec.vertex
 * @param {"brainCore"|"brainGlow"} spec.fragment
 * @param {boolean} spec.additive  glow layers add light and never write depth
 * @param {string[]} [spec.extraAttributes]  per-instance vec3 attributes beyond the standard set
 */
export function createSpriteLayer(scene, spec) {
	const { count } = spec;
	const material = new ShaderMaterial(
		`${spec.name}Mat`,
		scene,
		{ vertex: spec.vertex, fragment: spec.fragment },
		{
			attributes: ["position", "corner", "tint", "size", "phase", ...(spec.extraAttributes ?? [])],
			uniforms: ["view", "projection", "time", "pulse", "fogDensity", "fogColor"],
			needAlphaBlending: spec.additive,
		},
	);
	if (spec.additive) {
		material.alphaMode = Constants.ALPHA_ADD;
		material.disableDepthWrite = true;
	}
	material.backFaceCulling = false;
	material.setFloat("time", 0);
	material.setFloat("pulse", 0);
	material.setFloat("fogDensity", scene.fogDensity);
	material.setColor3("fogColor", scene.fogColor);

	const mesh = new Mesh(spec.name, scene);
	mesh.material = material;
	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true;
	mesh.doNotSyncBoundingInfo = true;

	const corners = new Float32Array(count * 8);
	const indices = new Uint32Array(count * 6);
	for (let i = 0; i < count; i++) {
		corners.set(CORNERS, i * 8);
		const v = i * 4;
		indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
	}
	const vertexData = new VertexData();
	vertexData.positions = new Float32Array(count * 12);
	vertexData.indices = indices;
	vertexData.applyToMesh(mesh, true);
	mesh.setVerticesData("corner", corners, false, 2);
	mesh.setVerticesData("tint", new Float32Array(count * 16), true, 4);
	mesh.setVerticesData("size", new Float32Array(count * 4), true, 1);
	mesh.setVerticesData("phase", new Float32Array(count * 4), true, 1);
	for (const name of spec.extraAttributes ?? []) mesh.setVerticesData(name, new Float32Array(count * 12), true, 3);

	/** Write one vec3 per instance into a per-corner buffer. */
	function writeVec3(kind, values) {
		const data = new Float32Array(count * 12);
		for (let i = 0; i < count; i++) {
			const x = values[i * 3];
			const y = values[i * 3 + 1];
			const z = values[i * 3 + 2];
			for (let c = 0; c < 4; c++) data.set([x, y, z], i * 12 + c * 3);
		}
		mesh.updateVerticesData(kind, data);
	}

	return {
		mesh,
		material,
		count,
		setPositions: (values) => writeVec3(VertexBuffer.PositionKind, values),
		setVec3: (kind, values) => writeVec3(kind, values),
		/** rgba per instance. */
		setTints(values) {
			const data = new Float32Array(count * 16);
			for (let i = 0; i < count; i++) {
				for (let c = 0; c < 4; c++) data.set(values.subarray(i * 4, i * 4 + 4), i * 16 + c * 4);
			}
			mesh.updateVerticesData("tint", data);
		},
		setSizes(values) {
			const data = new Float32Array(count * 4);
			for (let i = 0; i < count; i++) data.fill(values[i], i * 4, i * 4 + 4);
			mesh.updateVerticesData("size", data);
		},
		setPhases(values) {
			const data = new Float32Array(count * 4);
			for (let i = 0; i < count; i++) data.fill(values[i], i * 4, i * 4 + 4);
			mesh.updateVerticesData("phase", data);
		},
		setTime: (seconds) => material.setFloat("time", seconds),
		setPulse: (amount) => material.setFloat("pulse", amount),
		dispose() {
			mesh.dispose();
			material.dispose();
		},
	};
}
