// Search box over titles and tags. Matches light up in the graph; picking one flies there.

function escapeHtml(s) {
	return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const MAX_RESULTS = 8;

/**
 * @param {{ input: HTMLInputElement, results: HTMLElement }} elements
 * @param {object} graph
 * @param {{ onMatches: (set: Set<number>|null) => void, onPick: (index: number) => void }} handlers
 */
export function createSearch(elements, graph, handlers) {
	const { input, results } = elements;
	const categoryById = new Map(graph.categories.map((c) => [c.id, c]));

	function clear() {
		input.value = "";
		results.classList.remove("open");
		results.innerHTML = "";
		handlers.onMatches(null);
	}

	function run(query) {
		const q = query.trim().toLowerCase();
		if (!q) {
			clear();
			return;
		}
		const matches = [];
		graph.nodes.forEach((n, i) => {
			if (n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))) matches.push(i);
		});
		handlers.onMatches(new Set(matches));
		results.innerHTML = matches
			.slice(0, MAX_RESULTS)
			.map((i) => {
				const n = graph.nodes[i];
				const c = categoryById.get(n.category);
				return `<li data-index="${i}"><span class="dot" style="--c:${c?.color}"></span><span class="sr-title">${escapeHtml(n.title)}</span><span class="sr-lobe">${escapeHtml(c?.label ?? "")}</span></li>`;
			})
			.join("");
		results.classList.toggle("open", matches.length > 0);
		for (const li of results.querySelectorAll("li")) {
			li.onclick = () => {
				const index = Number(li.dataset.index);
				clear();
				handlers.onPick(index);
			};
		}
	}

	// The input outlives any one graph — it belongs to the page, not to the payload — so
	// these come off again when the graph is replaced. Left attached, every reload would
	// add another pair, and a keystroke would run one search per graph ever loaded.
	const onInput = () => run(input.value);
	const onKeyDown = (e) => {
		if (e.key === "Enter") results.querySelector("li")?.click();
		else if (e.key === "Escape") {
			clear();
			input.blur();
		}
	};
	input.addEventListener("input", onInput);
	input.addEventListener("keydown", onKeyDown);

	return {
		clear,
		focus: () => input.focus(),
		isFocused: () => document.activeElement === input,
		dispose() {
			input.removeEventListener("input", onInput);
			input.removeEventListener("keydown", onKeyDown);
		},
	};
}
