// The synapses: one line-list mesh for every edge, drawn with a shader that keeps them
// faint at rest and runs a bright band along one when it conducts. Colours are written
// on an emphasis change; firing times on a volley. Never per frame.

import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "./shaders.js";

/**
 * How present each kind of synapse is at rest. Explicit links lead; a similarity guess is
 * barely there, which is what lets three thousand of them describe a shape you can see
 * through rather than a ball of wool. Guessed edges outnumber written ones two to one, so
 * they are held down far enough that the cells, not the wiring, are what the eye lands on.
 */
export const EDGE_ALPHA = { wikilink: 0.11, cooccur: 0.1, timeline: 0.07, semantic: 0.019, tag: 0.016 };
const DIM_ALPHA = 0.02;
const HI_ALPHA = 0.55;
const TIMELINE_TINT = [0.58, 0.6, 0.68];
const NEVER = -1e9;

export function createSynapseLayer(scene, graph, arrivalReach = 1) {
	const { nodes, edges } = graph;
	const count = edges.length;
	const positions = new Float32Array(count * 6);
	const along = new Float32Array(count * 2);
	const indices = new Uint32Array(count * 2);
	for (let i = 0; i < count; i++) {
		const source = nodes[edges[i].source];
		const target = nodes[edges[i].target];
		positions.set([source.x, source.y, source.z, target.x, target.y, target.z], i * 6);
		along.set([0, 1], i * 2);
		indices.set([i * 2, i * 2 + 1], i * 2);
	}
	const colors = new Float32Array(count * 8);
	const fireAt = new Float32Array(count * 2).fill(NEVER);
	const travel = new Float32Array(count * 2).fill(1);

	const material = new ShaderMaterial(
		"synapseMat",
		scene,
		{ vertex: "brainSynapse", fragment: "brainSynapse" },
		{
			attributes: ["position", "color", "along", "fireAt", "travel"],
			uniforms: ["worldViewProjection", "time", "arrivals", "arrivalCount", "arrivalRange"],
			needAlphaBlending: true,
		},
	);
	material.alphaMode = Constants.ALPHA_COMBINE;
	material.disableDepthWrite = true;
	material.fillMode = Constants.MATERIAL_LineListDrawMode;
	material.setFloat("arrivalCount", 0);
	material.setFloat("arrivalRange", arrivalReach);

	const mesh = new Mesh("synapses", scene);
	mesh.material = material;
	mesh.isPickable = false;
	mesh.alwaysSelectAsActiveMesh = true;
	mesh.doNotSyncBoundingInfo = true;
	mesh.renderingGroupId = 0;
	const vertexData = new VertexData();
	vertexData.positions = positions;
	vertexData.indices = indices;
	vertexData.applyToMesh(mesh, false);
	mesh.setVerticesData("along", along, false, 1);
	mesh.setVerticesData("color", colors, true, 4);
	mesh.setVerticesData("fireAt", fireAt, true, 1);
	mesh.setVerticesData("travel", travel, true, 1);

	/**
	 * @param {(edge: object, i: number) => "hidden"|"dim"|"normal"|"hi"} stateOf
	 * @param {(node: object) => number[]} tintOf  rgb of a node's lobe
	 */
	function restyle(stateOf, tintOf) {
		for (let i = 0; i < count; i++) {
			const edge = edges[i];
			const state = stateOf(edge, i);
			const o = i * 8;
			if (state === "hidden") {
				colors.fill(0, o, o + 8);
				continue;
			}
			const timeline = edge.kind === "timeline";
			const source = timeline ? TIMELINE_TINT : tintOf(nodes[edge.source]);
			const target = timeline ? TIMELINE_TINT : tintOf(nodes[edge.target]);
			const alpha = state === "dim" ? DIM_ALPHA : state === "hi" ? HI_ALPHA : EDGE_ALPHA[edge.kind] ?? 0.06;
			colors.set([source[0], source[1], source[2], alpha, target[0], target[1], target[2], alpha], o);
		}
		mesh.updateVerticesData("color", colors);
	}

	/** Light the given edges as signals run along them. `forward` is source to target. */
	function conduct(impulses) {
		for (const impulse of impulses) {
			const o = impulse.edge * 2;
			const signed = impulse.forward ? impulse.travel : -impulse.travel;
			fireAt[o] = impulse.at;
			fireAt[o + 1] = impulse.at;
			travel[o] = signed;
			travel[o + 1] = signed;
		}
		mesh.updateVerticesData("fireAt", fireAt);
		mesh.updateVerticesData("travel", travel);
	}

	return {
		mesh,
		restyle,
		conduct,
		setTime: (seconds) => material.setFloat("time", seconds),
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
