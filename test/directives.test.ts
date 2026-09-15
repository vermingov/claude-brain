// Procedural memory: what counts as a standing instruction, how strength accrues, which
// rules win the limited space a session can spare, and what happens when the user changes
// their mind.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureDirective,
	consolidate,
	cueOverlap,
	detectDirectives,
	listDirectives,
	markFired,
	retractDirective,
	selectDirectives,
	statedDirective,
	strengthOf,
} from "../src/directives";
import { openBrainDb } from "../src/index-db";

const dir = join(tmpdir(), `brain-directives-${process.pid}`);
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12);

beforeAll(() => {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	openBrainDb(join(dir, "index.sqlite"));
});
beforeEach(() => openBrainDb().db.run("DELETE FROM directives"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("what is a standing instruction", () => {
	const rule = (text: string) => detectDirectives(text).map((d) => d.text);

	test("an instruction meant to outlast the turn is caught", () => {
		expect(rule("always use the MCP for the vault")).toHaveLength(1);
		expect(rule("it should always use the MCP")).toHaveLength(1);
		expect(rule("never publish XRec to GitHub")).toHaveLength(1);
		expect(rule("AUR only, never GitHub")).toHaveLength(1);
		expect(rule("From now on, run the tests before committing.")).toHaveLength(1);
		expect(rule("Remember to update CHANGES.md when the API changes.")).toHaveLength(1);
		expect(rule("Don't ever force push to master")).toHaveLength(1);
		expect(rule("By default, use bun instead of npm")).toHaveLength(1);
		expect(rule("whenever you touch the shader, re-run the headless check")).toHaveLength(1);
	});

	test("a description of the world is not an instruction", () => {
		expect(rule("it always crashes when I open the settings tab")).toHaveLength(0);
		expect(rule("the build never finishes on this machine")).toHaveLength(0);
		expect(rule("my laptop always overheats during a reindex")).toHaveLength(0);
		expect(rule("does it always do that?")).toHaveLength(0);
		expect(rule("I never got the tailscale thing working")).toHaveLength(0);
		expect(rule("we always used to do it that way")).toHaveLength(0);
		expect(rule("fix the login bug")).toHaveLength(0);
	});

	test("one prompt can carry a rule among ordinary work", () => {
		const found = detectDirectives("Fix the failing test. Also, always run tsc before you commit.");
		expect(found).toHaveLength(1);
		expect(found[0]!.text).toContain("always run tsc");
		expect(found[0]!.status).toBe("stated");
	});

	test("the word joining it to the previous sentence is not part of the rule", () => {
		expect(rule("Ship it. Also, always run tsc first.")[0]).toBe("always run tsc first.");
		expect(rule("btw never force push")[0]).toBe("never force push");
		expect(rule("One more thing: always use bun")[0]).toBe("always use bun");
	});

	test("a prohibition is stored as one", () => {
		expect(detectDirectives("never deploy from a tag")[0]!.polarity).toBe("dont");
		expect(detectDirectives("always deploy from main")[0]!.polarity).toBe("do");
	});

	test("a rule about this place is scoped to it", () => {
		expect(detectDirectives("in this project, always use tabs")[0]!.scope).toBe("cwd");
		expect(detectDirectives("always use tabs")[0]!.scope).toBe("global");
	});
});

describe("strength", () => {
	const row = (over: Partial<Parameters<typeof strengthOf>[0]> = {}) => ({
		statements: 1,
		last_stated: NOW - DAY,
		status: "stated",
		fire_count: 0,
		stated_at: String(NOW - DAY),
		...over,
	});

	test("fades while it is not repeated", () => {
		const fresh = strengthOf(row({ last_stated: NOW - DAY, stated_at: String(NOW - DAY) }), NOW);
		const old = strengthOf(row({ last_stated: NOW - 60 * DAY, stated_at: String(NOW - 60 * DAY) }), NOW);
		expect(old).toBeLessThan(fresh);
	});

	test("saying it again on a later day beats saying it twice in a minute", () => {
		const spaced = strengthOf(row({ statements: 2, stated_at: `${NOW - 20 * DAY},${NOW - DAY}`, last_stated: NOW - DAY }), NOW);
		const massed = strengthOf(row({ statements: 2, stated_at: `${NOW - DAY - 60_000},${NOW - DAY}`, last_stated: NOW - DAY }), NOW);
		// Measured a month later, when the spacing effect is the whole point.
		const later = NOW + 30 * DAY;
		const spacedLater = strengthOf(row({ statements: 2, stated_at: `${NOW - 20 * DAY},${NOW - DAY}`, last_stated: NOW - DAY }), later);
		const massedLater = strengthOf(row({ statements: 2, stated_at: `${NOW - DAY - 60_000},${NOW - DAY}`, last_stated: NOW - DAY }), later);
		expect(spacedLater).toBeGreaterThan(massedLater);
		expect(spaced).toBeGreaterThan(0);
		expect(massed).toBeGreaterThan(0);
	});

	test("an inferred rule carries less weight than a stated one", () => {
		expect(strengthOf(row({ status: "provisional" }), NOW)).toBeLessThan(strengthOf(row({ status: "stated" }), NOW));
	});

	test("a consolidated rule stops fading", () => {
		const ancient = { ...row({ status: "consolidated", last_stated: NOW - 400 * DAY, stated_at: String(NOW - 400 * DAY) }) };
		expect(strengthOf(ancient, NOW)).toBeGreaterThanOrEqual(0.5);
	});
});

describe("capture", () => {
	test("repeating a rule strengthens it rather than duplicating it", () => {
		const first = captureDirective(statedDirective("always run tsc before committing"), "s1", "/w", NOW);
		const second = captureDirective(statedDirective("always run tsc before committing"), "s2", "/w", NOW + 2 * DAY);
		expect(second.reinforced).toBe(true);
		expect(second.directive.id).toBe(first.directive.id);
		expect(second.directive.statements).toBe(2);
		expect(second.directive.strength).toBeGreaterThan(first.directive.strength);
		expect(listDirectives(NOW + 2 * DAY)).toHaveLength(1);
	});

	test("changing your mind replaces the old rule instead of leaving both", () => {
		const before = captureDirective(statedDirective("never deploy from main"), "s1", "/w", NOW);
		const after = captureDirective(statedDirective("always deploy from main"), "s2", "/w", NOW + DAY);
		expect(after.superseded?.id).toBe(before.directive.id);
		const live = listDirectives(NOW + DAY);
		expect(live).toHaveLength(1);
		expect(live[0]!.text).toBe("always deploy from main");
		// The old one is out of the running entirely: a superseded rule that can still be
		// retrieved is a rule that will intrude.
		expect(selectDirectives({ now: NOW + DAY }).map((d) => d.text)).toEqual(["always deploy from main"]);
	});

	test("the same rule in different words is the same rule", () => {
		const first = captureDirective(statedDirective("never publish xrec to github, AUR only"), "s1", "/w", NOW);
		const again = captureDirective(statedDirective("remember: xrec goes to the AUR, never to github"), "s2", "/w", NOW + DAY);
		expect(again.reinforced).toBe(true);
		expect(again.directive.id).toBe(first.directive.id);
	});

	test("punctuation and hyphens do not split a rule in two", () => {
		const first = captureDirective(statedDirective("never force push to master."), "s1", "/w", NOW);
		const restated = statedDirective("remember never to force-push master, it breaks everyone");
		const again = captureDirective(restated, "s2", "/w", NOW + DAY);
		expect(again.reinforced).toBe(true);
		expect(again.directive.id).toBe(first.directive.id);
	});

	test("two rules that differ in their subject stay apart, however alike they read", () => {
		captureDirective(statedDirective("always run tsc before committing"), "s1", "/w", NOW);
		captureDirective(statedDirective("always run eslint before committing"), "s1", "/w", NOW);
		expect(listDirectives(NOW)).toHaveLength(2);
	});

	test("changing your mind back is allowed, however often", () => {
		const texts = ["always deploy from a tag", "never deploy from a tag", "always deploy from a tag"];
		const ids = texts.map((text, turn) => captureDirective(statedDirective(text), `s${turn}`, "/w", NOW + turn * DAY).directive.id);
		expect(new Set(ids).size).toBe(3);
		const live = listDirectives(NOW + 3 * DAY);
		expect(live).toHaveLength(1);
		expect(live[0]!.text).toBe("always deploy from a tag");
	});

	test("a rule about something else is left alone", () => {
		captureDirective(statedDirective("never deploy from main"), "s1", "/w", NOW);
		captureDirective(statedDirective("always write tests for new endpoints"), "s1", "/w", NOW);
		expect(listDirectives(NOW)).toHaveLength(2);
	});

	test("the wording is rewritten in place when it is restated", () => {
		const first = captureDirective(statedDirective("always run tsc before committing"), "s1", "/w", NOW);
		const again = captureDirective(statedDirective("always run tsc before committing, no exceptions"), "s2", "/w", NOW + DAY);
		expect(again.directive.id).toBe(first.directive.id);
		expect(again.directive.text).toContain("no exceptions");
	});
});

describe("competition for the space a session can spare", () => {
	test("the strongest win, and the budget is respected", () => {
		const rules = [
			"always run tsc before committing",
			"never force push to master",
			"always update the changelog",
			"never deploy on a Friday",
			"always squash before merging",
			"never leave a failing test",
			"always ask before deleting notes",
			"never publish that repository",
			"always use tabs in this codebase",
		];
		rules.forEach((rule, i) => captureDirective(statedDirective(rule), `s${i}`, "/w", NOW - i * DAY));
		const chosen = selectDirectives({ now: NOW });
		expect(chosen.length).toBeLessThanOrEqual(4);
		for (let i = 1; i < chosen.length; i++) expect(chosen[i - 1]!.strength).toBeGreaterThanOrEqual(chosen[i]!.strength);
	});

	test("a rule about what is being asked comes forward", () => {
		captureDirective(statedDirective("always run the headless check after touching a shader"), "s1", "/w", NOW - 30 * DAY);
		for (const other of [
			"always keep the changelog current",
			"always squash before merging",
			"never commit secrets",
			"always prefer bun over npm",
			"always write tests for new endpoints",
		]) {
			captureDirective(statedDirective(other), "s2", "/w", NOW);
		}
		const withoutCue = selectDirectives({ now: NOW }).map((d) => d.text);
		const withCue = selectDirectives({ now: NOW, prompt: "I changed the shader, can you check it" }).map((d) => d.text);
		expect(withoutCue.some((t) => t.includes("shader"))).toBe(false);
		expect(withCue.some((t) => t.includes("shader"))).toBe(true);
	});

	test("a rule for another directory stays there", () => {
		captureDirective({ ...statedDirective("always use tabs"), scope: "cwd" }, "s1", "/projects/a", NOW);
		expect(selectDirectives({ now: NOW, cwd: "/projects/a" })).toHaveLength(1);
		expect(selectDirectives({ now: NOW, cwd: "/projects/b" })).toHaveLength(0);
	});

	test("an inferred rule is not handed to every session, only to the one it fits", () => {
		captureDirective({ ...statedDirective("prefer ripgrep instead of grep"), status: "provisional" }, "s1", "/w", NOW);
		expect(selectDirectives({ now: NOW })).toHaveLength(0);
		expect(selectDirectives({ now: NOW, prompt: "search the repo with ripgrep" })).toHaveLength(1);
	});

	test("what is dropped stays dropped", () => {
		const captured = captureDirective(statedDirective("always use tabs"), "s1", "/w", NOW);
		expect(retractDirective(captured.directive.id)).toBe(true);
		expect(selectDirectives({ now: NOW })).toHaveLength(0);
		expect(retractDirective(captured.directive.id)).toBe(false);
	});
});

describe("the slow store", () => {
	test("a rule held across sessions is promoted; a fresh one waits", () => {
		captureDirective(statedDirective("always run tsc before committing"), "s1", "/w", NOW - 5 * DAY);
		captureDirective(statedDirective("always run tsc before committing"), "s2", "/w", NOW - DAY);
		captureDirective(statedDirective("always squash before merging"), "s3", "/w", NOW);
		const promoted = consolidate(NOW).map((d) => d.text);
		expect(promoted).toContain("always run tsc before committing");
		expect(promoted).not.toContain("always squash before merging");
	});

	test("age alone does not promote a rule nobody ever used", () => {
		captureDirective(statedDirective("always squash before merging"), "s1", "/w", NOW - 10 * DAY);
		expect(consolidate(NOW).map((d) => d.text)).not.toContain("always squash before merging");
	});

	test("a rule a session was handed, and did not have withdrawn, is promoted", () => {
		const rule = captureDirective(statedDirective("always squash before merging"), "s1", "/w", NOW - 10 * DAY);
		markFired([rule.directive.id], NOW - 9 * DAY);
		expect(consolidate(NOW).map((d) => d.text)).toContain("always squash before merging");
	});

	test("cue overlap is what makes two rules about the same thing", () => {
		expect(cueOverlap(["deploy", "main"], ["deploy", "main", "branch"])).toBeGreaterThan(0.9);
		expect(cueOverlap(["deploy", "main"], ["tabs", "indent"])).toBe(0);
	});
});
