// A neuron field as actual geometry. Worked out in the neuron lab; this is that geometry.
//
// The billboard version drew the arbor inside a camera-facing quad, which meant the cell's
// own axes were the screen's axes: orbit the camera and every process swung round with it.
// That is the spasm. A process has to point somewhere in the world and stay pointing there,
// which means real vertices.
//
// And a process has somewhere to point. Every edge in the graph is grown as a tube running
// from one soma to the other, so the arbor is not decoration around a node — it is the
// wiring. A cell with nine links visibly has nine processes leaving it, each one arriving
// somewhere. What used to be a straight line between two dots is now the thing the cells
// are made of.

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** Vertices around each tube. Five reads as round once there is lighting on it. */
const RING = 5;
/** Samples along a connection. Enough for the bow in it to look drawn rather than folded. */
const SAMPLES = 7;
/** Somas sit at along = 0; nothing on a process is allowed below this, so the two never mix. */
const PROCESS_FLOOR = 0.14;

export function emptyField() {
	// `cell` is whichever soma a vertex belongs to, for colour and for the flash when that
	// note fires. `source`, `target` and `run` describe the connection: the cells at each
	// end, and how far along this vertex sits, measured from the source.
	//
	// Both ends, not one. A link is not directed — either note can be the one recalled — and
	// carrying only one of them meant a connection could only ever show a signal leaving the
	// cell that happened to be written first when the edge was built. Fire the other end and
	// the line stayed dark or showed a stale run.
	return { positions: [], normals: [], indices: [], along: [], cell: [], source: [], target: [], run: [] };
}

function perpendicular(axis) {
	const seed = Math.abs(axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
	return Vector3.Cross(axis, seed).normalize();
}

/**
 * A ring of vertices around `point`, facing along `heading`.
 * @returns {number} the index of the first vertex in the ring
 */
function ring(mesh, point, heading, radius, along, cell, source, target, run) {
	const start = mesh.positions.length / 3;
	const side = perpendicular(heading);
	const up = Vector3.Cross(heading, side).normalize();
	for (let k = 0; k < RING; k++) {
		const angle = (k / RING) * Math.PI * 2;
		const offset = side.scale(Math.cos(angle) * radius).add(up.scale(Math.sin(angle) * radius));
		const position = point.add(offset);
		mesh.positions.push(position.x, position.y, position.z);
		const normal = offset.normalize();
		mesh.normals.push(normal.x, normal.y, normal.z);
		mesh.along.push(along);
		mesh.cell.push(cell);
		mesh.source.push(source);
		mesh.target.push(target);
		mesh.run.push(run);
	}
	return start;
}

function bridge(mesh, a, b) {
	for (let k = 0; k < RING; k++) {
		const p = a + k;
		const q = a + ((k + 1) % RING);
		const r = b + k;
		const s = b + ((k + 1) % RING);
		mesh.indices.push(p, r, q, q, r, s);
	}
}

/**
 * One connection, as a tube bowed between two somas.
 *
 * Thick where it leaves each cell and finest in the middle, which is what a process looks
 * like and also what keeps a dense graph from turning into a bundle of dowels. The bow is
 * deterministic per edge, so the picture is the same every time it is built.
 */
export function growConnection(mesh, from, to, options) {
	const { radius = 0.9, bow = 0.12, cellA = 0, cellB = 0, jitter = 0 } = options ?? {};
	const axis = to.subtract(from);
	const span = axis.length();
	if (span < 1e-3) return;
	const heading = axis.scale(1 / span);
	// Bow the tube sideways, so two cells are joined by a process rather than a strut.
	const sideways = perpendicular(heading)
		.scale(Math.cos(jitter))
		.add(Vector3.Cross(heading, perpendicular(heading)).scale(Math.sin(jitter)))
		.normalize()
		.scale(span * bow);

	let previous = -1;
	for (let s = 0; s < SAMPLES; s++) {
		const t = s / (SAMPLES - 1);
		const curve = Math.sin(t * Math.PI);
		const point = from.add(axis.scale(t)).add(sideways.scale(curve));
		// Thickest at the ends where it meets a cell, finest in the middle of the run.
		const thickness = radius * (1 - 0.62 * curve);
		// Direction of travel, for the ring's plane.
		const next = t < 1 ? from.add(axis.scale(Math.min(t + 0.08, 1))).add(sideways.scale(Math.sin(Math.min(t + 0.08, 1) * Math.PI))) : point;
		const step = t < 1 ? next.subtract(point) : heading;
		const direction = step.length() > 1e-4 ? step.normalize() : heading;
		// Along runs 0 at one cell to 1 at the other and back, so beads march out from both
		// ends and the nucleus glow stays where the somas are.
		const along = PROCESS_FLOOR + (1 - PROCESS_FLOOR) * curve;
		const current = ring(mesh, point, direction, thickness, along, t < 0.5 ? cellA : cellB, cellA, cellB, t);
		if (previous >= 0) bridge(mesh, previous, current);
		previous = current;
	}
}

/** The soma: a sphere, lumpy enough not to look machined. */
export function growSoma(mesh, centre, radius, cell, wobble) {
	const rows = 7;
	const columns = 10;
	const start = mesh.positions.length / 3;
	for (let i = 0; i <= rows; i++) {
		const phi = (i / rows) * Math.PI;
		for (let j = 0; j <= columns; j++) {
			const theta = (j / columns) * Math.PI * 2;
			const direction = new Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
			const lumpy = radius * (0.9 + 0.1 * Math.sin(phi * 3 + theta * 2 + wobble));
			const position = direction.scale(lumpy).add(centre);
			mesh.positions.push(position.x, position.y, position.z);
			mesh.normals.push(direction.x, direction.y, direction.z);
			mesh.along.push(0);
			mesh.cell.push(cell);
			mesh.source.push(cell);
			mesh.target.push(cell);
			mesh.run.push(0);
		}
	}
	for (let i = 0; i < rows; i++) {
		for (let j = 0; j < columns; j++) {
			const a = start + i * (columns + 1) + j;
			const b = a + columns + 1;
			mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
}

/**
 * A short process that goes nowhere: what a cell with one link or none still grows, so it
 * is a neuron rather than a bead on a string.
 */
export function growStub(mesh, centre, direction, length, radius, cell) {
	const tip = centre.add(direction.scale(length));
	growConnection(mesh, centre, tip, { radius, bow: 0.06, cellA: cell, cellB: cell, jitter: 0 });
}
