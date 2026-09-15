// Titles, on demand. The resting brain carries no text: a label appears for the note
// under the pointer, the one being read, a search hit, or a note that just fired, and
// goes away with it. Textures are made on first use and a small pool is kept.

import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

const FONT_PX = 44;
const PAD = 16;
const SCALE = 0.1;
/** Textures kept around; past this the least recently shown is thrown away. */
const POOL = 48;

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function makeLabel(scene, node, radius) {
	const text = truncate(node.title, 40);
	const measure = new DynamicTexture("measure", { width: 2, height: 2 }, scene, false);
	const context = measure.getContext();
	context.font = `500 ${FONT_PX}px system-ui, sans-serif`;
	const width = Math.ceil(context.measureText(text).width) + PAD * 2;
	measure.dispose();
	const height = FONT_PX + PAD * 2;
	const texture = new DynamicTexture(`label:${node.id}`, { width, height }, scene, true);
	texture.hasAlpha = true;
	const ctx = texture.getContext();
	ctx.font = `500 ${FONT_PX}px system-ui, sans-serif`;
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";
	ctx.fillStyle = "rgba(242,237,229,0.95)";
	ctx.fillText(text, width / 2, height / 2);
	texture.update();
	const material = new StandardMaterial(`labelMat:${node.id}`, scene);
	material.emissiveTexture = texture;
	material.opacityTexture = texture;
	material.disableLighting = true;
	material.fogEnabled = false;
	const plane = CreatePlane(`labelPlane:${node.id}`, { width: width * SCALE, height: height * SCALE }, scene);
	plane.material = material;
	plane.billboardMode = TransformNode.BILLBOARDMODE_ALL;
	plane.isPickable = false;
	plane.renderingGroupId = 3;
	plane.position.set(node.x, node.y - (radius + 6), node.z);
	return plane;
}

export function createLabels(scene, graph, radii) {
	const live = new Map();
	let clock = 0;

	function ensure(index) {
		let entry = live.get(index);
		if (!entry) {
			entry = { plane: makeLabel(scene, graph.nodes[index], radii[index]), usedAt: 0 };
			live.set(index, entry);
		}
		entry.usedAt = clock++;
		return entry;
	}

	function evict() {
		while (live.size > POOL) {
			let oldest = null;
			for (const [index, entry] of live) {
				if (!entry.plane.isEnabled() && (oldest === null || entry.usedAt < live.get(oldest).usedAt)) oldest = index;
			}
			if (oldest === null) return;
			live.get(oldest).plane.dispose(false, true);
			live.delete(oldest);
		}
	}

	/** Exactly these notes carry a title; everything else loses its. */
	function show(indexes) {
		for (const [index, entry] of live) if (!indexes.has(index)) entry.plane.setEnabled(false);
		for (const index of indexes) ensure(index).plane.setEnabled(true);
		evict();
	}

	return { show, dispose: () => live.forEach((entry) => entry.plane.dispose(false, true)) };
}
