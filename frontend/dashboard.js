import { createBrainTab } from "./brain.js";
import { createDesignsTab } from "./designs.js";
import { createHomeTab } from "./home.js";
import { createSettingsTab } from "./settings.js";
import { el, text } from "./ui.js";

// Tab registry. Controllers are created lazily on first activation.
const TABS = [
	{ id: "home", label: "Home", make: createHomeTab },
	{ id: "brain", label: "Brain", make: createBrainTab },
	{ id: "designs", label: "Designs", make: createDesignsTab },
	{ id: "settings", label: "Settings", make: createSettingsTab },
];

const WORDMARK =
	'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="7" cy="8" r="3" fill="currentColor"/><circle cx="17" cy="6.5" r="2.2" fill="currentColor" opacity=".7"/><circle cx="15.5" cy="17" r="2.6" fill="currentColor" opacity=".85"/><path d="M9.4 9.6l4.5 5.8M9.6 8l5-1M14 8.6l1.2 5.8" stroke="currentColor" stroke-width="1.1" opacity=".5"/></svg>';

// An upgrade leaves the old server serving the new dashboard, so the page calls
// routes that version does not have and shows a bare "request failed (404)". The
// server can see the mismatch (what booted vs what is on disk now); surface it
// once, globally, because it breaks every tab rather than any particular one.
function staleBanner(status) {
	if (!status?.stale) return null;
	return text(
		"div",
		"stale-banner",
		`claude-brain ${status.installedVersion} is installed but version ${status.version} is still running. ` +
			"Restart it so the dashboard and the server agree:  systemctl --user restart claude-brain",
	);
}

function build() {
	const app = document.getElementById("app");
	app.innerHTML = "";

	const bar = el("header", "topbar");
	const brand = el("div", "brand", `${WORDMARK}<span>claude-brain</span>`);
	// Navigation is a radio group with a growing underline, after 3bdel3ziz-T (Uiverse, MIT).
	const nav = el("nav", "nav");
	const health = el("div", "health");
	bar.append(brand, nav, health);

	const view = el("main", "view");
	app.append(bar, view);

	const inputs = {};
	const panels = {};
	const controllers = {};
	let active = null;

	for (const tab of TABS) {
		const label = el("label", "nav-item");
		const input = el("input");
		input.type = "radio";
		input.name = "tab";
		input.value = tab.id;
		input.onchange = () => activate(tab.id);
		label.append(input, text("span", null, tab.label));
		nav.appendChild(label);
		inputs[tab.id] = input;

		const panel = el("section", "tab-panel");
		panel.dataset.tab = tab.id;
		view.appendChild(panel);
		panels[tab.id] = panel;
	}

	const handlers = {
		openBrain(path) {
			activate("brain");
			controllers.brain.open?.(path);
		},
	};

	function activate(id) {
		if (active === id) return;
		if (active) {
			controllers[active]?.hide?.();
			panels[active].classList.remove("active");
		}
		if (!controllers[id]) controllers[id] = TABS.find((t) => t.id === id).make(panels[id], handlers);
		panels[id].classList.add("active");
		inputs[id].checked = true;
		controllers[id].show?.();
		active = id;
		history.replaceState(null, "", `#${id}`);
	}

	function renderHealth(status) {
		health.innerHTML = "";
		const dot = el("span", `health-dot ${status?.vaultReady ? "ok" : "warn"}`);
		const label = text(
			"span",
			null,
			status?.vault ? (status.vaultReady ? status.vault.split("/").filter(Boolean).pop() : "vault not reachable") : "no vault yet",
		);
		health.append(dot, label);
	}

	// First run (no vault yet) lands on Settings so the user picks a location.
	const fromHash = TABS.some((t) => `#${t.id}` === location.hash) ? location.hash.slice(1) : null;
	fetch("/api/status")
		.then((r) => r.json())
		.then((status) => {
			renderHealth(status);
			const banner = staleBanner(status);
			if (banner) app.prepend(banner);
			activate(fromHash ?? (status.vault ? "home" : "settings"));
		})
		.catch(() => {
			renderHealth(null);
			activate(fromHash ?? "home");
		});

	const boot = document.getElementById("boot");
	if (boot) {
		boot.classList.add("done");
		setTimeout(() => boot.remove(), 500);
	}
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
else build();
