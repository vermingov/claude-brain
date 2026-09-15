// A layer of camera-facing quads in one mesh: one draw call however many there are.
// Per-instance values are stored four times, once per corner, and written only when
// something changes — an emphasis change, or a volley of impulses.

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "./shaders.js";

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
/** Always present, in every sprite shader. */
const STANDARD = [
	{ name: "tint", size: 4 },
	{ name: "size", size: 1 },
];

/**
 * @param {object} spec
 * @param {number} [spec.arrivalRange]  how far an arrival's shove carries, in layout units
 * @param {string} spec.name
 * @param {number} spec.count
 * @param {string} spec.vertex  shader name, without the Vertex suffix
 * @param {string} spec.fragment
 * @param {"alpha"|"add"} spec.blend
 * @param {Array<{name: string, size: number}>} [spec.attributes]  extra per-instance values
 * @param {number} [spec.renderingGroup]  draw order between layers
 */
export function createSpriteLayer(scene, spec) {
	const { count } = spec;
	const perInstance = [...STANDARD, ...(spec.attributes ?? [])];
	const material = new ShaderMaterial(
		`${spec.name}Mat`,
		scene,
		{ vertex: spec.vertex, fragment: spec.fragment },
		{
			attributes: ["position", "corner", ...perInstance.map((a) => a.name)],
			uniforms: ["view", "projection", "time", "fogDensity", "fogColor", "arrivals", "arrivalCount", "arrivalRange"],
			needAlphaBlending: true,
		},
	);
	material.alphaMode = spec.blend === "add" ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
	// Nothing here is opaque, so nothing writes depth; the layers' draw order decides.
	material.disableDepthWrite = true;
	material.backFaceCulling = false;
	material.setFloat("time", 0);
	material.setFloat("arrivalCount", 0);
	material.setFloat("arrivalRange", spec.arrivalRange ?? 1);
	material.setFloat("fogDensity", scene.fogDensity);
	material.setColor3("fogColor", scene.fogColor);

	const mesh = new Mesh(spec.name, scene);
	mesh.material = material;
	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true;
	mesh.doNotSyncBoundingInfo = true;
	if (spec.renderingGroup !== undefined) mesh.renderingGroupId = spec.renderingGroup;

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

	const buffers = new Map();
	for (const attribute of perInstance) {
		const data = new Float32Array(count * 4 * attribute.size);
		buffers.set(attribute.name, { data, size: attribute.size });
		mesh.setVerticesData(attribute.name, data, true, attribute.size);
	}
	const positions = new Float32Array(count * 12);

	/** Per-instance values, expanded across the instance's four corners. */
	function set(name, values) {
		if (name === "position") {
			for (let i = 0; i < count; i++) {
				const x = values[i * 3];
				const y = values[i * 3 + 1];
				const z = values[i * 3 + 2];
				for (let c = 0; c < 4; c++) positions.set([x, y, z], i * 12 + c * 3);
			}
			mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
			return;
		}
		const buffer = buffers.get(name);
		const { data, size } = buffer;
		for (let i = 0; i < count; i++) {
			for (let c = 0; c < 4; c++) {
				for (let k = 0; k < size; k++) data[i * 4 * size + c * size + k] = values[i * size + k];
			}
		}
		mesh.updateVerticesData(name, data);
	}

	return {
		mesh,
		count,
		set,
		setTime: (seconds) => material.setFloat("time", seconds),
		/** Where things have just landed: the shader animates the shove from the clock. */
		setArrivals(data, count) {
			material.setArray4("arrivals", data);
			material.setFloat("arrivalCount", count);
		},
		dispose() {
			mesh.dispose();
			material.dispose();
		},
	};
}
