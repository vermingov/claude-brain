// Procedural memory: the standing instructions.
//
// Recall answers a question. A standing instruction is not a question — "always run the
// tests first", "never publish that repo" — and an instruction you have to remember to
// look up is one you have already failed to follow. So these are held apart from notes
// and episodes, and put in front of a session before it starts.
//
// Three things decide which ones get that space, and all three are borrowed rather than
// invented:
//
//   Salience. An instruction stated plainly outranks one inferred from passing phrasing;
//   deliberate encoding beats incidental encoding (Craik & Lockhart's levels of
//   processing, and the dopaminergic salience tagging that follows it).
//
//   Spaced repetition. Saying it again on a later day is worth far more than saying it
//   twice in a minute — the spacing effect, the most replicated finding in the memory
//   literature (Ebbinghaus 1885; Cepeda et al. 2006).
//
//   Decay, with a floor. An unrepeated rule loses ground on a power-law curve, as
//   declarative memory does in ACT-R's base-level equation (Anderson & Schooler 1991);
//   a rule that has proved itself over sessions stops decaying, the way a consolidated
//   memory becomes independent of the hippocampus (McClelland, McNaughton & O'Reilly
//   1995). That is what `consolidated` means here, and consolidated rules are written
//   into the always-loaded instructions rather than injected per session.
//
// Working memory is the constraint that makes any of this matter: a handful of items,
// not a list (Cowan 2001). So rules compete, and only the winners are shown.

import { openBrainDb } from "./index-db";

const DAY_MS = 86_400_000;
/**
 * Base-level decay. ACT-R's convention across many fits is d = 0.5, on a clock measured
 * in seconds; the clock here is days, because a rule is used across sessions rather than
 * within one, and that choice is mine, not the literature's.
 */
const DECAY = 0.5;
/**
 * Decay is not one number per rule: each statement carries its own, faster when the rule
 * was already strong at the moment it was repeated. That is what makes spaced repetition
 * worth more than massed repetition instead of merely different (Pavlik & Anderson 2005);
 * the form is theirs, these two constants are tuned to this system's day-scale clock.
 */
const DECAY_SCALE = 0.28;
const DECAY_FLOOR = 0.18;
/** The youngest a statement is allowed to look: an hour, so "just said" is not infinite. */
const MIN_AGE_DAYS = 1 / 24;
/**
 * Below this a rule is dormant: kept, not shown. Extinction is new learning that competes
 * with the old trace rather than erasing it (Bouton 2004), which is also why a superseded
 * rule is never put in the candidate set beside its replacement.
 */
const DORMANT = -1.2;
/** Statement times kept per rule; older ones contribute almost nothing anyway. */
const MAX_STATEMENTS = 12;
/** A rule that has held across this many separate sessions has earned the slow store. */
const CONSOLIDATE_SESSIONS = 2;
/**
 * Age alone is not evidence: a rule said once in passing and never mentioned again is
 * older, not stronger. Days count only for a rule that has actually been put in front of
 * a session and survived it — used and not withdrawn, which is the same "retrieval is
 * what strengthens" the rest of this file runs on.
 */
const CONSOLIDATE_DAYS = 3;
/**
 * How many rules a session is handed at once. Active maintenance in people tops out
 * around three or four items (Cowan 2001; Oberauer et al. 2018) — a number that describes
 * people, not a model, so treat it as a chosen budget. What does transfer is order:
 * attention to a long context is U-shaped (Liu et al. 2024), so the strongest rule goes
 * first and the weakest in the middle.
 */
export const SESSION_BUDGET = 4;
export const PROMPT_BUDGET = 2;
export const BUDGET_CHARS = 600;

export type Polarity = "do" | "dont";
export type Status = "provisional" | "stated" | "consolidated";

export interface DraftDirective {
	text: string;
	polarity: Polarity;
	status: Exclude<Status, "consolidated">;
	scope: "global" | "cwd";
	cues: string[];
}

export interface Directive {
	id: number;
	text: string;
	scope: string;
	scopeValue: string;
	cues: string[];
	polarity: Polarity;
	status: Status;
	created: number;
	lastStated: number;
	lastFired: number;
	fireCount: number;
	statements: number;
	supersededBy: number | null;
	/** Base-level activation right now: how present this rule is. */
	strength: number;
}

interface Row {
	id: number;
	text: string;
	fingerprint: string;
	scope: string;
	scope_value: string;
	cues: string;
	polarity: string;
	status: string;
	created: number;
	last_stated: number;
	last_fired: number;
	fire_count: number;
	statements: number;
	stated_in: string;
	stated_at: string;
	superseded_by: number | null;
}

const STOPWORDS = new Set(
	("the a an and or of for to in on with is are was were be been it its this that then than always never dont do not " +
		"you your we our my i me should must always never from now onwards going forward every time whenever by default " +
		"make sure remember please just also only ever when if").split(" "),
);

/** The words that decide whether a rule is about what is being asked now. */
export function cuesOf(text: string): string[] {
	const seen = new Set<string>();
	const keep = (raw: string) => {
		// Sentence punctuation clings to the last word — "master." must be the same cue as
		// "master" — but a dot inside a word is part of it, as in CHANGES.md.
		const word = raw.replace(/^[.-]+|[.-]+$/g, "");
		if (word.length >= 3 && !STOPWORDS.has(word)) seen.add(word);
	};
	for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u)) {
		keep(word);
		// "force-push master" and "force push to master" are one rule, so a hyphenated
		// compound counts as its parts as well as itself. Dots are left alone: CHANGES.md
		// is a filename, not two words.
		if (word.includes("-")) for (const part of word.split("-")) keep(part);
	}
	return [...seen].slice(0, 12);
}

/**
 * Two rules are the same rule when they are about the same thing *and* point the same
 * way. Without the polarity, "never deploy from main" and "always deploy from main" carry
 * identical subject words and would be filed as one — the reversal would read as a repeat.
 */
function fingerprintOf(text: string, polarity: Polarity): string {
	const cues = cuesOf(text).sort().join(" ");
	return `${polarity}:${cues || text.toLowerCase().trim()}`;
}

/** Same subject, same direction: a restatement, however the wording moved. */
const RESTATEMENT_OVERLAP = 0.8;
/** Same subject, opposite direction: a change of mind. */
const REVERSAL_OVERLAP = 0.6;
/**
 * How far being about the question at hand can carry a rule. Context adds to base-level
 * activation rather than scaling it (ACT-R's spreading activation term), which is also
 * the only sign-safe way to combine them.
 */
const CUE_BONUS = 2;

/**
 * Verbs people swap freely when restating a rule they already gave: "never publish xrec to
 * github" and "xrec goes to the AUR, never github" are one rule with two verbs. What a rule
 * is *about* — the tool, the repo, the file — is what identifies it, so the action counts
 * for less. Without this, restating a rule in fresh words files it as a second rule.
 */
const GENERIC_VERBS = new Set(
	("go use run push pull publish send put keep make write add remove check ask prefer start stop deploy commit ship " +
		"read call build open close set take give show treat verify merge squash create delete update change fix handle " +
		"ensure apply install save load import export return pass follow touch split move copy").split(" "),
);
/** Enough of a stemmer to recognise the same verb inflected: goes, publishing, merged. */
function cueWeight(cue: string): number {
	const forms = [cue, cue.replace(/e?s$/, ""), cue.replace(/ed$/, ""), cue.replace(/ing$/, ""), cue.replace(/ing$/, "e")];
	return forms.some((form) => GENERIC_VERBS.has(form)) ? 0.5 : 1;
}

/**
 * How much of one rule's subject the other covers. Two rules about the same thing collide
 * whatever their wording; two rules about different things never do.
 */
export function cueOverlap(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const weigh = (cues: string[]) => cues.reduce((sum, cue) => sum + cueWeight(cue), 0);
	const other = new Set(b);
	const shared = weigh(a.filter((cue) => other.has(cue)));
	return shared / Math.min(weigh(a), weigh(b));
}

// --- Detection -------------------------------------------------------------------

/** Phrasings that carry a rule rather than a request for this one turn. */
const MARKERS =
	/\b(always|never|from now on|going forward|henceforth|every time|each time|whenever|by default|as a rule|make sure|be sure to|don'?t ever|no longer|remember to|remember that|keep in mind|only ever|instead of|rather than|prefer)\b/i;
/** Said plainly, as an instruction to remember. */
const EXPLICIT = /\b(remember (to|that)|keep in mind|from now on|going forward|henceforth|as a rule|by default|always|never)\b/i;
/** A modal turns a statement about the world into a rule about conduct. */
const MODAL = /\b(should|shall|must|need(s)? to|ha[sv]e to|will|won'?t|can'?t|cannot|do not|don'?t|stop|avoid)\b/i;
/** Something that happens, not something to do: "it always crashes", "the build never finishes". */
const DESCRIPTIVE =
	/\b(it|this|that|they|there|he|she|the [\p{L}-]+|my [\p{L}-]+|[\p{L}-]+)\s+(always|never)\s+[\p{L}-]+(s|ed|ing)\b/iu;
/** Recounting, not instructing. */
const PAST = /\b(used to|had to|was|were|got|did|happened|crashed|failed|worked)\b/i;
/** A sentence that opens with one of these is being told to someone. */
const IMPERATIVE =
	/^(always|never|use|run|write|make|keep|check|ask|avoid|prefer|stop|start|remember|put|add|remove|deploy|commit|test|verify|read|call|treat|build|ship|push|pull|open|close|send|show|give|take|set|do|don'?t)\b/i;
const QUESTION = /\?\s*$/;
/** "in this project", "here", "for this repo": the rule is about where it was given. */
const LOCAL = /\b(in (this|the) (project|repo|repository|codebase|folder|directory)|for (this|the) (project|repo|repository|codebase)|here)\b/i;
const NEGATIVE = /\b(never|no longer|don'?t|do not|avoid|stop|without|instead of|rather than)\b/i;

const MAX_DIRECTIVE_CHARS = 220;
/** How a rule gets attached to the sentence before it. None of this is part of the rule. */
const CONNECTIVE =
	/^(also|and|plus|oh|btw|by the way|one more thing|another thing|finally|lastly|then|actually|okay|ok|so|right|hey)\b[,:\s]*/i;

function sentences(prompt: string): string[] {
	return prompt
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?;])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Standing instructions inside something the user said. Deliberately conservative about
 * shape and deliberately generous about phrasing: people state rules as fragments ("AUR
 * only, never GitHub") as often as as sentences.
 */
export function detectDirectives(prompt: string): DraftDirective[] {
	const out: DraftDirective[] = [];
	for (const sentence of sentences(prompt)) {
		if (sentence.length > MAX_DIRECTIVE_CHARS || QUESTION.test(sentence)) continue;
		if (!MARKERS.test(sentence)) continue;
		const modal = MODAL.test(sentence);
		// "it always crashes" is a complaint; "it should always retry" is a rule.
		if (DESCRIPTIVE.test(sentence) && !modal) continue;
		if (PAST.test(sentence) && !modal) continue;
		const cues = cuesOf(sentence);
		if (cues.length === 0) continue;
		const stated = EXPLICIT.test(sentence) || IMPERATIVE.test(sentence) || modal;
		out.push({
			text: sentence.replace(CONNECTIVE, "").replace(/^[,\s]+/, ""),
			polarity: NEGATIVE.test(sentence) ? "dont" : "do",
			status: stated ? "stated" : "provisional",
			scope: LOCAL.test(sentence) ? "cwd" : "global",
			cues,
		});
	}
	return out;
}

/**
 * A rule the caller means as a rule: no inference, no hedging about whether the phrasing
 * carried a marker. This is the path a tool call takes.
 */
export function statedDirective(text: string, options: { scope?: "global" | "cwd" } = {}): DraftDirective {
	const trimmed = text.replace(/\s+/g, " ").trim().slice(0, MAX_DIRECTIVE_CHARS);
	return {
		text: trimmed,
		polarity: NEGATIVE.test(trimmed) ? "dont" : "do",
		status: "stated",
		scope: options.scope ?? (LOCAL.test(trimmed) ? "cwd" : "global"),
		cues: cuesOf(trimmed),
	};
}

// --- Strength --------------------------------------------------------------------

export function statementTimes(row: Pick<Row, "stated_at" | "last_stated">): number[] {
	const parsed = row.stated_at
		.split(",")
		.map(Number)
		.filter((value) => Number.isFinite(value) && value > 0);
	return parsed.length > 0 ? parsed : [row.last_stated];
}

/**
 * Base-level activation: B = ln(Σ t_j^−d) over every time the rule was stated (Anderson &
 * Schooler 1991). Each statement decays on its own power-law curve, so recency, frequency
 * and spacing come out of one equation rather than three rules of thumb — and each one
 * decays faster if the rule was already strong when it was repeated, which is what makes
 * saying it again a week later worth more than saying it twice in a minute.
 *
 * Salience rides on top as a multiplier, not a category: an instruction stated plainly
 * outranks one inferred from passing phrasing. The literature supports the direction
 * (novelty and reward gate what persists — Takeuchi et al. 2016) but not this number.
 */
export function strengthOf(
	row: Pick<Row, "statements" | "last_stated" | "status" | "fire_count" | "stated_at">,
	now = Date.now(),
): number {
	const times = statementTimes(row).sort((a, b) => a - b);
	let sum = 0;
	for (let i = 0; i < times.length; i++) {
		const age = Math.max(MIN_AGE_DAYS, (now - times[i]!) / DAY_MS);
		// Activation contributed by everything that came before this statement decides how
		// quickly this one fades: a repetition into an already-hot memory buys little.
		let prior = 0;
		for (let j = 0; j < i; j++) prior += Math.max(MIN_AGE_DAYS, (times[i]! - times[j]!) / DAY_MS) ** -DECAY;
		const decay = DECAY_SCALE * prior + DECAY_FLOOR;
		sum += age ** -Math.min(decay, 0.9);
	}
	// Being put in front of a session is exposure, not use: the testing effect is about
	// successful retrieval, which nothing here can observe. So it counts, barely.
	sum += Math.min(row.fire_count, 20) * 0.01;
	// Salience scales the trace, not its logarithm — a multiplier applied after the log
	// would make a weak rule stronger the more it had already faded.
	const salience = row.status === "provisional" ? 0.6 : 1;
	const base = Math.log(Math.max(sum * salience, 1e-6));
	// Consolidated rules stop decaying: they no longer depend on the fast store to survive
	// (McClelland, McNaughton & O'Reilly 1995).
	return row.status === "consolidated" ? Math.max(base, 0.5) : base;
}

function hydrate(row: Row, now: number): Directive {
	return {
		id: row.id,
		text: row.text,
		scope: row.scope,
		scopeValue: row.scope_value,
		cues: row.cues ? row.cues.split(" ") : [],
		polarity: row.polarity as Polarity,
		status: row.status as Status,
		created: row.created,
		lastStated: row.last_stated,
		lastFired: row.last_fired,
		fireCount: row.fire_count,
		statements: row.statements,
		supersededBy: row.superseded_by,
		strength: Number(strengthOf(row, now).toFixed(3)),
	};
}

// --- Capture ---------------------------------------------------------------------

export interface CaptureResult {
	directive: Directive;
	/** Said before, and said again. */
	reinforced: boolean;
	/** The rule this one replaced, if it reversed an earlier instruction. */
	superseded?: Directive;
}

/**
 * Store a rule, or strengthen the one it repeats, or reverse the one it contradicts.
 *
 * Contradiction is the interesting case: "always deploy from main" after "never deploy
 * from main" is not a second rule, it is a correction, and keeping both would leave the
 * old one to intrude (proactive interference). The old rule is marked superseded rather
 * than deleted, so the change itself stays on the record.
 */
export function captureDirective(draft: DraftDirective, sessionId: string, cwd: string, now = Date.now()): CaptureResult {
	const { db } = openBrainDb();
	const fingerprint = fingerprintOf(draft.text, draft.polarity);
	const scopeValue = draft.scope === "cwd" ? cwd : "";
	const live = db.query("SELECT * FROM directives WHERE superseded_by IS NULL").all() as Row[];
	const overlapWith = (row: Row) => cueOverlap(draft.cues, row.cues.split(" ").filter(Boolean));

	// The same rule said again, whether word for word or with a clause added.
	const existing =
		live.find((row) => row.fingerprint === fingerprint) ??
		live.find((row) => row.polarity === draft.polarity && overlapWith(row) >= RESTATEMENT_OVERLAP);
	if (existing) {
		// Spacing: a restatement hours later is a new learning episode; one a minute later
		// is emphasis. Either way the clock moves, so the rule stops decaying.
		// Every restatement is its own trace, and the wording is rewritten in place rather
		// than stored beside the old one: a reactivated memory is re-stored, not duplicated
		// (Nader, Schafe & LeDoux 2000), and an exception kept next to a rule is how the
		// old version intrudes later.
		const stated = new Set(existing.stated_in.split(",").filter(Boolean));
		if (sessionId) stated.add(sessionId);
		const times = [...statementTimes(existing), now].slice(-MAX_STATEMENTS);
		const status = existing.status === "provisional" && draft.status === "stated" ? "stated" : existing.status;
		db.query(
			`UPDATE directives SET last_stated = ?, statements = ?, stated_in = ?, stated_at = ?, status = ?, text = ?,
			 cues = ?, fingerprint = ? WHERE id = ?`,
		).run(
			now,
			times.length,
			[...stated].slice(-8).join(","),
			times.join(","),
			status,
			draft.text,
			draft.cues.join(" "),
			fingerprint,
			existing.id,
		);
		const row = db.query("SELECT * FROM directives WHERE id = ?").get(existing.id) as Row;
		return { directive: hydrate(row, now), reinforced: true };
	}

	// A rule about the same subject, pointing the other way, is a change of mind.
	const reversed = live.filter((row) => row.polarity !== draft.polarity && overlapWith(row) >= REVERSAL_OVERLAP);

	const id = (
		db
			.query(
				`INSERT INTO directives (text, fingerprint, scope, scope_value, cues, polarity, status, created, last_stated, stated_in, stated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			)
			.get(
				draft.text,
				fingerprint,
				draft.scope,
				scopeValue,
				draft.cues.join(" "),
				draft.polarity,
				draft.status,
				now,
				now,
				sessionId,
				String(now),
			) as { id: number }
	).id;

	let superseded: Directive | undefined;
	for (const row of reversed) {
		db.query("UPDATE directives SET superseded_by = ? WHERE id = ?").run(id, row.id);
		superseded = hydrate(row, now);
	}
	const row = db.query("SELECT * FROM directives WHERE id = ?").get(id) as Row;
	return { directive: hydrate(row, now), reinforced: false, ...(superseded ? { superseded } : {}) };
}

// --- Selection -------------------------------------------------------------------

export interface SelectOptions {
	cwd?: string;
	/** What is being asked right now; its words pull matching rules forward. */
	prompt?: string;
	limit?: number;
	chars?: number;
	/** Rules already in this context window. */
	exclude?: Set<number>;
	/** Return every live rule, ignoring the budget: for listing, not for injecting. */
	all?: boolean;
	now?: number;
}

/**
 * The rules that win the space. Strength decides most of it; a rule whose subject is what
 * the session is actually doing right now comes forward, which is how prospective memory
 * works — the cue in the environment retrieves the intention (Einstein & McDaniel 1990).
 */
export function selectDirectives(options: SelectOptions = {}): Directive[] {
	const { db } = openBrainDb();
	const now = options.now ?? Date.now();
	const rows = db.query("SELECT * FROM directives WHERE superseded_by IS NULL").all() as Row[];
	const promptCues = options.prompt ? new Set(cuesOf(options.prompt)) : null;

	const scored = rows
		.map((row) => hydrate(row, now))
		.filter((directive) => {
			if (options.exclude?.has(directive.id)) return false;
			if (options.all) return true;
			if (directive.strength < DORMANT) return false;
			if (directive.scope === "cwd" && directive.scopeValue && directive.scopeValue !== options.cwd) return false;
			// A rule inferred from passing phrasing has to earn its place by being about
			// what is being asked; it does not get handed to every session on spec.
			if (directive.status === "provisional" && !promptCues) return false;
			return true;
		})
		.map((directive) => {
			const match = promptCues ? directive.cues.filter((cue) => promptCues.has(cue)).length : 0;
			// With a prompt in hand, only rules about it are worth the space at all; the rest
			// were already offered at the start of the session.
			if (promptCues && match === 0) return null;
			const bonus = promptCues ? (CUE_BONUS * match) / Math.max(directive.cues.length, 1) : 0;
			return { directive, score: directive.strength + bonus };
		})
		.filter((entry): entry is { directive: Directive; score: number } => entry !== null)
		.sort((a, b) => b.score - a.score);

	if (options.all) return scored.map((entry) => entry.directive);
	const out: Directive[] = [];
	let chars = 0;
	for (const entry of scored) {
		if (out.length >= (options.limit ?? SESSION_BUDGET)) break;
		const cost = entry.directive.text.length + 4;
		if (chars + cost > (options.chars ?? BUDGET_CHARS)) continue;
		chars += cost;
		out.push(entry.directive);
	}
	return out;
}

/** Note that these rules were put in front of a session. */
export function markFired(ids: number[], now = Date.now()): void {
	if (ids.length === 0) return;
	const { db } = openBrainDb();
	db.query(`UPDATE directives SET fire_count = fire_count + 1, last_fired = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(
		now,
		...ids,
	);
}

// --- The slow store --------------------------------------------------------------

/**
 * Rules that have earned a place in the always-loaded instructions: said plainly, held
 * across separate sessions or several days, never reversed. This is the crossing from the
 * fast, context-bound store to the slow one — after which the rule no longer depends on
 * the daemon being up to be followed.
 */
export function consolidate(now = Date.now()): Directive[] {
	const { db } = openBrainDb();
	const rows = db.query("SELECT * FROM directives WHERE superseded_by IS NULL AND status <> 'provisional'").all() as Row[];
	const promoted: Directive[] = [];
	for (const row of rows) {
		const sessions = row.stated_in.split(",").filter(Boolean).length;
		const ageDays = (now - row.created) / DAY_MS;
		const repeated = row.statements >= CONSOLIDATE_SESSIONS || sessions >= CONSOLIDATE_SESSIONS;
		const earned = repeated || (ageDays >= CONSOLIDATE_DAYS && row.fire_count > 0);
		// A rule too faint to be worth a session's context is not one to write into the
		// permanent instructions, however long it has been sitting there.
		if (!earned || strengthOf(row, now) < DORMANT) continue;
		if (row.status !== "consolidated") db.query("UPDATE directives SET status = 'consolidated' WHERE id = ?").run(row.id);
		promoted.push(hydrate({ ...row, status: "consolidated" }, now));
	}
	return promoted.sort((a, b) => b.strength - a.strength);
}

export function listDirectives(now = Date.now(), includeSuperseded = false): Directive[] {
	const { db } = openBrainDb();
	const where = includeSuperseded ? "" : "WHERE superseded_by IS NULL";
	const rows = db.query(`SELECT * FROM directives ${where} ORDER BY last_stated DESC`).all() as Row[];
	return rows.map((row) => hydrate(row, now)).sort((a, b) => b.strength - a.strength);
}

/** Drop a rule outright: the user's correction of the brain, not of themselves. */
export function retractDirective(id: number): boolean {
	const { db } = openBrainDb();
	const row = db.query("SELECT 1 FROM directives WHERE id = ?").get(id);
	if (!row) return false;
	db.query("DELETE FROM directives WHERE id = ?").run(id);
	return true;
}
