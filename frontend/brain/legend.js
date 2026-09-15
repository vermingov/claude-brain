// Filters: which lobes are shown, and which kinds of synapse. Each row's dot is the
// checkbox itself, after catraco's bursting checkmark (Uiverse, MIT), filled with the
// lobe's colour. Counts are the real numbers behind each row.

const KINDS = [
	{ id: "wikilink", label: "Wikilinks", on: true },
	{ id: "cooccur", label: "Recalled together", on: true },
	{ id: "timeline", label: "Timeline", on: true },
	{ id: "semantic", label: "Similar wording", on: true },
	{ id: "tag", label: "Shared tags", on: false },
];

const BURST =
	'<svg class="burst" viewBox="0 0 50 50" aria-hidden="true"><polygon points="0,0 10,10"/><polygon points="0,25 10,25"/><polygon points="0,50 10,40"/><polygon points="50,0 40,10"/><polygon points="50,25 40,25"/><polygon points="50,50 40,40"/></svg>';

export function createLegend(element, graph, handlers) {
	const counts = new Map();
	for (const n of graph.nodes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
	const kindCounts = new Map();
	for (const e of graph.edges) kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);

	const row = (name, value, label, count, color, on) =>
		`<label class="legend-item"${color ? ` style="--c:${color}"` : ""}>
			<span class="check"><input type="checkbox" ${on ? "checked" : ""} data-${name}="${value}" /><span class="mark"></span>${BURST}</span>
			<span class="legend-label">${label}</span><span class="legend-count">${count}</span>
		</label>`;

	element.innerHTML =
		`<div class="legend-group"><h4>Lobes</h4>${graph.categories
			.filter((c) => (counts.get(c.id) ?? 0) > 0)
			.map((c) => row("category", c.id, c.label, counts.get(c.id), c.color, true))
			.join("")}</div>` +
		`<div class="legend-group"><h4>Synapses</h4>${KINDS.filter((k) => kindCounts.has(k.id))
			.map((k) => row("kind", k.id, k.label, kindCounts.get(k.id), null, k.on))
			.join("")}</div>`;

	for (const input of element.querySelectorAll("input[data-category]")) {
		input.onchange = () => handlers.onCategory(input.dataset.category, input.checked);
	}
	for (const input of element.querySelectorAll("input[data-kind]")) {
		input.onchange = () => handlers.onKind(input.dataset.kind, input.checked);
	}
	return { hiddenKinds: KINDS.filter((k) => !k.on && kindCounts.has(k.id)).map((k) => k.id) };
}
