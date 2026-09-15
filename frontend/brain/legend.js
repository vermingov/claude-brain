// Filters: which lobes are shown, and which kinds of synapse. Counts are the real
// numbers behind each row.

const KINDS = [
	{ id: "wikilink", label: "Wikilinks", on: true },
	{ id: "cooccur", label: "Recalled together", on: true },
	{ id: "timeline", label: "Timeline", on: true },
	{ id: "semantic", label: "Similar wording", on: true },
	{ id: "tag", label: "Shared tags", on: false },
];

export function createLegend(element, graph, handlers) {
	const counts = new Map();
	for (const n of graph.nodes) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
	const kindCounts = new Map();
	for (const e of graph.edges) kindCounts.set(e.kind, (kindCounts.get(e.kind) ?? 0) + 1);

	const row = (name, value, label, count, color, on) =>
		`<label class="legend-item"${color ? ` style="--c:${color}"` : ""}>
			<input type="checkbox" ${on ? "checked" : ""} data-${name}="${value}" />
			<span class="dot"></span><span class="legend-label">${label}</span><span class="legend-count">${count}</span>
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
