// Which Claude does the rebuilding, and how hard it is allowed to think.
//
// Describing a screenshot is a small job; rebuilding a page from its own source is not. It
// is the one thing in this package worth spending a good model on — so the model is chosen
// from what the user is actually paying for rather than pinned to whatever the cheap
// default is, and stepped back down when their allowance is running low.
//
// The ladder, top to bottom:
//
//   Max 20×   fable,  medium effort   the newest model, which does not need to strain
//   Max 5×    opus,   high effort     the deepest reasoning the plan comfortably affords
//   Pro       sonnet, medium effort   a good model, used sparingly
//   anything  haiku,  medium effort   free tier, API keys, or a plan we cannot read
//
// Two honest limitations, stated here rather than discovered later:
//
//   `claude auth status --json` reports the subscription as "max" and does not say whether
//   that is the 5× or the 20× plan. Nothing else local does either. So "max" alone chooses
//   the 5× rung, and a 20× subscriber says so once in Settings.
//
//   Nothing on this machine publishes live rate-limit percentages. Claude Code shows them
//   in /usage from response headers we never see, and the credential needed to ask the API
//   directly is not ours to read. So headroom comes from whatever the user points
//   `llm.usageCommand` at — any command printing {"daily":n,"weekly":n,"fableWeekly":n} as
//   percent USED — and falls back to this package's own spend ledger against its own daily
//   budget, which is at least a true statement about what claude-brain itself has spent.
//
// When a number is unknown it does not block: refusing the good model on no evidence would
// make the whole ladder collapse to haiku for everybody who has not wired up a usage
// command. The reason string always says which it was.

import { type ClaudeModel, type Effort, budgetBinds, spendTodayUsd, status as claudeStatus } from "./claude-cli";
import { loadConfig } from "./config";

export type Plan = "max20" | "max5" | "pro" | "free" | "api" | "unknown";

/** Percent of the allowance still left, or null when nothing can say. */
export interface Headroom {
	daily: number | null;
	weekly: number | null;
	fableWeekly: number | null;
	/** Where the numbers came from, for the settings panel. */
	source: string;
}

export interface ModelChoice {
	model: ClaudeModel;
	effort: Effort;
	plan: Plan;
	/** One sentence: why this model, in the user's terms. */
	why: string;
}

/** Above these, the plan's top rung is in play. Below, it steps down one. */
const DAILY_FLOOR = 60;
const WEEKLY_FLOOR = 50;

const USAGE_TIMEOUT_MS = 5_000;
const PLAN_TTL_MS = 10 * 60_000;

let planCache: { at: number; plan: Plan } | null = null;

/**
 * What the user is on. The CLI is the only thing that knows, and it is asked at most every
 * ten minutes — a subscription does not change between two design captures.
 */
export async function detectPlan(): Promise<Plan> {
	const configured = loadConfig().llm.plan;
	if (configured && configured !== "auto") return configured as Plan;
	if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) return planCache.plan;

	const st = await claudeStatus();
	let plan: Plan = "unknown";
	if (st.binary) {
		const proc = Bun.spawn([st.binary, "auth", "status", "--json"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const raw = await new Response(proc.stdout).text();
		await proc.exited;
		plan = planFrom(raw);
	}
	planCache = { at: Date.now(), plan };
	return plan;
}

/**
 * Read the subscription out of `claude auth status --json`. Exported for the test: the
 * shape of that payload is an integration point, and a silent change to it would quietly
 * drop every user back to haiku.
 */
export function planFrom(raw: string): Plan {
	let parsed: { loggedIn?: boolean; subscriptionType?: string; apiProvider?: string };
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "unknown";
	}
	if (!parsed.loggedIn) return "unknown";
	const type = String(parsed.subscriptionType ?? "").toLowerCase();
	// The 5×/20× split is not in this payload; "max" alone means the lower rung, and a 20×
	// subscriber sets llm.plan themselves. Guessing upward would spend their best model.
	if (type.includes("20")) return "max20";
	if (type === "max" || type.startsWith("max")) return "max5";
	if (type === "pro") return "pro";
	if (type === "free") return "free";
	if (type === "enterprise" || type === "team") return "max5";
	if (!type && parsed.apiProvider && parsed.apiProvider !== "firstParty") return "api";
	return "unknown";
}

function pct(value: unknown): number | null {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.min(100, Math.max(0, n));
}

/**
 * How much allowance is left. A user command wins; otherwise this package's own ledger
 * answers for the daily figure and admits to knowing nothing about the weekly ones.
 */
export async function readHeadroom(): Promise<Headroom> {
	const cfg = loadConfig();
	const command = cfg.llm.usageCommand?.trim();
	if (command) {
		const fromCommand = await runUsageCommand(command);
		if (fromCommand) return fromCommand;
	}

	// Only where the cap binds: on a subscription the dollars are notional, and reading them as
	// an allowance would step the model down for nothing.
	const budget = (await budgetBinds()) ? cfg.llm.dailyBudgetUsd : 0;
	if (budget > 0) {
		const left = Math.max(0, budget - spendTodayUsd());
		return {
			daily: Math.round((left / budget) * 100),
			weekly: null,
			fableWeekly: null,
			source: "claude-brain's own daily budget, since no usage command is configured",
		};
	}
	return { daily: null, weekly: null, fableWeekly: null, source: "nothing on this machine reports usage" };
}

async function runUsageCommand(command: string): Promise<Headroom | null> {
	try {
		const proc = Bun.spawn(["sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), USAGE_TIMEOUT_MS);
		const raw = await new Response(proc.stdout).text();
		await proc.exited;
		clearTimeout(timer);
		const used = JSON.parse(raw) as Record<string, unknown>;
		const left = (key: string, altKey: string): number | null => {
			const remaining = pct(used[altKey]);
			if (remaining !== null) return remaining;
			const spent = pct(used[key]);
			return spent === null ? null : 100 - spent;
		};
		return {
			daily: left("daily", "dailyRemaining"),
			weekly: left("weekly", "weeklyRemaining"),
			fableWeekly: left("fableWeekly", "fableWeeklyRemaining"),
			source: `usage command: ${command.slice(0, 60)}`,
		};
	} catch {
		// A command that does not exist, does not answer, or does not print JSON is the
		// same thing as no command — it must never stop a rebuild from happening.
		return null;
	}
}

/** Is there enough left to reach for the plan's best model? */
export function hasHeadroom(h: Headroom): boolean {
	if (h.daily !== null && h.daily < DAILY_FLOOR) return false;
	if (h.weekly !== null && h.weekly < WEEKLY_FLOOR) return false;
	if (h.fableWeekly !== null && h.fableWeekly < WEEKLY_FLOOR) return false;
	return true;
}

/** The ladder, as data. Index 0 is the plan's best; each next entry is one rung down. */
const LADDER: Record<Plan, Array<{ model: ClaudeModel; effort: Effort }>> = {
	max20: [
		{ model: "fable", effort: "medium" },
		{ model: "opus", effort: "medium" },
		{ model: "sonnet", effort: "medium" },
	],
	max5: [
		{ model: "opus", effort: "high" },
		{ model: "sonnet", effort: "medium" },
		{ model: "haiku", effort: "medium" },
	],
	pro: [
		{ model: "sonnet", effort: "medium" },
		{ model: "haiku", effort: "medium" },
	],
	free: [{ model: "haiku", effort: "medium" }],
	api: [{ model: "sonnet", effort: "medium" }],
	unknown: [{ model: "haiku", effort: "medium" }],
};

const PLAN_NAMES: Record<Plan, string> = {
	max20: "Max 20×",
	max5: "Max 5×",
	pro: "Pro",
	free: "the free tier",
	api: "an API key",
	unknown: "an unrecognised plan",
};

/**
 * Pick the model for a rebuild. `llm.autoModel` off pins it to whatever the user chose in
 * Settings, which is the escape hatch for anyone who wants the cheap model regardless.
 */
export async function chooseRecreateModel(): Promise<ModelChoice> {
	const cfg = loadConfig();
	if (!cfg.llm.autoModel) {
		return {
			model: cfg.llm.model,
			effort: "medium",
			plan: "unknown",
			why: `pinned to ${cfg.llm.model} in Settings`,
		};
	}

	const plan = await detectPlan();
	const rungs = LADDER[plan] ?? LADDER.unknown;
	const headroom = await readHeadroom();
	const roomy = hasHeadroom(headroom);
	const pick = (roomy ? rungs[0] : rungs[1] ?? rungs[0])!;

	const limits = [
		headroom.daily === null ? "" : `${headroom.daily}% of today left`,
		headroom.weekly === null ? "" : `${headroom.weekly}% of the week left`,
		headroom.fableWeekly === null ? "" : `${headroom.fableWeekly}% of the Fable week left`,
	].filter(Boolean);

	// The model is named by whatever prints this, so `why` is only the reason: the plan and
	// what was left of it.
	const why = roomy
		? `${PLAN_NAMES[plan]}${limits.length ? `, ${limits.join(", ")}` : ", with no usage figures to go on"}.`
		: `${PLAN_NAMES[plan]}, but ${limits.join(", ")}, so it stepped down.`;

	return { ...pick, plan, why };
}
