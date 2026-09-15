// The brain as it happens: the daemon streams every recall it makes, and the view lights
// the notes up. Reconnects on its own; the browser's EventSource does that.

export function watchRecalls(onRecall) {
	const source = new EventSource("/api/events");
	source.onmessage = (message) => {
		let event;
		try {
			event = JSON.parse(message.data);
		} catch {
			return;
		}
		if (event.type === "recall") onRecall(event);
	};
	return () => source.close();
}
