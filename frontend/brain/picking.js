// Hover and click resolve to a node by projecting every node to the screen and taking
// the nearest one under the pointer. Twelve hundred multiply-adds per pick, no ray, no
// triangle test — the old ray pick walked every triangle of every sphere.

const MIN_PICK_PX = 7;

export function createPicker(scene, engine, camera, graph, radii, isVisible) {
	const { nodes } = graph;

	/** @returns {number} node index, or -1 */
	function pick(pointerX, pointerY) {
		const m = scene.getTransformMatrix().m;
		const focal = camera.getProjectionMatrix().m[5];
		const width = engine.getRenderWidth();
		const height = engine.getRenderHeight();
		let best = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let i = 0; i < nodes.length; i++) {
			if (!isVisible(i)) continue;
			const n = nodes[i];
			const w = n.x * m[3] + n.y * m[7] + n.z * m[11] + m[15];
			if (w <= 0) continue;
			const sx = ((n.x * m[0] + n.y * m[4] + n.z * m[8] + m[12]) / w + 1) * 0.5 * width;
			const sy = (1 - (n.x * m[1] + n.y * m[5] + n.z * m[9] + m[13]) / w) * 0.5 * height;
			const dx = sx - pointerX;
			const dy = sy - pointerY;
			const distance = Math.hypot(dx, dy);
			const reach = Math.max(MIN_PICK_PX, (radii[i] * focal * height) / (2 * w));
			// Nearer to the camera wins a tie, the way it would if the discs occluded.
			const score = distance > reach ? Number.POSITIVE_INFINITY : distance + w * 1e-6;
			if (score < bestDistance) {
				bestDistance = score;
				best = i;
			}
		}
		return best;
	}

	return { pick };
}
