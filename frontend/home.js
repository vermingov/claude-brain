// Home: the brain in numbers, what it has been doing lately, and what it keeps running
// into. Everything on this page is a real figure from the index; nothing is decorative.

import { api, el, text } from "./ui.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ts, now = Date.now()) {
	const delta = Math.max(0, now - ts);
	if (delta < HOUR) return `${Math.max(1, Math.round(delta / MINUTE))} min ago`;
	if (delta < DAY) return `${Math.round(delta / HOUR)} h ago`;
	if (delta < 30 * DAY) return `${Math.round(delta / DAY)} d ago`;
	return `${Math.round(delta / (30 * DAY))} mo ago`;
}

function basename(path) {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** The sliding-border card, after xopc333 (Uiverse, MIT). */
function card(className) {
	const node = el("div", `card ${className ?? ""}`);
	node.innerHTML =
		'<svg class="card-border" aria-hidden="true"><line class="top" pathLength="1" x1="0" y1="0" x2="100%" y2="0"/><line class="right" pathLength="1" x1="100%" y1="0" x2="100%" y2="100%"/><line class="bottom" pathLength="1" x1="100%" y1="100%" x2="0" y2="100%"/><line class="left" pathLength="1" x1="0" y1="100%" x2="0" y2="0"/></svg>';
	return node;
}

function stat(label, value, detail) {
	const node = card("stat");
	node.appendChild(text("div", "stat-value", value.toLocaleString()));
	node.appendChild(text("div", "stat-label", label));
	if (detail) node.appendChild(text("div", "stat-detail", detail));
	return node;
}

function section(title, className) {
	const node = el("section", `home-section ${className ?? ""}`);
	node.appendChild(text("h2", null, title));
	return node;
}

/** Two bars a day: memories recorded, notes recalled. Heights are proportional to the busiest day. */
function activityChart(days) {
	const chart = el("div", "chart");
	const peak = Math.max(1, ...days.map((d) => Math.max(d.episodes, d.recalls)));
	for (const day of days) {
		const column = el("div", "chart-day");
		column.title = `${day.day}: ${day.episodes} memories, ${day.recalls} recalls`;
		const bars = el("div", "chart-bars");
		const episodes = el("span", "bar bar-episodes");
		episodes.style.height = `${(day.episodes / peak) * 100}%`;
		const recalls = el("span", "bar bar-recalls");
		recalls.style.height = `${(day.recalls / peak) * 100}%`;
		bars.append(episodes, recalls);
		column.appendChild(bars);
		column.appendChild(text("span", "chart-tick", day.day.slice(8)));
		chart.appendChild(column);
	}
	return chart;
}

export function createHomeTab(container, { openBrain }) {
	container.classList.add("home-tab");
	const wrap = el("div", "home-wrap");
	container.appendChild(wrap);

	function render(data) {
		wrap.innerHTML = "";
		if (data.error) {
			wrap.appendChild(text("p", "home-empty", data.error));
			return;
		}
		const { index } = data;
		const head = el("header", "home-head");
		head.appendChild(text("h1", null, "Your second brain"));
		head.appendChild(
			text(
				"p",
				"home-lede",
				index.docs
					? `${index.docs.toLocaleString()} notes indexed, ${index.episodes.toLocaleString()} moments remembered from ${index.sessions} sessions.`
					: "No notes indexed yet. Pick a vault in Settings and the brain fills itself in.",
			),
		);
		wrap.appendChild(head);

		const stats = el("div", "stat-grid");
		stats.append(
			stat("notes", index.docs, `${index.chunks.toLocaleString()} sections`),
			stat("synapses", index.edges, `${index.communities} clusters`),
			stat("memories", index.episodes, kindSummary(data.episodesByKind)),
			stat("sessions", index.sessions, index.recalls ? `${index.recalls.toLocaleString()} recalls made` : "no recalls yet"),
			stat(
				"embedded",
				index.embedded,
				index.vectors ? (index.pendingEmbed ? `${index.pendingEmbed} pending` : "every section") : "keyword search only",
			),
		);
		wrap.appendChild(stats);

		const columns = el("div", "home-columns");
		const left = el("div", "home-column");
		const right = el("div", "home-column");
		columns.append(left, right);
		wrap.appendChild(columns);

		if (data.directives?.length) {
			const rules = section("Standing instructions");
			rules.appendChild(
				text("p", "section-note", "Given in earlier sessions and put in front of every new one. The bar is how present each is now."),
			);
			const list = el("ul", "rule-list");
			for (const rule of data.directives) {
				const item = el("li");
				item.appendChild(text("span", "rule-text", rule.text));
				const meta = el("div", "rule-meta");
				const bar = el("span", "rule-bar");
				const fill = el("span", "rule-fill");
				// Activation is unbounded in principle; two is as strong as these get in practice.
				fill.style.width = `${Math.max(4, Math.min(100, ((rule.strength + 1) / 3) * 100))}%`;
				bar.appendChild(fill);
				meta.append(bar, text("span", "rule-status", `${rule.status} · said ${rule.statements}× · ${ago(rule.lastStated)}`));
				item.appendChild(meta);
				list.appendChild(item);
			}
			rules.appendChild(list);
			left.appendChild(rules);
		}

		const activity = section("Activity, last 14 days");
		activity.appendChild(activityChart(data.activity));
		activity.appendChild(
			el("p", "chart-key", '<span class="bar bar-episodes"></span> memories recorded <span class="bar bar-recalls"></span> notes recalled'),
		);
		left.appendChild(activity);

		const top = section("Most recalled notes");
		if (data.topNotes.length === 0) top.appendChild(text("p", "home-empty", "Nothing recalled yet."));
		const topList = el("ol", "note-list");
		for (const note of data.topNotes) {
			const item = el("li");
			const button = text("button", "note-link", note.title);
			button.type = "button";
			button.onclick = () => openBrain(note.path);
			item.appendChild(button);
			item.appendChild(text("span", "note-meta", `${note.accessCount}× · ${ago(note.lastAccess)}`));
			topList.appendChild(item);
		}
		top.appendChild(topList);
		left.appendChild(top);

		const themes = section("Keeps coming up");
		if (data.themes.length === 0) {
			themes.appendChild(
				text("p", "home-empty", "No theme has recurred across separate sessions yet. Consolidation checks after every session."),
			);
		}
		for (const theme of data.themes) {
			const item = card("theme");
			item.appendChild(text("p", "theme-text", theme.text));
			item.appendChild(text("p", "theme-meta", `${theme.kind} · ${theme.sessions} sessions · ${theme.occurrences} times · last ${ago(theme.lastSeen)}`));
			themes.appendChild(item);
		}
		right.appendChild(themes);

		const sessions = section("Recent sessions");
		if (data.recentSessions.length === 0) sessions.appendChild(text("p", "home-empty", "No sessions recorded yet."));
		const sessionList = el("ul", "session-list");
		for (const s of data.recentSessions) {
			const item = el("li");
			item.appendChild(text("span", "session-when", ago(s.ended ?? s.started)));
			const body = el("div", "session-body");
			body.appendChild(text("span", "session-cwd", basename(s.cwd) || "~"));
			body.appendChild(text("span", "session-summary", s.summary));
			item.appendChild(body);
			sessionList.appendChild(item);
		}
		sessions.appendChild(sessionList);
		right.appendChild(sessions);

		const clusters = section("Largest clusters");
		const clusterGrid = el("div", "cluster-grid");
		for (const c of data.clusters) {
			const item = card("cluster");
			item.appendChild(text("div", "cluster-label", c.label));
			item.appendChild(text("div", "cluster-size", `${c.size} notes`));
			clusterGrid.appendChild(item);
		}
		clusters.appendChild(clusterGrid);
		right.appendChild(clusters);
	}

	function kindSummary(byKind) {
		const parts = [];
		if (byKind.error) parts.push(`${byKind.error} failures`);
		if (byKind.outcome) parts.push(`${byKind.outcome} resolved`);
		if (byKind.decision || byKind.preference) parts.push(`${(byKind.decision ?? 0) + (byKind.preference ?? 0)} kept on purpose`);
		return parts.join(", ") || "prompts and summaries";
	}

	async function refresh() {
		render(await api("/api/overview"));
	}

	return {
		show() {
			refresh();
		},
		hide() {},
	};
}
