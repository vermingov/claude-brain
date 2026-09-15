// The vault is the brain's, not the filesystem's. Searching it by hand — a grep, a glob,
// a directory listing — skips everything that makes recall worth having: the embeddings,
// the graph, the episodic traces, the record of what was retrieved. It also quietly reads
// far more than the answer.
//
// So the tools that rummage are refused inside the vault, and the refusal says which
// brain call to make instead. Reading one note is fine, as long as the brain is what
// pointed at it.

export interface GuardRequest {
	/** Claude Code's tool name, e.g. "Grep" or "Read". */
	tool: string;
	input: Record<string, unknown>;
	vault: string;
	/** Notes the brain has already handed this session, by vault-relative path. */
	served: Set<string>;
	/** True when the path is a directory, as far as the daemon can tell. */
	isDirectory?: (absolute: string) => boolean;
}

export interface GuardDecision {
	allow: boolean;
	reason?: string;
}

const ALLOW: GuardDecision = { allow: true };

/** Programs that go looking through a tree rather than reading one named file. */
const SCANNERS = /(^|[|;&(]\s*)(sudo\s+)?(rg|grep|egrep|fgrep|ag|ack|find|fd|fdfind|tree|ls|du|wc)\b/;

const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "ListDir", "Search"]);

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Every path-ish string a tool call carries, as written. */
function pathTargets(tool: string, input: Record<string, unknown>): string[] {
	const out = [asString(input.file_path), asString(input.path), asString(input.notebook_path), asString(input.directory)];
	// Glob writes its target into the pattern as often as into `path`.
	if (tool === "Glob" || tool === "Grep") out.push(asString(input.pattern), asString(input.glob));
	return out.filter(Boolean);
}

function normalise(path: string): string {
	return path.replace(/\/+$/, "").toLowerCase();
}

/** A path that is the vault or sits under it. */
function insideVault(value: string, root: string): boolean {
	const candidate = normalise(value);
	return candidate === root || candidate.startsWith(`${root}/`);
}

function relativeTo(value: string, root: string): string {
	return value.slice(root.length).replace(/^\/+/, "");
}

const SEARCH_INSTEAD =
	"The vault is searched through the brain, not the filesystem: call the claude-brain `recall` tool with what you " +
	"are looking for (plain words, no keywords needed). It searches every note and every past session at once and " +
	"returns the answering lines, with the paths. `map`, `explain`, `affected` and `path` answer questions about how " +
	"notes relate.";

const deny = (reason: string): GuardDecision => ({ allow: false, reason });

/**
 * Decide one tool call. Anything outside the vault, and anything that is not a read,
 * passes untouched — this guards the brain's own material, nothing else.
 */
export function guardToolCall(request: GuardRequest): GuardDecision {
	const { tool, input, vault, served } = request;
	if (!vault) return ALLOW;
	const root = normalise(vault);

	if (tool === "Bash") {
		// A command is a sentence, not a path: the vault can appear anywhere in it, quoted
		// or not, so this looks for the root as text and then asks what the command does.
		const command = asString(input.command);
		if (!command.toLowerCase().includes(root)) return ALLOW;
		if (!SCANNERS.test(command)) return ALLOW;
		return deny(
			`That command searches the vault from the outside. ${SEARCH_INSTEAD} (Writing to the vault from a shell is ` +
				"fine, and so is git; searching it is what this refuses.)",
		);
	}

	const hits = pathTargets(tool, input).filter((value) => insideVault(value, root));
	if (hits.length === 0) return ALLOW;
	if (SEARCH_TOOLS.has(tool)) return deny(`${tool} over the vault is not the way in. ${SEARCH_INSTEAD}`);
	if (tool !== "Read" && tool !== "NotebookRead") return ALLOW;

	const target = hits[0]!;
	const relative = relativeTo(normalise(target), root);
	if (!relative || request.isDirectory?.(target)) return deny(`That is a vault directory. ${SEARCH_INSTEAD}`);
	// Only the brain's own material is guarded: an image or a PDF beside a note is not
	// something recall can hand over, so reading it directly is the only way.
	if (!/\.(md|markdown)$/i.test(relative)) return ALLOW;
	if (served.has(relativeTo(target.replace(/\/+$/, ""), vault.replace(/\/+$/, "")))) return ALLOW;
	return deny(
		`Nothing in this session pointed at \`${relativeTo(target, vault.replace(/\/+$/, ""))}\` — reading it now would be ` +
			"rummaging. Call the claude-brain `read` tool with that exact path to get it (the brain records the retrieval, " +
			"which is what keeps recall ranking useful), or `recall` what you are actually after and read what it returns.",
	);
}
