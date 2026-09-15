// Hub labels: a text plane for the most connected notes only. Each is its own mesh and
// texture, so the count is capped — past a few dozen they are draw calls that overlap
// into noise anyway.

import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

const MAX_LABELS = 60;
const MIN_CONNECTIONS = 7;
const FONT_PX = 44;
const PAD = 18;
const SCALE = 0.11;

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function makeLabel(scene, node, colorHex, radius) {
	const text = truncate(node.title, 34);
	const measure = new DynamicTexture("measure", { width: 2, height: 2 }, scene, false);
	const mctx = measure.getContext();
	mctx.font = `500 ${FONT_PX}px system-ui, sans-serif`;
	const width = Math.ceil(mctx.measureText(text).width) + PAD * 2;
	measure.dispose();
	const height = FONT_PX + PAD * 2;
	const texture = new DynamicTexture(`label:${node.id}`, { width, height }, scene, true);
	texture.hasAlpha = true;
	const ctx = texture.getContext();
	ctx.font = `500 ${FONT_PX}px system-ui, sans-serif`;
	ctx.textBaseline = "middle";
	ctx.textAlign = "center";
	ctx.shadowColor = colorHex;
	ctx.shadowBlur = 18;
	ctx.fillStyle = "rgba(232,236,248,0.92)";
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
	plane.position.set(node.x, node.y - (radius + 7), node.z);
	return plane;
}

/** @returns Map of node index → label plane, for the top hubs. */
export function createLabels(scene, graph, radii, colorOf) {
	const hubs = graph.nodes
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => node.connections >= MIN_CONNECTIONS)
		.sort((a, b) => b.node.connections - a.node.connections)
		.slice(0, MAX_LABELS);
	const planes = new Map(hubs.map(({ node, index }) => [index, makeLabel(scene, node, colorOf(node), radii[index])]));

	/** @param {(index: number) => "hidden"|"dim"|"normal"|"hi"} stateOf */
	function restyle(stateOf) {
		for (const [index, plane] of planes) {
			const state = stateOf(index);
			plane.setEnabled(state !== "hidden");
			plane.visibility = state === "dim" ? 0.1 : state === "hi" ? 1 : 0.85;
		}
	}

	return { restyle, dispose: () => planes.forEach((p) => p.dispose(false, true)) };
}
