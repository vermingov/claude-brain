// What the brain is doing right now, for anyone watching. Every recall and every
// traversal emits one of these; the dashboard subscribes over server-sent events and
// fires the notes involved. In-process only, and nothing here is persisted: this is the
// live wire, not a record.

export type ActivityKind = "recall" | "path" | "explain" | "affected";
/** Where the request came from. The MCP server, the CLI, a session hook, the dashboard. */
export type Via = "mcp" | "cli" | "hook" | "ui" | "unknown";

const VIA: readonly Via[] = ["mcp", "cli", "hook", "ui", "unknown"];

export interface ActivityEvent {
	type: ActivityKind;
	ts: number;
	via: Via;
	/** What was asked, short enough for a status line. */
	query: string;
	/** Vault paths of the notes involved, most relevant first. */
	paths: string[];
	/** For a traversal: the ordered route, so a signal can run it hop by hop. */
	route?: string[];
}

/** The vault changed and the layout has caught up: whoever is watching should re-read it. */
export interface GraphEvent {
	type: "graph";
	ts: number;
	notes: number;
}

export type BrainEvent = ActivityEvent | GraphEvent;

type Listener = (event: BrainEvent) => void;

const listeners = new Set<Listener>();

export function emit(event: BrainEvent): void {
	for (const listener of listeners) listener(event);
}

/** Returns the unsubscribe. */
export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Anything off the wire is a string from a caller; only the known sources are honoured. */
export function asVia(value: unknown): Via {
	return VIA.includes(value as Via) ? (value as Via) : "unknown";
}
