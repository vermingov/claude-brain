// Settings tab: vault selection, cloud sync, Claude Code integration, image
// description, index health.

function el(tag, className, html) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (html !== undefined) node.innerHTML = html;
	return node;
}

function escapeHtml(s) {
	return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function api(path, body) {
	const res = await fetch(path, body === undefined
		? undefined
		: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return res.json();
}

const PROVIDERS = [
	{ id: "dropbox", label: "Dropbox" },
	{ id: "gdrive", label: "Google Drive" },
	{ id: "mega", label: "MEGA" },
];

export function createSettingsTab(container) {
	container.classList.add("settings-tab");
	const wrap = el("div", "settings-wrap");
	container.appendChild(wrap);

	let status = null;

	async function refresh() {
		status = await api("/api/status");
		render();
	}

	function section(title, subtitle) {
		const s = el("section", "settings-section");
		s.appendChild(el("h3", null, title));
		if (subtitle) s.appendChild(el("p", "settings-sub", subtitle));
		return s;
	}

	/**
	 * An on/off control that reads as one: a switch, not a button whose label flips.
	 * The squish switch, after elijahgummer (Uiverse, MIT).
	 */
	function toggle(label, checked, onChange) {
		const wrap = el("label", "switch");
		const input = el("input");
		input.type = "checkbox";
		input.checked = checked;
		input.onchange = async () => {
			input.disabled = true;
			await onChange(input.checked);
		};
		wrap.append(input, el("span", "switch-track"), el("span", "switch-label", label));
		return wrap;
	}

	function render() {
		wrap.innerHTML = "";
		renderVault();
		renderSync();
		renderIntegration();
		renderLlm();
		renderRecreate();
		renderIndex();
	}

	// --- Vault ---------------------------------------------------------------

	function renderVault() {
		const s = section(
			"Brain location",
			"Your brain is a folder of markdown notes on your disk. Point it at an existing Obsidian vault or any directory. A new brain grows from an empty folder too.",
		);

		if (status.vault) {
			s.appendChild(
				el("div", `vault-current ${status.vaultReady ? "ok" : "warn"}`,
					`<span class="dot"></span><code>${escapeHtml(status.vault)}</code>` +
					(status.vaultReady ? "" : '<span class="vault-missing">not accessible right now</span>')),
			);
		} else {
			s.appendChild(el("div", "vault-current warn", '<span class="dot"></span>No vault selected yet. Pick one below.'));
		}

		const picker = el("div", "vault-picker");
		const input = el("input", "settings-input");
		input.type = "text";
		input.placeholder = "/path/to/your/vault";
		input.value = status.vault ?? "";
		const apply = el("button", "settings-btn primary", "Use this folder");
		apply.onclick = async () => {
			apply.disabled = true;
			const out = await api("/api/config", { vault: input.value.trim() });
			if (out.error) {
				apply.disabled = false;
				alert(out.error);
				return;
			}
			await refresh();
		};
		picker.append(input, apply);
		s.appendChild(picker);

		const detectedWrap = el("div", "vault-detected");
		s.appendChild(detectedWrap);
		api("/api/vaults").then(({ vaults }) => {
			if (!vaults?.length) return;
			detectedWrap.appendChild(el("div", "settings-sub", "Detected Obsidian vaults:"));
			for (const v of vaults) {
				const b = el("button", "settings-btn ghost vault-suggestion", escapeHtml(v));
				b.onclick = () => {
					input.value = v;
				};
				detectedWrap.appendChild(b);
			}
		});

		wrap.appendChild(s);
	}

	// --- Sync ----------------------------------------------------------------

	function renderSync() {
		const s = section(
			"Cloud sync",
			"One-way mirror of your vault to your own cloud account (your machine stays the source of truth; remote deletions land in a dated trash folder). Runs on an interval and shortly after you edit notes.",
		);
		const sync = status.sync;

		// A radio pill with a growing underline, after 3bdel3ziz-T (Uiverse, MIT).
		const providers = el("div", "radio-pill");
		for (const p of PROVIDERS) {
			const label = el("label", "radio-item");
			const input = el("input");
			input.type = "radio";
			input.name = "provider";
			input.checked = sync.provider === p.id;
			input.onchange = async () => {
				await api("/api/sync/config", { provider: p.id });
				await refresh();
			};
			label.append(input, el("span", null, p.label));
			providers.appendChild(label);
		}
		s.appendChild(providers);

		if (sync.provider && !sync.remoteConfigured) {
			s.appendChild(
				el("div", "sync-hint warn",
					`Account not connected yet. Run <code>claude-brain sync setup ${sync.provider}</code> in a terminal: ` +
					"it opens the provider's own sign-in, and the credentials go to rclone on your machine, nowhere else."),
			);
		}

		const controls = el("div", "sync-controls");
		const now = el("button", "settings-btn ghost", sync.running ? "Syncing…" : "Sync now");
		now.disabled = sync.running || !sync.remoteConfigured;
		now.onclick = async () => {
			await api("/api/sync/now", {});
			setTimeout(refresh, 1500);
		};
		controls.append(
			toggle("Sync automatically", sync.enabled, async (enabled) => {
				await api("/api/sync/config", { enabled });
				await refresh();
			}),
			now,
		);
		s.appendChild(controls);

		if (sync.lastSync) {
			s.appendChild(el("div", "settings-sub",
				`Last sync: ${escapeHtml(sync.lastSync)}, ${sync.lastResult === "ok" ? "ok" : "failed"}`));
		}
		if (sync.log?.length) {
			s.appendChild(el("pre", "sync-log", sync.log.map(escapeHtml).join("\n")));
		}
		wrap.appendChild(s);
	}

	// --- Claude Code integration --------------------------------------------

	const INTEGRATION_PARTS = [
		["mcp", "MCP server, so Claude Code calls recall and the other verbs as tools"],
		["hook", "Session hooks: orient at start, cue memory per prompt, consolidate at end"],
		["claudeMd", "Recall-first instructions in CLAUDE.md"],
		["skill", "Recording skill, so sessions write what they learned back into the vault"],
	];

	function renderIntegration() {
		const s = section(
			"Claude Code",
			"The daemon wires itself in whenever it starts, so this is normally already done. Removing it here is remembered: the daemon stays out until you integrate again.",
		);
		const i = status.integration;
		const all = INTEGRATION_PARTS.every(([key]) => i[key]);
		const list = el("ul", "integration-status");
		for (const [key, label] of INTEGRATION_PARTS) {
			list.appendChild(el("li", i[key] ? "ok" : "missing", `<span class="mark"></span>${escapeHtml(label)}`));
		}
		s.appendChild(list);

		const btn = el("button", `settings-btn ${all ? "ghost" : "primary"}`,
			all ? "Remove integration" : "Integrate with Claude Code");
		btn.onclick = async () => {
			await api(all ? "/api/integrate/remove" : "/api/integrate", {});
			await refresh();
		};
		s.appendChild(btn);
		wrap.appendChild(s);
	}

	// --- Image description ---------------------------------------------------

	// The design library says "Turn Claude on in Settings" when this is off. That
	// sentence had nowhere to point: there was no control here, and /api/config
	// only accepted a vault path — so the only way to switch it on was editing
	// config.json by hand. This is that control.

	const LLM_TROUBLE = {
		"not-installed": "The claude CLI is not on PATH, so images are stored but not described.",
		"not-logged-in": "The claude CLI is not signed in. Run <code>claude</code> in a terminal once to log in.",
		"too-old": "The installed claude CLI is too old to read images. Update it and check again.",
	};

	function renderLlm() {
		const llm = status.llm;
		// Older server, newer page: say so instead of throwing on undefined.
		if (!llm) return;
		const s = section(
			"Image description",
			"Screenshots and mockups you add to the design library get read once and turned into " +
			"notes. The reading is done by the claude CLI already installed on this machine, so " +
			"your images never leave it. The brain uploads nothing, here or anywhere else.",
		);

		s.appendChild(
			toggle("Describe images with my Claude CLI", llm.enabled, async (enabled) => {
				const res = await api("/api/config", { llm: { enabled } });
				if (res.error) {
					s.appendChild(el("div", "sync-hint warn", escapeHtml(res.error)));
					await refresh();
					return;
				}
				await refresh();
			}),
		);

		if (llm.enabled) {
			if (llm.available) {
				const who = [llm.account, llm.version && `CLI ${llm.version}`].filter(Boolean).join(" · ");
				s.appendChild(el("div", "vault-current ok",
					`<span class="dot"></span>Ready${who ? `, ${escapeHtml(who)}` : ""}`));
			} else {
				s.appendChild(el("div", "sync-hint warn",
					LLM_TROUBLE[llm.reason] ?? "Claude is not usable right now; images are stored but not described."));
			}
		} else {
			s.appendChild(el("p", "settings-sub",
				"While this is off, images are still stored and searchable by name and caption. " +
				"They just have no description attached."));
		}
		wrap.appendChild(s);
	}

	// --- Rebuilding captured sites -------------------------------------------

	const PLANS = [
		["auto", "Detect from my Claude login"],
		["max20", "Max 20×"],
		["max5", "Max 5×"],
		["pro", "Pro"],
		["free", "Free"],
		["api", "API key"],
	];

	/**
	 * The one part of the brain that spends real money on a good model, so it says out
	 * loud what it would use and why. Everything here is off the record otherwise: which
	 * plan was detected, what headroom it thinks there is, which model that adds up to.
	 */
	function renderRecreate() {
		const r = status.recreate;
		if (!r) return;
		const s = section(
			"Rebuilding captured sites",
			"Capturing a URL reads the page's own code. The brain then builds the page again from " +
			"that code, using its tokens, its components and its motion, renders the copy and scores " +
			"it against a photograph of the original. The score says whether the design was " +
			"understood. The copy is what anything you build in that style starts from.",
		);

		s.appendChild(
			toggle("Rebuild pages I capture", r.enabled, async (recreate) => {
				await api("/api/config", { designs: { recreate } });
				await refresh();
			}),
		);

		if (!r.browser) {
			s.appendChild(el("div", "sync-hint warn",
				"No Chromium-based browser was found on this machine, so pages cannot be opened, " +
				"photographed or compared. Install chromium, or point CLAUDE_BRAIN_BROWSER at one."));
		}

		if (r.enabled && r.browser) {
			const rounds = el("div", "settings-row");
			rounds.appendChild(el("label", "settings-label", "Attempts per rebuild"));
			const input = el("input", "settings-input settings-input-narrow");
			input.type = "number";
			input.min = "1";
			input.max = "4";
			input.value = String(r.rounds ?? 2);
			input.onchange = async () => {
				await api("/api/config", { designs: { recreateRounds: Number(input.value) || 1 } });
				await refresh();
			};
			rounds.appendChild(input);
			s.appendChild(rounds);
			s.appendChild(el("p", "settings-sub",
				"Each attempt is one call. The model sees its own last try next to the photograph and " +
				"corrects it. Whichever attempt scores best is the one kept."));

			s.appendChild(
				toggle("Let the rebuild load web fonts while it renders", r.network, async (recreateNetwork) => {
					await api("/api/config", { designs: { recreateNetwork } });
					await refresh();
				}),
			);
		}

		if (r.model) {
			s.appendChild(el("div", "vault-current ok",
				`<span class="dot"></span>${escapeHtml(r.model)}. ${escapeHtml(r.why ?? "")}`));
		}

		// The one thing people ask when a job says it stopped for money: whose money, and why.
		s.appendChild(el("p", "settings-sub",
			"Every call goes through the <code>claude</code> CLI on this machine, so it is your own " +
			"Claude account doing the work. On Pro or Max nothing is billed per call — the cost the " +
			"CLI reports is what those tokens would have cost on the API — so this brain's own daily " +
			"cap (<code>llm.dailyBudgetUsd</code>) applies to an API key only, and is off by default."));

		const plan = el("div", "settings-row");
		plan.appendChild(el("label", "settings-label", "Claude plan"));
		const select = el("select", "settings-input settings-input-narrow");
		for (const [value, label] of PLANS) {
			const option = el("option", null, escapeHtml(label));
			option.value = value;
			if ((status.llm?.plan ?? "auto") === value) option.selected = true;
			select.appendChild(option);
		}
		select.onchange = async () => {
			await api("/api/config", { llm: { plan: select.value } });
			await refresh();
		};
		plan.appendChild(select);
		s.appendChild(plan);
		s.appendChild(el("p", "settings-sub",
			"The Claude CLI reports a Max subscription without saying whether it is the 5× or the 20× " +
			"plan, so pick it here once if you are on 20×. Pro gets Sonnet, Max 5× gets Opus at high " +
			"effort, Max 20× gets Fable."));

		s.appendChild(
			toggle("Pick the model from my plan", status.llm?.autoModel !== false, async (autoModel) => {
				await api("/api/config", { llm: { autoModel } });
				await refresh();
			}),
		);

		const usage = el("div", "settings-row");
		usage.appendChild(el("label", "settings-label", "Usage command"));
		const usageInput = el("input", "settings-input");
		usageInput.type = "text";
		usageInput.placeholder = 'prints {"daily":40,"weekly":25,"fableWeekly":10} as percent used';
		usageInput.value = status.llm?.usageCommand ?? "";
		usageInput.onchange = async () => {
			await api("/api/config", { llm: { usageCommand: usageInput.value.trim() } });
			await refresh();
		};
		usage.appendChild(usageInput);
		s.appendChild(usage);
		s.appendChild(el("p", "settings-sub",
			"Nothing on this machine publishes your live rate limits, so the brain cannot see them. " +
			"Point this at anything that prints them and it steps down to a cheaper model when you " +
			"are running low: below 60% of the day, or below 50% of either weekly allowance. Left " +
			"empty, it goes by its own daily cap, which on a subscription is not a limit at all." +
			(r.headroom?.source ? ` Currently: ${escapeHtml(r.headroom.source)}.` : "")));

		wrap.appendChild(s);
	}

	// --- Index health --------------------------------------------------------

	function renderIndex() {
		const s = section("Index", null);
		const idx = status.index;
		const facts = [
			`${idx.docs} notes in ${idx.chunks} sections`,
			idx.vectors ? `${idx.embedded} embedded${idx.pendingEmbed ? `, ${idx.pendingEmbed} pending` : ""}` : "keyword search only, embeddings unavailable",
			`${idx.episodes} episodes from ${idx.sessions} sessions`,
			`${idx.edges} edges in ${idx.communities} clusters`,
		];
		s.appendChild(el("p", "index-stats", facts.map(escapeHtml).join(" · ")));
		const re = el("button", "settings-btn ghost", "Reindex now");
		re.onclick = async () => {
			re.disabled = true;
			await api("/api/reindex", {});
			await refresh();
		};
		s.appendChild(re);
		wrap.appendChild(s);
	}

	refresh();
	return {
		show() {
			refresh();
		},
		hide() {},
	};
}
