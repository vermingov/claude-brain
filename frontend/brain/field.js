// The brain, as one mesh.
//
// Every note is a soma and every link is a process running from one soma into the other, so
// the wiring is what the cells are made of rather than lines drawn past them. It replaces
// three layers that used to do this between them: billboarded discs for the notes, a
// line-list for the synapses, and a pool of sprites for the signals in flight.
//
// Two things made that swap worth it. Billboards are camera-facing, so anything drawn
// inside one has the screen's axes for its own — orbit the camera and every arbor swings
// with it. And a line between two dots cannot show a signal leaving the cell at either end,
// only at the one that happened to be written first.
//
// What is left per frame is one clock. Everything else is a texture of two rows per note —
// what it is doing, and how it is being shown — so a volley of three hundred notes is
// twelve hundred texels rather than a walk over six hundred thousand vertices.

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { emptyField, growConnection, growSoma, growStub } from "./neuron-mesh.js";
import { createFieldMaterial } from "./field-shader.js";

/** Seconds for a signal to cross one process, and the floor on how often a cell may fire. */
export const TRAVEL = 0.8;
/**
 * A cell that fired this recently keeps its clock when it is called again.
 *
 * Its signals are drawn from that clock and are still part way down every process leaving
 * it; restarting it stops all of them where they stand, which is the one thing that reads
 * as a glitch rather than as an event. A real neuron will not fire again this soon either.
 */
const REFRACTORY = TRAVEL * 1.15;
/** How solid a note is at rest, by what the view is doing with it. */
const EMPHASIS = { normal: 1, dim: 0.34, hi: 1.5, hidden: 0 };
/** Soma radius from a note's links: a hub is a bigger cell, as it was when they were discs. */
const SOMA = (connections) => 2.6 + Math.sqrt(connections + 1) * 0.9;

function smoothstep(edge0, edge1, value) {
	const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/** Deterministic, so the same vault grows the same brain twice. */
function random(seed) {
	let state = (seed * 2654435761) >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/**
 * @param {import("@babylonjs/core/scene").Scene} scene
 * @param {{nodes: Array<object>, edges: Array<{source: number, target: number}>}} graph
 * @param {{arrivalRange: number, visible: (index: number) => boolean, tintOf: (node: object) => number[]}} view
 */
export function createField(scene, graph, view) {
	const { nodes, edges } = graph;
	const notes = nodes.length;
	const next = random(nodes.length * 31 + edges.length);
	const radii = nodes.map((node) => SOMA(node.connections));
	const links = new Array(notes).fill(0);
	for (const edge of edges) {
		links[edge.source]++;
		links[edge.target]++;
	}

	// The graph's nodes are plain coordinates; the geometry works in vectors.
	const at = nodes.map((node) => new Vector3(node.x, node.y, node.z));

	const mesh = emptyField();
	nodes.forEach((node, i) => growSoma(mesh, at[i], radii[i], i, next() * 6.28));
	for (const edge of edges) {
		growConnection(mesh, at[edge.source], at[edge.target], {
			radius: Math.min(radii[edge.source], radii[edge.target]) * 0.3,
			bow: 0.05 + next() * 0.12,
			jitter: next() * 6.28,
			cellA: edge.source,
			cellB: edge.target,
		});
	}
	// A note nothing links to still has to look like a cell rather than a bead.
	nodes.forEach((node, i) => {
		if (links[i] > 0) return;
		for (let k = 0; k < 4; k++) {
			const direction = new Vector3(next() - 0.5, next() - 0.5, next() - 0.5).normalize();
			growStub(mesh, at[i], direction, radii[i] * 4, radii[i] * 0.28, i);
		}
	});

	const vertices = mesh.positions.length / 3;
	const tints = new Float32Array(vertices * 4);
	for (let v = 0; v < vertices; v++) {
		const tint = view.tintOf(nodes[mesh.cell[v]]);
		tints.set([tint[0], tint[1], tint[2], 1], v * 4);
	}

	const data = new VertexData();
	data.positions = new Float32Array(mesh.positions);
	data.normals = new Float32Array(mesh.normals);
	data.indices = new Uint32Array(mesh.indices);
	const body = new Mesh("brainField", scene);
	data.applyToMesh(body, false);
	body.setVerticesData("tint", tints, false, 4);
	body.setVerticesData("along", new Float32Array(mesh.along), false, 1);
	body.setVerticesData("cell", new Float32Array(mesh.cell), false, 1);
	body.setVerticesData("source", new Float32Array(mesh.source), false, 1);
	body.setVerticesData("target", new Float32Array(mesh.target), false, 1);
	body.setVerticesData("run", new Float32Array(mesh.run), false, 1);
	body.isPickable = false;
	body.alwaysSelectAsActiveMesh = true;
	body.renderingGroupId = 0;

	const material = createFieldMaterial(scene, { notes, travel: TRAVEL, arrivalRange: view.arrivalRange });
	body.material = material;

	// Row 0: when it last fired, how hard, and what it was still glowing and flashing with
	// when it was re-lit. Row 1: when it arrived in the vault, and how present it is now.
	const state = new Float32Array(notes * 2 * 4);
	const SHOWN = notes * 4;
	for (let i = 0; i < notes; i++) state[SHOWN + i * 4 + 1] = EMPHASIS.normal;
	const texture = new RawTexture(
		state,
		notes,
		2,
		Constants.TEXTUREFORMAT_RGBA,
		scene,
		false,
		false,
		Constants.TEXTURE_NEAREST_SAMPLINGMODE,
		Constants.TEXTURETYPE_FLOAT,
	);
	material.setTexture("noteState", texture);

	let pending = null;
	/** Upload once per batch, not once per note. */
	function commit() {
		if (pending) return;
		pending = setTimeout(() => {
			pending = null;
			texture.update(state);
		}, 0);
	}

	/**
	 * Light one note now, keeping whatever it already had.
	 *
	 * Nothing is ever stamped with a time in the future. A cell's afterglow and every packet
	 * running out of it are computed against its clock, so a clock pointing forward switches
	 * all of it off until the moment arrives — which is what the cascade's own plan would do
	 * if its hops were written straight in. The caller plays each hop when it lands instead.
	 */
	function light(index, gain) {
		const now = performance.now() / 1000;
		const previous = state[index * 4];
		const busy = previous > 0 ? now - previous : Number.POSITIVE_INFINITY;
		if (busy < REFRACTORY) {
			state[index * 4 + 1] = Math.max(state[index * 4 + 1], gain);
			commit();
			return;
		}
		const since = previous > 0 ? busy : -1;
		state[index * 4] = now;
		state[index * 4 + 1] = gain;
		// What it was still putting out, handed over as the level to carry on from, so a
		// re-lit cell can only brighten.
		state[index * 4 + 2] = since >= 0 ? Math.min(1, Math.exp(-since * 0.3)) : 0;
		state[index * 4 + 3] =
			since >= 0 ? Math.min(1, smoothstep(0, 0.26, since) * Math.exp(-since * 1.4) * gain) : 0;
		commit();
	}

	return {
		mesh: body,
		radii,
		/** A note landed in the vault: it pops and burns white for about a second. */
		arrive(index) {
			state[SHOWN + index * 4] = performance.now() / 1000;
			commit();
		},
		light,
		/** What the view is doing with each note: hover, selection, a search, a hidden lobe. */
		restyle(stateOf) {
			for (let i = 0; i < notes; i++) {
				state[SHOWN + i * 4 + 1] = EMPHASIS[stateOf(i)] ?? EMPHASIS.normal;
			}
			commit();
		},
		setTime: (seconds) => material.setFloat("time", seconds),
		setCamera: (position) => material.setVector3("cameraPosition", position),
		setArrivals(data, count) {
			material.setArray4("arrivals", data);
			material.setFloat("arrivalCount", count);
		},
		dispose() {
			clearTimeout(pending);
			body.dispose();
			material.dispose();
			texture.dispose();
		},
	};
}
