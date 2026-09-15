// The note reader: the note a viewer opened, rendered from its markdown, with what it
// is connected to. Vault-local content, so a small line-based renderer is enough.

function escapeHtml(s) {
	return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderMarkdown(md) {
	const lines = escapeHtml(md).split("\n");
	const out = [];
	let inCode = false;
	for (const line of lines) {
		if (line.startsWith("```")) {
			out.push(inCode ? "</code></pre>" : '<pre class="md-code"><code>');
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			out.push(`${line}\n`);
			continue;
		}
		const html = line
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => `<span class="wl">${alias ?? target}</span>`)
			.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/`([^`]+)`/g, "<code>$1</code>");
		if (/^#{3,4}\s/.test(html)) out.push(`<h5>${html.replace(/^#+\s/, "")}</h5>`);
		else if (/^#{1,2}\s/.test(html)) out.push(`<h4>${html.replace(/^#+\s/, "")}</h4>`);
		else if (/^\s*-\s/.test(html)) out.push(`<div class="md-li">${html.replace(/^\s*-\s/, "")}</div>`);
		else if (html.trim() === "") out.push('<div class="md-gap"></div>');
		else out.push(`<p>${html}</p>`);
	}
	if (inCode) out.push("</code></pre>");
	return out.join("");
}

const CLOSE_ICON =
	'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

/**
 * @param {HTMLElement} container
 * @param {object} graph
 * @param {{ onNavigate: (index: number) => void, onClose: () => void }} handlers
 */
export function createPanel(container, graph, handlers) {
	const panel = document.createElement("aside");
	panel.className = "brain-panel";
	container.appendChild(panel);
	const indexByPath = new Map(graph.nodes.map((n, i) => [n.id, i]));
	const categoryById = new Map(graph.categories.map((c) => [c.id, c]));
	const communityById = new Map(graph.communities.map((c) => [c.id, c]));

	function facts(node) {
		const parts = [];
		if (node.date) parts.push(node.date);
		parts.push(`${node.connections} connection${node.connections === 1 ? "" : "s"}`);
		const community = node.community !== null ? communityById.get(node.community) : null;
		if (community && community.size > 1) parts.push(`cluster: ${community.label}`);
		return parts.map(escapeHtml).join(" · ");
	}

	function open(index) {
		const node = graph.nodes[index];
		panel.classList.add("open");
		panel.innerHTML = '<div class="panel-loading">reading note</div>';
		fetch(`/api/note?path=${encodeURIComponent(node.id)}`)
			.then((r) => r.json())
			.then((data) => {
				if (data.error) {
					panel.innerHTML = `<div class="panel-error">${escapeHtml(data.error)}</div>`;
					return;
				}
				const lobe = categoryById.get(node.category);
				const linked = (data.backlinks ?? [])
					.map((path) => indexByPath.get(path))
					.filter((i) => i !== undefined)
					.map((i) => {
						const n = graph.nodes[i];
						const c = categoryById.get(n.category);
						return `<li data-index="${i}"><span class="dot" style="--c:${c?.color}"></span>${escapeHtml(n.title)}</li>`;
					})
					.join("");
				panel.innerHTML = `
					<div class="panel-inner">
						<button class="panel-close" aria-label="Close">${CLOSE_ICON}</button>
						<div class="panel-lobe"><span class="dot" style="--c:${lobe?.color}"></span>${escapeHtml(lobe?.label ?? node.category)}</div>
						<h2>${escapeHtml(data.node.title)}</h2>
						<p class="panel-facts">${facts(data.node)}</p>
						${data.node.tags?.length ? `<p class="panel-tags">${data.node.tags.map(escapeHtml).join(", ")}</p>` : ""}
						<div class="panel-content">${renderMarkdown(data.content.slice(0, 12000))}</div>
						${linked ? `<h3 class="panel-section">Connected memories</h3><ul class="backlinks">${linked}</ul>` : ""}
						<p class="panel-path">${escapeHtml(node.id)}</p>
					</div>`;
				panel.querySelector(".panel-close").onclick = handlers.onClose;
				for (const li of panel.querySelectorAll(".backlinks li")) {
					li.onclick = () => handlers.onNavigate(Number(li.dataset.index));
				}
			});
	}

	function close() {
		panel.classList.remove("open");
	}

	return {
		open,
		close,
		isOpen: () => panel.classList.contains("open"),
		dispose: () => panel.remove(),
	};
}
