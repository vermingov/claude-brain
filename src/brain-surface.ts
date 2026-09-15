// A procedural brain: two hemispheres split by the longitudinal fissure, folded into gyri,
// with the cerebellum tucked under the back and a brainstem below. Expressed as a scalar
// field that is zero on the surface, negative inside, in layout units, so the layout can
// hold every note on the cortex by walking down the field's gradient.

import type { Point } from "./graph-layout";

export interface BrainShape {
	/** Semi-axes of the cerebrum: width, height, length (front-to-back). */
	ax: number;
	ay: number;
	az: number;
}

const EPSILON = 0.5;
const FISSURE_WIDTH = 0.09;
const FISSURE_DEPTH = 0.14;
const GYRI_DEPTH = 0.05;
const CEREBELLUM = { x: 0, y: -0.55, z: -0.55, rx: 0.5, ry: 0.3, rz: 0.38 };
const STEM = { top: { x: 0, y: -0.45, z: -0.25 }, bottom: { x: 0, y: -1.15, z: -0.35 }, radius: 0.15 };

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, v: number): number {
	const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum: a soft union of two fields. */
function smin(a: number, b: number, k: number): number {
	const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
	return b + (a - b) * h - k * h * (1 - h);
}

function capsule(p: Point, a: Point, b: Point, radius: number): number {
	const pax = p.x - a.x;
	const pay = p.y - a.y;
	const paz = p.z - a.z;
	const bax = b.x - a.x;
	const bay = b.y - a.y;
	const baz = b.z - a.z;
	const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
	return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - radius;
}

/** Zero on the brain's surface, negative inside; roughly a distance, in layout units. */
export function brainField(p: Point, shape: BrainShape): number {
	const { ax, ay, az } = shape;
	const radius = (ax + ay + az) / 3;
	const nx = p.x / ax;
	const ny = p.y / ay;
	const nz = p.z / az;
	const rho = Math.hypot(nx, ny, nz) || 1e-6;
	let cerebrum = (rho - 1) * radius;
	// The fissure: a groove along the midline, deepest on top, fading out underneath.
	cerebrum += FISSURE_DEPTH * radius * Math.exp(-((nx / FISSURE_WIDTH) ** 2)) * smoothstep(-0.25, 0.3, ny);
	// Gyri: two interfering waves over the upper cortex, quiet on the underside.
	const theta = Math.atan2(nz, nx);
	const phi = Math.asin(clamp(ny / rho, -1, 1));
	const folds = Math.sin(7 * theta + 2 * Math.sin(3 * phi)) * Math.cos(5 * phi + Math.sin(4 * theta));
	cerebrum += GYRI_DEPTH * radius * folds * smoothstep(-0.6, -0.15, ny);

	const cx = (p.x - CEREBELLUM.x * ax) / (CEREBELLUM.rx * ax);
	const cy = (p.y - CEREBELLUM.y * ay) / (CEREBELLUM.ry * ay);
	const cz = (p.z - CEREBELLUM.z * az) / (CEREBELLUM.rz * az);
	// Finer, horizontal folia on the cerebellum.
	const cerebellum = (Math.hypot(cx, cy, cz) - 1) * radius * 0.4 + 0.03 * radius * Math.sin(18 * cy);

	const stem = capsule(
		p,
		{ x: STEM.top.x * ax, y: STEM.top.y * ay, z: STEM.top.z * az },
		{ x: STEM.bottom.x * ax, y: STEM.bottom.y * ay, z: STEM.bottom.z * az },
		STEM.radius * ax,
	);
	return smin(smin(cerebrum, cerebellum, 0.15 * radius), stem, 0.1 * radius);
}

/** Field value and unit gradient at `p`, by central differences. */
export function brainGradient(p: Point, shape: BrainShape): { value: number; normal: Point } {
	const value = brainField(p, shape);
	const gx = brainField({ x: p.x + EPSILON, y: p.y, z: p.z }, shape) - brainField({ x: p.x - EPSILON, y: p.y, z: p.z }, shape);
	const gy = brainField({ x: p.x, y: p.y + EPSILON, z: p.z }, shape) - brainField({ x: p.x, y: p.y - EPSILON, z: p.z }, shape);
	const gz = brainField({ x: p.x, y: p.y, z: p.z + EPSILON }, shape) - brainField({ x: p.x, y: p.y, z: p.z - EPSILON }, shape);
	const length = Math.hypot(gx, gy, gz) || 1e-6;
	return { value, normal: { x: gx / length, y: gy / length, z: gz / length } };
}

/** Walk `p` onto the surface: a few Newton steps down the gradient. */
export function projectToSurface(p: Point, shape: BrainShape, steps = 6): Point {
	const out = { ...p };
	for (let i = 0; i < steps; i++) {
		const { value, normal } = brainGradient(out, shape);
		if (Math.abs(value) < 0.05) break;
		out.x -= normal.x * value;
		out.y -= normal.y * value;
		out.z -= normal.z * value;
	}
	return out;
}

/**
 * Where a lobe's notes gather: anatomical regions, one per hemisphere, handed out to the
 * largest lobes first so the biggest folders take the frontal and parietal cortex and the
 * small ones settle into what is left. Points are in normalised cerebrum coordinates
 * before the hemisphere sign is applied to x.
 */
const REGIONS: Array<[number, number, number]> = [
	[0.35, 0.45, 0.72], // frontal
	[0.4, 0.85, -0.1], // parietal
	[0.95, -0.05, 0.15], // temporal
	[0.35, 0.35, -0.9], // occipital
	[0.3, 0.1, 0.95], // prefrontal
	[0.55, 0.9, 0.3], // motor strip
	[0.35, -0.6, -0.65], // cerebellum
];

export function regionAnchor(rank: number, shape: BrainShape): Point {
	const region = REGIONS[Math.floor(rank / 2) % REGIONS.length]!;
	const side = rank % 2 === 0 ? 1 : -1;
	// Past the named regions, later lobes spiral around the cortex so none share a point.
	const turn = Math.floor(rank / (REGIONS.length * 2)) * 0.9;
	const raw = {
		x: side * region[0] * shape.ax * Math.cos(turn) - region[2] * shape.az * Math.sin(turn) * 0.3,
		y: region[1] * shape.ay,
		z: region[2] * shape.az * Math.cos(turn) + side * region[0] * shape.ax * Math.sin(turn) * 0.3,
	};
	return projectToSurface(raw, shape, 10);
}
