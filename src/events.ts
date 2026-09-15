// What the brain is doing right now, for anyone watching: a recall fires an event with
// the notes it lit up. The dashboard subscribes over server-sent events and flashes them.
// In-process only; the daemon is the single writer of everything that matters.

export interface RecallEvent {
	type: "recall";
	ts: number;
	/** Vault paths of the notes returned. */
	paths: string[];
	query: string;
}

export type BrainEvent = RecallEvent;

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
