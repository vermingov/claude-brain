// What the dashboard's Home shows: the state of the brain in numbers, what it has been
// doing lately, and what it keeps running into. Every figure is read from the index; the
// one expensive thing (finding recurring themes) is taken from the last consolidation
// rather than recomputed per page load.

import { indexStatus, type IndexStatus } from "./hybrid-search";
import { getMeta, openBrainDb } from "./index-db";
import type { Recurrence } from "./consolidate";

const DAY_MS = 86_400_000;
const ACTIVITY_DAYS = 14;
const TOP_NOTES = 8;
const RECENT_SESSIONS = 6;
const TOP_CLUSTERS = 8;

export interface DayActivity {
	/** YYYY-MM-DD, local time. */
	day: string;
	episodes: number;
	recalls: number;
}

export interface TopNote {
	path: string;
	title: string;
	accessCount: number;
	lastAccess: number;
}

export interface RecentSession {
	id: string;
	cwd: string;
	started: number;
	ended: number | null;
	summary: string;
}

export interface Overview {
	index: IndexStatus;
	activity: DayActivity[];
	topNotes: TopNote[];
	recentSessions: RecentSession[];
	themes: Recurrence[];
	clusters: Array<{ id: number; label: string; size: number }>;
	episodesByKind: Record<string, number>;
}

function localDay(ts: number): string {
	const d = new Date(ts);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

function activity(now: number): DayActivity[] {
	const { db } = openBrainDb();
	const since = now - ACTIVITY_DAYS * DAY_MS;
	const days = new Map<string, DayActivity>();
	for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
		const day = localDay(now - i * DAY_MS);
		days.set(day, { day, episodes: 0, recalls: 0 });
	}
	for (const row of db.query("SELECT ts FROM episodes WHERE ts >= ?").all(since) as Array<{ ts: number }>) {
		const bucket = days.get(localDay(row.ts));
		if (bucket) bucket.episodes++;
	}
	for (const row of db.query("SELECT ts FROM recalls WHERE ts >= ?").all(since) as Array<{ ts: number }>) {
		const bucket = days.get(localDay(row.ts));
		if (bucket) bucket.recalls++;
	}
	return [...days.values()];
}

export function overview(now = Date.now()): Overview {
	const { db } = openBrainDb();
	const topNotes = (
		db
			.query(
				`SELECT path, title, access_count AS accessCount, last_access AS lastAccess FROM docs
				 WHERE access_count > 0 ORDER BY access_count DESC, last_access DESC LIMIT ?`,
			)
			.all(TOP_NOTES) as TopNote[]
	);
	const recentSessions = db
		.query(
			`SELECT id, cwd, started, ended, summary FROM sessions
			 WHERE summary IS NOT NULL ORDER BY COALESCE(ended, started) DESC LIMIT ?`,
		)
		.all(RECENT_SESSIONS) as RecentSession[];
	const clusters = db
		.query("SELECT community AS id, label, size FROM community_labels WHERE size > 1 ORDER BY size DESC LIMIT ?")
		.all(TOP_CLUSTERS) as Array<{ id: number; label: string; size: number }>;
	const episodesByKind: Record<string, number> = {};
	for (const row of db.query("SELECT kind, count(*) AS n FROM episodes GROUP BY kind").all() as Array<{ kind: string; n: number }>) {
		episodesByKind[row.kind] = row.n;
	}
	let themes: Recurrence[] = [];
	try {
		themes = JSON.parse(getMeta(db, "proposals_json") ?? "[]") as Recurrence[];
	} catch {
		/* an older daemon stored only the count */
	}
	return { index: indexStatus(), activity: activity(now), topNotes, recentSessions, themes, clusters, episodesByKind };
}
