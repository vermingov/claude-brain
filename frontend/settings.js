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
	 * Switch styling adapted from Uiverse (alfoly1988, MIT).
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

		const providers = el("div", "sync-providers");
		for (const p of PROVIDERS) {
			const b = el("button", `settings-btn ${sync.provider === p.id ? "primary" : "ghost"}`, p.label);
			b.onclick = async () => {
				await api("/api/sync/config", { provider: p.id });
				await refresh();
			};
			providers.appendChild(b);
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
