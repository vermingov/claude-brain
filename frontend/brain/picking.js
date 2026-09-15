// What is under the pointer. Every cell is a camera-facing disc, so this projects the
// centres to the screen and asks which disc the pointer is inside — a thousand
// multiply-adds, no ray, no triangle test.
//
// Two rules make it agree with what the eye sees. A disc that actually covers the pointer
// beats one that merely passes near it, and among discs that cover it the nearest to the
// camera wins, because that is the one drawn in front. Without the second rule a distant
// speck whose centre happens to sit a pixel closer steals the click from the cell you
// were pointing at.

/** How far outside a small disc the pointer may still count, so specks stay clickable. */
const SLACK_PX = 7;

export function createPicker(scene, engine, camera, graph, radii, isVisible) {
	const { nodes } = graph;

	/** @param {number} pointerX @param {number} pointerY  CSS pixels, as the pointer reports them. */
	function pick(pointerX, pointerY) {
		const m = scene.getTransformMatrix().m;
		// m[5] is the vertical focal length: a view-space size times this, over depth, is
		// the size in clip space.
		const focal = camera.getProjectionMatrix().m[5];
		// The drawing buffer is not the element: on a high-density display it is larger by
		// the hardware scaling factor, and the pointer speaks in CSS pixels.
		const scaling = engine.getHardwareScalingLevel();
		const width = engine.getRenderWidth() * scaling;
		const height = engine.getRenderHeight() * scaling;

		let covered = -1;
		let coveredDepth = Number.POSITIVE_INFINITY;
		let nearest = -1;
		let nearestDistance = Number.POSITIVE_INFINITY;

		for (let i = 0; i < nodes.length; i++) {
			if (!isVisible(i)) continue;
			const node = nodes[i];
			const depth = node.x * m[3] + node.y * m[7] + node.z * m[11] + m[15];
			if (depth <= 0) continue;
			const screenX = ((node.x * m[0] + node.y * m[4] + node.z * m[8] + m[12]) / depth + 1) * 0.5 * width;
			const screenY = (1 - (node.x * m[1] + node.y * m[5] + node.z * m[9] + m[13]) / depth) * 0.5 * height;
			const distance = Math.hypot(screenX - pointerX, screenY - pointerY);
			const radius = (radii[i] * focal * height) / (2 * depth);
			if (distance <= radius) {
				if (depth < coveredDepth) {
					coveredDepth = depth;
					covered = i;
				}
			} else if (covered === -1 && distance <= radius + SLACK_PX && distance < nearestDistance) {
				nearestDistance = distance;
				nearest = i;
			}
		}
		return covered !== -1 ? covered : nearest;
	}

	return { pick };
}
