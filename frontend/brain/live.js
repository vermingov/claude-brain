// The brain as it happens: the daemon streams what it is doing — every recall, every
// traversal — and the view fires the notes involved. Reconnects on its own; that is what
// EventSource is for.

export function watchActivity(onEvent) {
	const source = new EventSource("/api/events");
	source.onmessage = (message) => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		if (event && typeof event.type === "string") onEvent(event);
	};
	return () => source.close();
}
