// Where the layout lives: one row per note in doc_layout, computed by the worker and
// refreshed whenever the graph changes. Warm starts keep the picture stable from one
// save to the next, so the brain looks the same each time it is opened and a new note
// appears beside its lobe instead of the whole vault reshuffling.

import { type LayoutEdge, type LayoutNode, lobeOf, ROOT_CATEGORY } from "./graph-layout";
import { openBrainDb } from "./index-db";
import type { LayoutJob } from "./layout-worker";

const RELAYOUT_DEBOUNCE_MS = 4_000;

let running: Promise<number> | null = null;
let queued = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function loadJob(): LayoutJob {
	const { db } = openBrainDb();
	const rows = db
		.query(
			`SELECT d.id, d.path, l.x, l.y, l.z FROM docs d
			 LEFT JOIN doc_layout l ON l.doc_id = d.id ORDER BY d.id`,
		)
		.all() as Array<{ id: number; path: string; x: number | null; y: number | null; z: number | null }>;
	const edges: LayoutEdge[] = [
		...(db.query("SELECT source_doc AS source, target_doc AS target, 'wikilink' AS kind FROM links").all() as LayoutEdge[]),
		...(db.query("SELECT source_doc AS source, target_doc AS target, kind FROM derived_links").all() as LayoutEdge[]),
	];
	const connections = new Map<number, number>();
	for (const e of edges) {
		connections.set(e.source, (connections.get(e.source) ?? 0) + 1);
		connections.set(e.target, (connections.get(e.target) ?? 0) + 1);
	}
	const nodes: LayoutNode[] = rows.map((r) => ({
		id: r.id,
		category: lobeOf(r.path),
		connections: connections.get(r.id) ?? 0,
		...(r.x === null || r.y === null || r.z === null ? {} : { x: r.x, y: r.y, z: r.z }),
	}));
	// Same order the graph payload uses, so lobes get the same anchors both places.
	const categories = [...new Set(nodes.map((n) => n.category))].sort((a, b) =>
		a === ROOT_CATEGORY ? -1 : b === ROOT_CATEGORY ? 1 : a.localeCompare(b),
	);
	return { nodes, edges, categories };
}

function runWorker(job: LayoutJob): Promise<Float64Array> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./layout-worker.ts", import.meta.url));
		worker.onmessage = (event: MessageEvent<Float64Array>) => {
			worker.terminate();
			resolve(event.data);
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(`layout worker: ${event.message}`));
		};
		worker.postMessage(job);
	});
}

function store(flat: Float64Array): number {
	const { db } = openBrainDb();
	const upsert = db.query(
		`INSERT INTO doc_layout (doc_id, x, y, z) VALUES (?, ?, ?, ?)
		 ON CONFLICT(doc_id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z`,
	);
	db.transaction(() => {
		for (let i = 0; i < flat.length; i += 4) upsert.run(flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!);
	})();
	return flat.length / 4;
}

/** True when every note has a position — the common case, answered without a worker. */
export function layoutComplete(): boolean {
	const { db } = openBrainDb();
	const missing = db
		.query("SELECT count(*) AS n FROM docs d WHERE NOT EXISTS (SELECT 1 FROM doc_layout l WHERE l.doc_id = d.id)")
		.get() as { n: number };
	return missing.n === 0;
}

/**
 * Lay the vault out now, once. Concurrent callers share the run; a change that arrives
 * mid-run queues exactly one more, so the stored layout always reflects the last edit.
 */
export function relayout(): Promise<number> {
	if (running) {
		queued = true;
		return running;
	}
	running = runWorker(loadJob())
		.then(store)
		.finally(() => {
			running = null;
			if (queued) {
				queued = false;
				void relayout();
			}
		});
	return running;
}

/** A layout for every note, running one only when some note lacks a position. */
export function ensureLayout(): Promise<number> {
	if (running) return running;
	if (layoutComplete()) return Promise.resolve(0);
	return relayout();
}

/** Coalesce the bursts a save produces — index, embed, graph — into one warm layout. */
export function scheduleLayout(): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		relayout().catch((err) => console.warn(`[layout] ${err}`));
	}, RELAYOUT_DEBOUNCE_MS);
	timer.unref?.();
}
