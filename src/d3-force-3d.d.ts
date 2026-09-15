// d3-force-3d ships no types. This is the slice of its API the layout uses, typed the way
// the code calls it; anything else it offers stays undeclared on purpose.

declare module "d3-force-3d" {
	export interface SimulationNode {
		id: number;
		x?: number;
		y?: number;
		z?: number;
		vx?: number;
		vy?: number;
		vz?: number;
	}

	export interface SimulationLink<N> {
		source: N;
		target: N;
		kind: string;
	}

	export interface Force {
		(alpha: number): void;
	}

	export interface LinkForce<N extends SimulationNode> extends Force {
		id(accessor: (node: N) => number): this;
		distance(accessor: (link: SimulationLink<N>) => number): this;
		strength(accessor: (link: SimulationLink<N>) => number): this;
	}

	export interface ManyBodyForce extends Force {
		strength(value: number): this;
		theta(value: number): this;
	}

	export interface Simulation<N extends SimulationNode> {
		force(name: string, force: Force | null): this;
		alpha(value: number): this;
		stop(): this;
		tick(): this;
	}

	export function forceSimulation<N extends SimulationNode>(nodes: N[], dimensions?: number): Simulation<N>;
	export function forceLink<N extends SimulationNode>(links: Array<{ source: number; target: number; kind: string }>): LinkForce<N>;
	export function forceManyBody(): ManyBodyForce;
}
