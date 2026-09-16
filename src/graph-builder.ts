// The vault as a graph for the 3D view, straight from the index: one node per note,
// every edge kind the recall graph knows, the community each note settled into, and
// the position the layout worker gave it. Nothing here touches the vault on disk except
// reading the one note a viewer opened — the previous builder re-read every note on each
// request, twelve hundred file reads per page load, to send a payload that was two thirds
// excerpt text the page never showed.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { baseActivation } from "./activation";
import { stripFrontmatter } from "./chunker";
import { vaultRoot } from "./config";
import { lobeOf, ROOT_CATEGORY } from "./graph-layout";
import { openBrainDb } from "./index-db";

export interface GraphNode {
	/** Vault-relative path. */
	id: string;
	title: string;
	category: string;
	tags: string[];
	date: string | null;
	connections: number;
	community: number | null;
	/** How alive the note is in memory right now, 0..1: recent, repeated recall runs hot. */
	activation: number;
	/** When the note came into the vault, for replaying how the brain was built. */
	created: number;
	x: number;
	y: number;
	z: number;
}

export type EdgeKind = "wikilink" | "semantic" | "tag" | "cooccur" | "timeline";

/** Endpoints are indexes into `nodes`: a path per edge would be most of the payload. */
export interface GraphEdge {
	source: number;
	target: number;
	kind: EdgeKind;
}

export interface CategoryInfo {
	id: string;
	label: string;
	color: string;
}

export interface CommunityInfo {
	id: number;
	label: string;
	size: number;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	categories: CategoryInfo[];
	communities: CommunityInfo[];
	scannedAt: string;
	vaultRoot: string;
}

const PALETTE = [
	"#38bdf8",
	"#fbbf24",
	"#a78bfa",
	"#34d399",
	"#f472b6",
	"#fb923c",
	"#a3e635",
	"#f87171",
	"#22d3ee",
	"#e879f9",
	"#facc15",
	"#4ade80",
];

const DATE_IN_FILENAME_RE = /(\d{4}-\d{2}-\d{2})/;

function labelFor(category: string): string {
	return category === ROOT_CATEGORY ? "Root" : category;
}

interface DocRow {
	id: number;
	path: string;
	title: string;
	x: number | null;
	y: number | null;
	z: number | null;
	community: number | null;
	access_count: number;
	last_access: number;
	mtime: number;
}

const DOC_COLUMNS = `d.id, d.path, d.title, l.x, l.y, l.z, c.community, d.access_count, d.last_access, d.mtime
	FROM docs d
	LEFT JOIN doc_layout l ON l.doc_id = d.id
	LEFT JOIN communities c ON c.doc_id = d.id`;

function loadTags(): Map<number, string[]> {
	const { db } = openBrainDb();
	const tags = new Map<number, string[]>();
	for (const row of db.query("SELECT doc_id, tag FROM doc_tags ORDER BY tag").all() as Array<{ doc_id: number; tag: string }>) {
		const list = tags.get(row.doc_id) ?? [];
		list.push(row.tag);
		tags.set(row.doc_id, list);
	}
	return tags;
}

function loadEdges(): Array<{ source: number; target: number; kind: EdgeKind }> {
	const { db } = openBrainDb();
	return [
		...(db.query("SELECT source_doc AS source, target_doc AS target, 'wikilink' AS kind FROM links").all() as Array<{
			source: number;
			target: number;
			kind: EdgeKind;
		}>),
		...(db.query("SELECT source_doc AS source, target_doc AS target, kind FROM derived_links").all() as Array<{
			source: number;
			target: number;
			kind: EdgeKind;
		}>),
	];
}

/** ACT-R base-level activation squashed to 0..1; a never-recalled note sits near 0.15. */
function activationOf(row: DocRow, now: number): number {
	if (row.access_count === 0) return 0;
	const level = baseActivation({ accessCount: row.access_count, lastAccess: row.last_access, created: row.mtime }, now);
	return Number(Math.max(0, Math.tanh(level / 2.5)).toFixed(3));
}

function nodeOf(row: DocRow, tags: string[], connections: number, now = Date.now()): GraphNode {
	return {
		id: row.path,
		title: row.title,
		category: lobeOf(row.path),
		tags,
		date: basename(row.path).match(DATE_IN_FILENAME_RE)?.[1] ?? null,
		connections,
		community: row.community,
		activation: activationOf(row, now),
		// When this note came into the vault, for replaying how the brain was built.
		created: row.mtime,
		x: row.x ?? 0,
		y: row.y ?? 0,
		z: row.z ?? 0,
	};
}

export function buildGraph(): GraphData {
	const { db } = openBrainDb();
	const docs = db.query(`SELECT ${DOC_COLUMNS} ORDER BY d.path`).all() as DocRow[];
	const indexOf = new Map(docs.map((d, i) => [d.id, i]));
	const edges: GraphEdge[] = [];
	const connections = new Array<number>(docs.length).fill(0);
	for (const e of loadEdges()) {
		const source = indexOf.get(e.source);
		const target = indexOf.get(e.target);
		if (source === undefined || target === undefined) continue;
		edges.push({ source, target, kind: e.kind });
		connections[source]!++;
		connections[target]!++;
	}
	const tags = loadTags();
	const now = Date.now();
	const nodes = docs.map((d, i) => nodeOf(d, tags.get(d.id) ?? [], connections[i]!, now));

	// Stable category order: root first, then folders alphabetically — the same order
	// the layout uses for its anchors.
	const categoryIds = [...new Set(nodes.map((n) => n.category))].sort((a, b) =>
		a === ROOT_CATEGORY ? -1 : b === ROOT_CATEGORY ? 1 : a.localeCompare(b),
	);
	const categories = categoryIds.map((id, i) => ({ id, label: labelFor(id), color: PALETTE[i % PALETTE.length]! }));
	const communities = db
		.query("SELECT community AS id, label, size FROM community_labels ORDER BY size DESC")
		.all() as CommunityInfo[];

	return { nodes, edges, categories, communities, scannedAt: new Date().toISOString(), vaultRoot: vaultRoot() ?? "" };
}

export interface NoteDetail {
	node: GraphNode;
	content: string;
	/** Paths of every note linked to this one, in either direction, by any edge kind. */
	backlinks: string[];
}

/** One note for the reader panel: its row, its text, and what it is connected to. */
export function noteDetail(path: string, root = vaultRoot()): NoteDetail | null {
	if (!root) return null;
	const { db } = openBrainDb();
	const row = db.query(`SELECT ${DOC_COLUMNS} WHERE d.path = ?`).get(path) as DocRow | null;
	if (!row) return null;
	let raw: string;
	try {
		raw = readFileSync(join(root, path), "utf-8");
	} catch {
		return null;
	}
	const other = (table: string) =>
		`SELECT d.path FROM ${table} k
		 JOIN docs d ON d.id = CASE WHEN k.source_doc = ? THEN k.target_doc ELSE k.source_doc END
		 WHERE k.source_doc = ? OR k.target_doc = ?`;
	const backlinks = (
		db.query(`${other("links")} UNION ${other("derived_links")}`).all(row.id, row.id, row.id, row.id, row.id, row.id) as Array<{
			path: string;
		}>
	).map((r) => r.path);
	const tags = (db.query("SELECT tag FROM doc_tags WHERE doc_id = ? ORDER BY tag").all(row.id) as Array<{ tag: string }>).map(
		(t) => t.tag,
	);
	return { node: nodeOf(row, tags, backlinks.length), content: stripFrontmatter(raw).trim(), backlinks };
}

/** Resolve a `[[link]]` target against the set of known note basenames. */
export function resolveLink(target: string, byBasename: Map<string, string[]>, fromId: string): string | null {
	const cleaned = target.split("|")[0]!.split("#")[0]!.trim();
	if (!cleaned) return null;
	const key = basename(cleaned).replace(/\.md$/i, "").toLowerCase();
	const candidates = byBasename.get(key);
	if (!candidates || candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0]!;
	// Prefer a candidate sharing the linking note's top-level folder, else the shortest path.
	const fromTop = fromId.split("/")[0];
	const sameFolder = candidates.find((c) => c.split("/")[0] === fromTop);
	if (sameFolder) return sameFolder;
	return [...candidates].sort((a, b) => a.length - b.length)[0]!;
}
