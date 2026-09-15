// Retrieval across both memory systems. Lexical (FTS5 BM25) and semantic (vector)
// rankings are fused with reciprocal-rank fusion, then reweighted by how strong each
// trace is (activation.ts), by where it was useful before (recalls), extended along
// associations (spreading.ts), collapsed to one hit per piece of knowledge, and finally
// strengthened by the act of being recalled.
//
// Ordering matters: relevance decides the candidate set, memory strength only reorders
// within it. A brain that let recency outvote meaning would answer every question with
// whatever it saw last.

import { activationBoost, strengthen } from "./activation";
import { embedQuery } from "./embedder";
import { emit, type Via } from "./events";
import { EDGE_WEIGHT } from "./graph";
import { EMBED_DIM, openBrainDb } from "./index-db";
import { focusSnippet } from "./snippet";
import { spreadActivation } from "./spreading";
import { correctTerms, termFrequency } from "./vocab";

export interface RecallHit {
	kind: "note" | "episode";
	/** Vault-relative path for notes; `session/<id>` for episodes. */
	path: string;
	title: string;
	heading: string;
	score: number;
	snippet: string;
	/** Epoch ms of the remembered event — episodes only. */
	when?: number;
	/** Title of the note this one was reached through, when it arrived by association. */
	via?: string;
	/** Already surfaced earlier in this session — its text is still in context. */
	seen?: boolean;
	/** Other notes holding the same text, folded into this hit. */
	copies?: number;
	/** When and where an earlier session last retrieved this note. */
	lastUsed?: { ts: number; cwd: string };
	/** The cue actually searched, when a misspelt term was snapped to the vault's vocabulary. */
	corrected?: string;
	/** Neither arm was sure: the notes here are the ranker's least-bad guesses. */
	weak?: boolean;
	/** Words in the cue that appear in no note at all. Their absence is the tell. */
	unknown?: string[];
}

export interface RecallOptions {
	k?: number;
	/** How many episodic traces may accompany the notes. */
	episodeK?: number;
	pathPrefix?: string;
	/** Live session id — enables working-memory priming and is required for priming to persist. */
	sessionId?: string;
	/** Where the caller is working. Notes that helped here before rank a little higher. */
	cwd?: string;
	/**
	 * Drop episodes from this session. What just happened is still in the context
	 * window; replaying it back as "memory" is an echo, not a recollection.
	 */
	excludeSessionId?: string;
	/** Set false for background/UI queries that shouldn't count as retrievals. */
	reinforce?: boolean;
	/** Return whole matching sections instead of just the answering lines. */
	full?: boolean;
	/** Who is asking, for the live activity stream. */
	via?: Via;
}

interface Candidate {
	chunkId: number;
	docId: number;
	path: string;
	title: string;
	heading: string;
	text: string;
	hash: string;
	score: number;
	via?: string;
	copies?: number;
}

interface EpisodeCandidate {
	id: number;
	sessionId: string;
	kind: string;
	ts: number;
	text: string;
	salience: number;
	score: number;
}

const RRF_K = 60;
const CANDIDATES = 30;
/**
 * Snippet budget. The old 700 was "however much of the chunk fits"; with focused
 * extraction the same answer arrives in a third of the space, so the budget buys
 * relevance instead of padding. `full` restores whole-chunk output for the rare case
 * where the surrounding section matters.
 */
const SNIPPET_CHARS = 280;
const FULL_SNIPPET_CHARS = 900;
/**
 * A note that documents a problem is written Symptom -> Root cause -> Fix, and a question
 * is asked in symptom language, so the symptom chunk always outranks the fix chunk — then
 * poolByDoc keeps the winner and discards the sibling holding the answer. Measured on a
 * labelled set: the gold note was retrieved 10/10 times and the fix reached the caller
 * 1/10. So the budget is split rather than spent entirely on the best-matching chunk.
 */
const SOLUTION_CHARS = 180;
const SOLUTION_HEADING = /^##+[ \t]*(fix|solution|resolution|workaround)\b[^\n]*$/im;

/** An episode is a reminder, not a document — it never needs a note-sized excerpt. */
const EPISODE_SNIPPET_CHARS = 200;
/** Episodes are raw and repetitive next to a curated note; they earn less trust. */
const EPISODE_WEIGHT = 0.8;

/**
 * Lexical cue budget. A pasted log is hundreds of distinct tokens; every one of them
 * becomes an OR branch, and FTS5 pays per branch. Measured: 316 unique terms cost 29 ms,
 * 24 cost 4 ms — and the same six words repeated sixty times, undeduplicated, cost 2.6 s.
 */
const MAX_TERMS = 32;
/** An all-terms match is only plausible for a short cue; above this the pass never hits
 *  and merely delays the OR fallback it always ends in. */
const AND_MAX_TERMS = 8;
/** Below this many lexical rows the cue is probably misspelt, and worth one correction. */
const LEXICAL_FLOOR = 3;
/** Two notes whose centroids sit this close are copies, not neighbours. */
const DUPLICATE_COSINE = 0.95;
/** Context-dependent memory: a note that helped in this directory before, in another session. */
const CONTEXT_BOOST = 1.04;
/** An episode from the day the cue names beats a better-worded one from the wrong month. */
const TEMPORAL_BOOST = 1.3;
/**
 * Below this the ranker is returning its least-bad option for a cue that names nothing
 * the vault knows. Measured: confident cues land 0.136–0.207, vague ones 0.088–0.107.
 * That band assumes the two arms disagree mildly; a cue that names a note's title hits
 * lexical rank 0 by a wide margin while the vector arm shrugs, and lands in it too — so
 * a confident lexical arm overrides the label (LEXICAL_MARGIN).
 */
export const WEAK_SCORE = 0.095;
/** BM25 lead of the top row over the runner-up that counts as the lexical arm being sure. */
const LEXICAL_MARGIN = 1.5;
/**
 * How much of a cue's meaning the vault can even represent, by rarity.
 *
 * A high score is not the same as an answer. "Helm chart values cluster" scored 0.145 on
 * a vault with no Kubernetes in it, higher than a genuinely covered question, because
 * three of its four words are this vault's own jargon — charts, values, clusters — and
 * only the rare one, the one that carried the actual subject, was missing. Scored by
 * inverse document frequency, that cue is mostly absent, and saying so is the difference
 * between a search engine and a brain that knows what it does not know.
 */
const MIN_COVERAGE = 0.7;
const MIN_COVERAGE_TERM = 3;

const STOPWORDS = new Set(
	("the a an and or of for to in on with is are was were be been it its this that then than how why what when " +
		"not no you your we our my i me use used using do does did dont doesnt cant wont can could would should will " +
		"just also from into out only about have has had").split(" "),
);

/** Distinct search terms of a cue, in order of first appearance, within the budget. */
export function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const term of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (term.length < 2 || term.length >= 40 || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}
	if (terms.length <= MAX_TERMS) return terms;
	// Over budget means a pasted log. The words that carry the ask are the content words;
	// function words and bare numbers go first, then the tail is cut.
	const content = terms.filter((term) => !STOPWORDS.has(term) && !/^\d+$/.test(term));
	return (content.length > 0 ? content : terms).slice(0, MAX_TERMS);
}

export interface Coverage {
	/** 0..1 of the cue's rarity-weighted words the vault has any note for. */
	covered: number;
	/** The words it has none for, rarest first. */
	unknown: string[];
}

/**
 * What share of a cue the vault could answer at all. Common words carry little weight —
 * every vault has "the" and most have "error" — so a missing rare word costs far more
 * than a missing common one.
 */
export function queryCoverage(terms: string[], corpusSize: number): Coverage {
	const content = terms.filter((term) => term.length >= MIN_COVERAGE_TERM && !STOPWORDS.has(term));
	if (content.length === 0) return { covered: 1, unknown: [] };
	let total = 0;
	let known = 0;
	const unknown: Array<{ term: string; weight: number }> = [];
	for (const term of content) {
		const frequency = termFrequency(term);
		// Rarity, bounded: an unknown word weighs as much as the rarest known one.
		const weight = Math.log1p(corpusSize / (1 + frequency));
		total += weight;
		if (frequency > 0) known += weight;
		else unknown.push({ term, weight });
	}
	unknown.sort((a, b) => b.weight - a.weight);
	return { covered: total === 0 ? 1 : known / total, unknown: unknown.map((u) => u.term) };
}

function ftsMatch(terms: string[], mode: "and" | "or"): string {
	return terms.map((term) => `"${term}"`).join(mode === "and" ? " " : " OR ");
}

function normalizePrefix(prefix: string): string {
	return prefix.replace(/^\/+|\/+$/g, "").toLowerCase();
}

/**
 * Folder scoping belongs in SQL, not after fusion. Both rankers return a global top-30,
 * so filtering the fused result means a scoped query over a large vault returns nothing
 * at all unless the folder also happens to win globally — it works on a toy vault and
 * silently dies on a real one.
 *
 * `path` is the docs column; LIKE is case-insensitive for ASCII, matching the old
 * lowercase comparison, and the prefix is escaped because a folder may legitimately
 * contain `_`.
 */
function likePrefix(prefix: string): string {
	return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface LexicalResult {
	ranks: Map<number, number>;
	/** The top row led the runner-up by LEXICAL_MARGIN — this arm knows what it found. */
	confident: boolean;
}

/** BM25 over one FTS table. Falls back from all-terms to any-term when too few match. */
function lexicalRanks(table: string, columnWeights: number[], terms: string[], pathPrefix?: string): LexicalResult {
	const ranks = new Map<number, number>();
	if (terms.length === 0) return { ranks, confident: false };
	const { db } = openBrainDb();
	const weights = columnWeights.join(", ");
	// Only chunks rows have a doc, and therefore a path, to scope by.
	const scoped = pathPrefix !== undefined && table === "chunks_fts";
	const sql = scoped
		? `SELECT f.rowid AS rowid, bm25(chunks_fts, ${weights}) AS s
			 FROM chunks_fts f
			 JOIN chunks c ON c.id = f.rowid
			 JOIN docs d ON d.id = c.doc_id
			 WHERE chunks_fts MATCH ? AND d.path LIKE ? ESCAPE '\\' ORDER BY s LIMIT ?`
		: `SELECT rowid, bm25(${table}, ${weights}) AS s
			 FROM ${table} WHERE ${table} MATCH ? ORDER BY s LIMIT ?`;
	const search = (match: string) => {
		if (!match) return [];
		try {
			const params = scoped ? [match, likePrefix(pathPrefix!), CANDIDATES] : [match, CANDIDATES];
			return db.query(sql).all(...params) as Array<{ rowid: number; s: number }>;
		} catch {
			return [];
		}
	};
	let rows = terms.length <= AND_MAX_TERMS ? search(ftsMatch(terms, "and")) : [];
	if (rows.length < 5) {
		const seen = new Set(rows.map((r) => r.rowid));
		rows = rows.concat(search(ftsMatch(terms, "or")).filter((r) => !seen.has(r.rowid)));
	}
	rows.slice(0, CANDIDATES).forEach((r, i) => ranks.set(r.rowid, i));
	// bm25() is negative, more negative is better; the ratio of magnitudes is the lead.
	const confident = rows.length >= 2 && Math.abs(rows[0]!.s) >= LEXICAL_MARGIN * Math.abs(rows[1]!.s);
	return { ranks, confident };
}

function vectorRanks(
	table: string,
	idColumn: string,
	vector: number[] | null,
	pathPrefix?: string,
): Map<number, number> {
	const { db, vectors } = openBrainDb();
	const ranks = new Map<number, number>();
	if (!vectors || !vector) return ranks;
	// vec0 KNN has no cheap pre-filter, so a scoped query over-fetches and drops the
	// chunks that fell outside the folder. The multiplier is what makes a small folder
	// in a large vault still fill a candidate list.
	const scoped = pathPrefix !== undefined && table === "vec_chunks";
	const rows = db
		.query(`SELECT ${idColumn} AS id FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
		.all(new Float32Array(vector), scoped ? CANDIDATES * 8 : CANDIDATES) as Array<{ id: number }>;

	let ids = rows.map((r) => r.id);
	if (scoped && ids.length > 0) {
		const inScope = new Set(
			(
				db
					.query(
						`SELECT c.id AS id FROM chunks c JOIN docs d ON d.id = c.doc_id
						 WHERE c.id IN (${ids.map(() => "?").join(",")}) AND d.path LIKE ? ESCAPE '\\'`,
					)
					.all(...ids, likePrefix(pathPrefix!)) as Array<{ id: number }>
			).map((r) => r.id),
		);
		ids = ids.filter((id) => inScope.has(id)).slice(0, CANDIDATES);
	}
	ids.forEach((id, i) => ranks.set(id, i));
	return ranks;
}

/** Reciprocal-rank fusion with a bonus for the very top of each list. */
function fuse(rankLists: Map<number, number>[]): Map<number, number> {
	const fused = new Map<number, number>();
	for (const ranks of rankLists) {
		for (const [id, rank] of ranks) {
			let score = 1 / (RRF_K + rank + 1);
			if (rank === 0) score += 0.05;
			else if (rank < 3) score += 0.02;
			fused.set(id, (fused.get(id) ?? 0) + score);
		}
	}
	return fused;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
	return dot;
}

// Working memory: a running trace of what this session has been asking about, blended
// into each new query so consecutive recalls stay on topic — the reason a follow-up
// question needs less context than the first one did. Persisted on the session row so a
// daemon restart mid-session doesn't lose the thread; cached here so the common case
// never reads it back.
const PRIMING_WEIGHT = 0.15;
/**
 * Below this the new query is about something else, and attention moves on: a topic
 * switch starts a fresh trace instead of being pulled toward the previous one.
 */
const TOPIC_SWITCH_COSINE = 0.25;
const MAX_PRIMED_SESSIONS = 64;
const primed = new Map<string, Float32Array>();

function loadContext(sessionId: string): Float32Array | null {
	const cached = primed.get(sessionId);
	if (cached) return cached;
	const { db } = openBrainDb();
	const row = db.query("SELECT context FROM sessions WHERE id = ?").get(sessionId) as { context: Uint8Array | null } | null;
	if (!row?.context || row.context.byteLength !== EMBED_DIM * 4) return null;
	const vec = new Float32Array(row.context.buffer.slice(row.context.byteOffset, row.context.byteOffset + row.context.byteLength));
	primed.set(sessionId, vec);
	return vec;
}

function saveContext(sessionId: string, trace: Float32Array): void {
	primed.set(sessionId, trace);
	if (primed.size > MAX_PRIMED_SESSIONS) primed.delete(primed.keys().next().value as string);
	const { db } = openBrainDb();
	// A bare CLI call has no session row; nothing to persist against, nothing lost.
	db.query("UPDATE sessions SET context = ? WHERE id = ?").run(new Uint8Array(trace.buffer), sessionId);
}

function primeQuery(sessionId: string | undefined, vector: number[] | null): number[] | null {
	if (!vector || !sessionId) return vector;
	const context = loadContext(sessionId);
	const continuing = context !== null && cosine(vector, context) >= TOPIC_SWITCH_COSINE;
	const next = continuing ? vector.map((v, i) => (1 - PRIMING_WEIGHT) * v + PRIMING_WEIGHT * context![i]!) : vector;
	// Keep the trace as a decaying average of the thread's queries.
	saveContext(sessionId, continuing ? Float32Array.from(vector, (v, i) => 0.6 * context![i]! + 0.4 * v) : Float32Array.from(vector));
	const norm = Math.hypot(...next) || 1;
	return next.map((v) => v / norm);
}

export function clearPriming(sessionId: string): void {
	primed.delete(sessionId);
}

function sessionCwd(sessionId: string): string | undefined {
	const { db } = openBrainDb();
	const row = db.query("SELECT cwd FROM sessions WHERE id = ?").get(sessionId) as { cwd: string } | null;
	return row?.cwd || undefined;
}

function hydrateChunks(fused: Map<number, number>): Candidate[] {
	const { db } = openBrainDb();
	const ids = [...fused.keys()];
	if (ids.length === 0) return [];
	const rows = db
		.query(
			`SELECT c.id AS chunkId, d.id AS docId, d.path, d.title, d.hash, c.heading, c.text,
			        d.access_count, d.last_access, d.mtime
			 FROM chunks c JOIN docs d ON d.id = c.doc_id
			 WHERE c.id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<
		Omit<Candidate, "score"> & { access_count: number; last_access: number; mtime: number }
	>;
	return rows.map((r) => ({
		chunkId: r.chunkId,
		docId: r.docId,
		path: r.path,
		title: r.title,
		heading: r.heading,
		text: r.text,
		hash: r.hash,
		score:
			(fused.get(r.chunkId) ?? 0) *
			activationBoost({ accessCount: r.access_count, lastAccess: r.last_access, created: r.mtime }),
	}));
}

function hydrateEpisodes(fused: Map<number, number>): EpisodeCandidate[] {
	const { db } = openBrainDb();
	const ids = [...fused.keys()];
	if (ids.length === 0) return [];
	const rows = db
		.query(
			`SELECT id, session_id, kind, ts, text, salience, access_count, last_access
			 FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<{
		id: number;
		session_id: string;
		kind: string;
		ts: number;
		text: string;
		salience: number;
		access_count: number;
		last_access: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		sessionId: r.session_id,
		kind: r.kind,
		ts: r.ts,
		text: r.text,
		salience: r.salience,
		score:
			(fused.get(r.id) ?? 0) *
			EPISODE_WEIGHT *
			r.salience ** 0.4 *
			activationBoost({ accessCount: r.access_count, lastAccess: r.last_access, created: r.ts }),
	}));
}

/**
 * Co-citation signal: a candidate connected to other candidates is likely the hub the
 * query is actually about. Every edge kind counts, weighted as the graph weights it — a
 * wikilink fully, a similarity edge by its discounted cosine. Multiplicative, so it scales
 * with the fused score instead of swamping it.
 */
function applyGraphBoost(candidates: Candidate[]): void {
	const { db } = openBrainDb();
	const docIds = [...new Set(candidates.map((c) => c.docId))];
	if (docIds.length < 2) return;
	const list = docIds.map(() => "?").join(",");
	const rows = db
		.query(
			`SELECT source_doc AS a, target_doc AS b, 'wikilink' AS kind, 1.0 AS w FROM links
			 WHERE source_doc IN (${list}) AND target_doc IN (${list})
			 UNION ALL
			 SELECT source_doc, target_doc, kind, weight FROM derived_links
			 WHERE source_doc IN (${list}) AND target_doc IN (${list})`,
		)
		.all(...docIds, ...docIds, ...docIds, ...docIds) as Array<{ a: number; b: number; kind: string; w: number }>;
	const attachment = new Map<number, number>();
	for (const row of rows) {
		const weight = row.kind === "wikilink" ? EDGE_WEIGHT.wikilink! : row.kind === "semantic" ? EDGE_WEIGHT.semantic! * row.w : row.w;
		attachment.set(row.a, (attachment.get(row.a) ?? 0) + weight);
		attachment.set(row.b, (attachment.get(row.b) ?? 0) + weight);
	}
	for (const c of candidates) {
		const n = attachment.get(c.docId) ?? 0;
		if (n > 0) c.score *= 1 + Math.min(n * 0.05, 0.15);
	}
}

/** One hit per note: best chunk carries it, small bonus when several chunks matched. */
function poolByDoc(candidates: Candidate[]): Candidate[] {
	const byDoc = new Map<number, { best: Candidate; extra: number }>();
	for (const c of candidates) {
		const entry = byDoc.get(c.docId);
		if (!entry) byDoc.set(c.docId, { best: c, extra: 0 });
		else {
			entry.extra++;
			if (c.score > entry.best.score) entry.best = c;
		}
	}
	return [...byDoc.values()].map(({ best, extra }) => ({
		...best,
		score: best.score * (1 + Math.min(extra * 0.05, 0.15)),
	}));
}

/** Lower is more deliberately filed: a topic folder beats the inbox, an original beats a "(2)". */
function canonicalRank(path: string): number {
	const inbox = /(^|\/)inbox\//i.test(path) ? 1000 : 0;
	const copy = /\(\d+\)\.md$/.test(path) ? 100 : 0;
	return inbox + copy + path.length / 100;
}

/**
 * One hit per piece of knowledge, not per copy of it. A capture filed into a topic folder
 * and left in the inbox, a journal entry pasted into a note — the vault holds the same
 * text several times over, and each copy would take a slot in the answer. Exact copies
 * share a content hash; near-copies share a centroid. The most deliberately filed copy
 * represents the group, at the group's best score.
 */
function collapseDuplicates(pooled: Candidate[]): Candidate[] {
	if (pooled.length < 2) return pooled;
	const { db, vectors } = openBrainDb();
	const centroids = new Map<number, Float32Array>();
	if (vectors) {
		const ids = pooled.map((c) => c.docId);
		const rows = db
			.query(`SELECT doc_id, embedding FROM doc_centroids WHERE doc_id IN (${ids.map(() => "?").join(",")})`)
			.all(...ids) as Array<{ doc_id: number; embedding: Uint8Array }>;
		for (const row of rows) {
			centroids.set(row.doc_id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBED_DIM));
		}
	}
	const groups: Candidate[][] = [];
	for (const c of pooled) {
		const group = groups.find((g) => {
			const rep = g[0]!;
			if (rep.hash === c.hash) return true;
			const a = centroids.get(rep.docId);
			const b = centroids.get(c.docId);
			return a !== undefined && b !== undefined && cosine(a, b) >= DUPLICATE_COSINE;
		});
		if (group) group.push(c);
		else groups.push([c]);
	}
	return groups.map((g) => {
		if (g.length === 1) return g[0]!;
		const keeper = [...g].sort((x, y) => canonicalRank(x.path) - canonicalRank(y.path) || y.score - x.score)[0]!;
		return { ...keeper, score: Math.max(...g.map((m) => m.score)), copies: g.length - 1 };
	});
}

/**
 * Context-dependent memory: what was useful in this place before is likelier to be the
 * thing wanted here now. Small, multiplicative, and only from *other* sessions — the
 * current one already carries its working memory in the priming trace.
 */
function applyContextBoost(candidates: Candidate[], cwd: string | undefined, sessionId: string | undefined): void {
	if (!cwd || candidates.length === 0) return;
	const { db } = openBrainDb();
	const ids = candidates.map((c) => c.docId);
	const rows = db
		.query(
			`SELECT DISTINCT doc_id FROM recalls WHERE cwd = ? AND session_id <> ?
			 AND doc_id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(cwd, sessionId ?? "", ...ids) as Array<{ doc_id: number }>;
	const familiar = new Set(rows.map((r) => r.doc_id));
	for (const c of candidates) if (familiar.has(c.docId)) c.score *= CONTEXT_BOOST;
}

/** Pull in notes that matched nothing but sit one association away from a strong match. */
function addAssociations(pooled: Candidate[], limit: number, pathPrefix?: string): Candidate[] {
	if (pooled.length === 0 || limit <= 0) return pooled;
	const seeds = new Map(pooled.map((c) => [c.docId, c.score]));
	const spread = spreadActivation(seeds, limit);
	if (spread.length === 0) return pooled;

	const { db } = openBrainDb();
	const titleByDoc = new Map(pooled.map((c) => [c.docId, c.title]));
	const ids = spread.map((s) => s.docId);
	// The opening chunk of a note is its summary — the right thing to show for a hit
	// that was never matched on content.
	const rows = db
		.query(
			`SELECT d.id AS docId, d.path, d.title, d.hash, c.id AS chunkId, c.heading, c.text
			 FROM docs d JOIN chunks c ON c.doc_id = d.id AND c.pos = 0
			 WHERE d.id IN (${ids.map(() => "?").join(",")})`,
		)
		.all(...ids) as Array<Omit<Candidate, "score">>;
	const byDoc = new Map(rows.map((r) => [r.docId, r]));

	const extra: Candidate[] = [];
	for (const s of spread) {
		const row = byDoc.get(s.docId);
		if (!row) continue;
		// A folder-scoped recall must stay in the folder. Spreading runs after the scoped
		// rankers, so without this an association drags a note from outside the scope into
		// a result set the caller asked to be limited.
		if (pathPrefix && !row.path.toLowerCase().startsWith(pathPrefix)) continue;
		extra.push({ ...row, score: s.score, via: titleByDoc.get(s.viaDocId) });
	}
	return pooled.concat(extra);
}

/** At most one trace per session, so a single chatty session can't fill the results. */
function diversifyEpisodes(candidates: EpisodeCandidate[], k: number): EpisodeCandidate[] {
	const seen = new Set<string>();
	const out: EpisodeCandidate[] = [];
	for (const c of candidates.sort((a, b) => b.score - a.score)) {
		if (seen.has(c.sessionId)) continue;
		seen.add(c.sessionId);
		out.push(c);
		if (out.length >= k) break;
	}
	return out;
}

export interface TimeWindow {
	since: number;
	until: number;
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * When the cue says *when*, the episodic store can answer by time as well as by content —
 * "what broke yesterday" is mostly a date, barely a topic. Deliberately literal: only the
 * phrases people actually type, never a guess.
 */
export function temporalWindow(query: string, now = Date.now()): TimeWindow | null {
	const q = query.toLowerCase();
	const today = startOfDay(now);
	if (/\btoday\b/.test(q)) return { since: today, until: now };
	if (/\byesterday\b/.test(q)) return { since: today - DAY, until: today };
	const ago = q.match(/\b(\d+)\s+(day|week|month)s?\s+ago\b/);
	if (ago) {
		const unit = ago[2] === "day" ? DAY : ago[2] === "week" ? 7 * DAY : 30 * DAY;
		const at = now - Number(ago[1]) * unit;
		return { since: at - unit, until: at + unit };
	}
	if (/\b(this|past) week\b/.test(q)) return { since: now - 7 * DAY, until: now };
	if (/\blast week\b/.test(q)) return { since: now - 14 * DAY, until: now };
	if (/\b(this|past|last) month\b/.test(q)) return { since: now - 45 * DAY, until: now };
	if (/\b(recently|the other day|earlier this week)\b/.test(q)) return { since: now - 14 * DAY, until: now };
	return null;
}

/** Episodes inside a window, newest first — time itself as a ranker, fused like the others. */
function temporalRanks(window: TimeWindow): Map<number, number> {
	const { db } = openBrainDb();
	const rows = db
		.query("SELECT id FROM episodes WHERE ts BETWEEN ? AND ? ORDER BY salience DESC, ts DESC LIMIT ?")
		.all(window.since, window.until, CANDIDATES) as Array<{ id: number }>;
	const ranks = new Map<number, number>();
	rows.forEach((r, i) => ranks.set(r.id, i));
	return ranks;
}

/**
 * The solution section of each doc, found across *all* its chunks — the point is that it
 * usually lives in a chunk other than the one that matched.
 */
function solutionsFor(docIds: number[]): Map<number, string> {
	const out = new Map<number, string>();
	if (docIds.length === 0) return out;
	const { db } = openBrainDb();
	const rows = db
		.query(
			`SELECT doc_id, text FROM chunks WHERE doc_id IN (${docIds.map(() => "?").join(",")}) ORDER BY doc_id, pos`,
		)
		.all(...docIds) as Array<{ doc_id: number; text: string }>;
	for (const row of rows) {
		if (out.has(row.doc_id)) continue;
		const match = SOLUTION_HEADING.exec(row.text);
		if (!match) continue;
		const body = row.text
			.slice(match.index + match[0].length)
			// Stop at the next heading: the fix is the block under its own heading.
			.split(/\n##+\s/)[0]!
			.trim();
		if (body) out.set(row.doc_id, body);
	}
	return out;
}

/** The binding written on every reinforced recall: this session used these notes, here. */
function recordRecalls(sessionId: string, cwd: string, docIds: number[], now = Date.now()): void {
	if (docIds.length === 0) return;
	const { db } = openBrainDb();
	const insert = db.query(
		`INSERT INTO recalls (session_id, doc_id, cwd, ts) VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id, doc_id) DO UPDATE SET ts = excluded.ts, cwd = excluded.cwd`,
	);
	db.transaction(() => {
		for (const docId of docIds) insert.run(sessionId, docId, cwd, now);
	})();
}

/**
 * A note handed over by the brain — through `read`, not through a search. It counts as a
 * retrieval like any other: it strengthens the trace, and it is what tells the guard this
 * session came by the note honestly.
 */
export function noteServed(sessionId: string, cwd: string, path: string): void {
	const { db } = openBrainDb();
	const row = db.query("SELECT id FROM docs WHERE path = ?").get(path) as { id: number } | null;
	if (!row) return;
	recordRecalls(sessionId, cwd, [row.id]);
	strengthen([row.id], []);
}

/** Vault paths the brain has handed this session, for the guard. */
export function servedPaths(sessionId: string): Set<string> {
	const { db } = openBrainDb();
	if (!sessionId) return new Set();
	const rows = db
		.query("SELECT d.path FROM recalls r JOIN docs d ON d.id = r.doc_id WHERE r.session_id = ?")
		.all(sessionId) as Array<{ path: string }>;
	return new Set(rows.map((r) => r.path));
}

/** When another session last retrieved each note, and from where. */
function lastUsedFor(docIds: number[], sessionId: string | undefined): Map<number, { ts: number; cwd: string }> {
	const out = new Map<number, { ts: number; cwd: string }>();
	if (docIds.length === 0) return out;
	const { db } = openBrainDb();
	const rows = db
		.query(
			`SELECT doc_id, ts, cwd FROM recalls WHERE session_id <> ?
			 AND doc_id IN (${docIds.map(() => "?").join(",")}) ORDER BY ts DESC`,
		)
		.all(sessionId ?? "", ...docIds) as Array<{ doc_id: number; ts: number; cwd: string }>;
	for (const row of rows) if (!out.has(row.doc_id)) out.set(row.doc_id, { ts: row.ts, cwd: row.cwd });
	return out;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function hybridRecall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
	const k = options.k ?? 6;
	const episodeK = options.episodeK ?? Math.max(1, Math.round(k / 3));
	const prefix = options.pathPrefix ? normalizePrefix(options.pathPrefix) : undefined;
	const cwd = options.cwd ?? (options.sessionId ? sessionCwd(options.sessionId) : undefined);

	// Lexical first: it is synchronous, and it decides whether the cue needs spelling help.
	let terms = queryTerms(query);
	let corrected: string[] | undefined;
	let lexical = lexicalRanks("chunks_fts", [3.0, 2.0, 1.0], terms, prefix);
	if (lexical.ranks.size < LEXICAL_FLOOR && terms.length > 0) {
		const fixed = correctTerms(terms);
		if (fixed) {
			const retry = lexicalRanks("chunks_fts", [3.0, 2.0, 1.0], fixed, prefix);
			if (retry.ranks.size > lexical.ranks.size) {
				terms = fixed;
				corrected = fixed;
				lexical = retry;
			}
		}
	}
	// The vector arm sees the original wording: subword overlap already tolerates a typo
	// there, and a list of stems is a worse sentence than a misspelt one.
	const vector = primeQuery(options.sessionId, await embedQuery(query));

	let notes = hydrateChunks(fuse([lexical.ranks, vectorRanks("vec_chunks", "chunk_id", vector, prefix)]));
	// Safety net only: both rankers already scoped in SQL, so this is a no-op unless a
	// path changed between the ranking queries and hydration.
	if (prefix) notes = notes.filter((c) => c.path.toLowerCase().startsWith(prefix));
	applyGraphBoost(notes);
	const pooled = collapseDuplicates(poolByDoc(notes));
	applyContextBoost(pooled, cwd, options.sessionId);
	pooled.sort((a, b) => b.score - a.score);
	const topNotes = addAssociations(pooled.slice(0, k), Math.max(1, Math.round(k / 4)), prefix)
		.sort((a, b) => b.score - a.score)
		.slice(0, k);

	let episodes: EpisodeCandidate[] = [];
	if (episodeK > 0 && !options.pathPrefix) {
		const window = temporalWindow(query);
		const rankLists = [lexicalRanks("episodes_fts", [1.0], terms).ranks, vectorRanks("vec_episodes", "episode_id", vector)];
		if (window) rankLists.push(temporalRanks(window));
		let pool = hydrateEpisodes(fuse(rankLists)).filter((e) => e.sessionId !== options.excludeSessionId);
		if (window) {
			const inside = pool.filter((e) => e.ts >= window.since && e.ts <= window.until);
			if (inside.length > 0) pool = inside.map((e) => ({ ...e, score: e.score * TEMPORAL_BOOST }));
		}
		episodes = diversifyEpisodes(pool, episodeK);
	}

	if (options.reinforce !== false) {
		strengthen(
			topNotes.map((n) => n.docId),
			episodes.map((e) => e.id),
		);
		if (options.sessionId) recordRecalls(options.sessionId, cwd ?? "", topNotes.map((n) => n.docId));
		if (topNotes.length > 0) {
			emit({
				type: "recall",
				ts: Date.now(),
				via: options.via ?? "unknown",
				query: clip(query, 120),
				paths: topNotes.map((n) => n.path),
			});
		}
	}
	const lastUsed = lastUsedFor(topNotes.map((n) => n.docId), options.sessionId);

	const budget = options.full ? FULL_SNIPPET_CHARS : SNIPPET_CHARS;
	const solutions = options.full ? new Map<number, string>() : solutionsFor(topNotes.map((c) => c.docId));
	// Corrected stems still steer the snippet: its line scorer matches on prefixes.
	const snippetCue = corrected ? `${query} ${corrected.join(" ")}` : query;
	const correctedCue = corrected?.join(" ");
	const { db } = openBrainDb();
	const chunks = (db.query("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
	const coverage = queryCoverage(terms, chunks);
	// Two ways to be unsure, and coverage overrules the ranker: a confident-looking score
	// assembled out of the vault's own vocabulary is exactly the case worth catching.
	const weak =
		topNotes.length > 0 && (coverage.covered < MIN_COVERAGE || (topNotes[0]!.score < WEAK_SCORE && !lexical.confident));
	const unknown = coverage.unknown.length > 0 ? coverage.unknown.slice(0, 4) : undefined;
	const noteHits: RecallHit[] = topNotes.map((c) => {
		const focused = focusSnippet(c.text, snippetCue, budget);
		const solution = solutions.get(c.docId);
		// Skip when the matched chunk already is the fix, or already carries its opening —
		// repeating it would spend the budget saying the same thing twice.
		const already = !solution || focused.includes(solution.slice(0, 40));
		return {
			kind: "note" as const,
			path: c.path,
			title: c.title,
			heading: c.heading,
			score: Number(c.score.toFixed(4)),
			snippet: already ? focused : `${focused}\n\nFix — ${clip(solution, SOLUTION_CHARS)}`,
			via: c.via,
			copies: c.copies,
			lastUsed: lastUsed.get(c.docId),
			corrected: correctedCue,
			weak,
			unknown,
		};
	});
	const episodeHits: RecallHit[] = episodes.map((e) => ({
		kind: "episode",
		path: `session/${e.sessionId}`,
		title: e.kind,
		heading: e.kind,
		score: Number(e.score.toFixed(4)),
		snippet: clip(e.text, EPISODE_SNIPPET_CHARS),
		when: e.ts,
		corrected: correctedCue,
	}));
	return [...noteHits, ...episodeHits];
}

export interface IndexStatus {
	docs: number;
	chunks: number;
	embedded: number;
	pendingEmbed: number;
	episodes: number;
	sessions: number;
	pendingEpisodeEmbed: number;
	recalls: number;
	edges: number;
	communities: number;
	vectors: boolean;
	lastIndex: string | null;
}

export function indexStatus(): IndexStatus {
	const { db, vectors } = openBrainDb();
	const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
	return {
		docs: one("SELECT count(*) AS n FROM docs"),
		chunks: one("SELECT count(*) AS n FROM chunks"),
		embedded: one("SELECT count(*) AS n FROM chunks WHERE embedded = 1"),
		pendingEmbed: one("SELECT count(*) AS n FROM chunks WHERE embedded = 0"),
		episodes: one("SELECT count(*) AS n FROM episodes"),
		sessions: one("SELECT count(*) AS n FROM sessions"),
		pendingEpisodeEmbed: one("SELECT count(*) AS n FROM episodes WHERE embedded = 0"),
		recalls: one("SELECT count(*) AS n FROM recalls"),
		edges: one("SELECT (SELECT count(*) FROM links) + (SELECT count(*) FROM derived_links) AS n"),
		communities: one("SELECT count(*) AS n FROM community_labels"),
		vectors,
		lastIndex: (db.query("SELECT value FROM meta WHERE key = 'last_index'").get() as { value: string } | null)?.value ?? null,
	};
}
