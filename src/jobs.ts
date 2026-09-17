// What the brain is doing right now, while it is still doing it.
//
// Capturing a page and rebuilding it take minutes: a browser opens, the DOM and every rule
// that applies to it are read, the page is watched for as long as it keeps moving, its images
// come down, the result is rendered and scored. From the outside all of that was one word on a
// card — "rebuilding it" — which looks exactly like a job that has wedged. So every long job
// says where it has got to, and the dashboard shows the lot.
//
// In memory and in this process on purpose: these are this server's jobs, and a restart ends
// them. Nothing here is persisted, and nothing here is a fact about a design — the row already
// carries what survived.

/** A job as the dashboard sees it. */
export interface JobSnapshot {
	id: string;
	kind: "capture" | "rebuild" | "describe";
	/** What is being worked on: a page's address, or a design's name. */
	subject: string;
	/** What the job is doing now, in the words a person would use. */
	stage: string;
	/** The specific thing inside that stage, when there is one: a file, a screen, a count. */
	detail: string;
	/** 0 to 1. Honest about being an estimate: stages have weights, not measurements. */
	progress: number;
	startedAt: number;
	elapsedMs: number;
}

export interface JobHandle {
	/** Move to a stage. `progress` is the share of the whole job that is done when it starts. */
	stage(name: string, progress: number, detail?: string): void;
	/** Same stage, new detail, and optionally further along. */
	step(detail: string, progress?: number): void;
	end(): void;
}

interface Job {
	snapshot: JobSnapshot;
}

const running = new Map<string, Job>();
let counter = 0;

export function startJob(kind: JobSnapshot["kind"], subject: string, stage = "starting"): JobHandle {
	const id = `${kind}-${++counter}`;
	const job: Job = {
		snapshot: { id, kind, subject, stage, detail: "", progress: 0, startedAt: Date.now(), elapsedMs: 0 },
	};
	running.set(id, job);
	return {
		stage(name, progress, detail = "") {
			job.snapshot.stage = name;
			job.snapshot.progress = clamp(progress);
			job.snapshot.detail = detail;
		},
		step(detail, progress) {
			job.snapshot.detail = detail;
			if (progress !== undefined) job.snapshot.progress = clamp(progress);
		},
		end() {
			running.delete(id);
		},
	};
}

/** Everything running now, oldest first, with the clock read at the moment of asking. */
export function activeJobs(): JobSnapshot[] {
	const now = Date.now();
	return [...running.values()]
		.map((job) => ({ ...job.snapshot, elapsedMs: now - job.snapshot.startedAt }))
		.sort((a, b) => a.startedAt - b.startedAt);
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
