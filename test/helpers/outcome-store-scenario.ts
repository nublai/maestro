/**
 * One deterministic OutcomeStore workload, shared by the in-memory crash cuts
 * and the SIGKILL subprocess cuts: each step resolves only after its record is
 * durable, and `view` is what a restarted owner must recover after it.
 */
import type { OutcomeDraft } from "../../maestro/core/outcome-store.ts";
import { DurableFs } from "./durable-fs.ts";
import {
	FileOutcomeStore,
	type FileOutcomeStoreOptions,
	type OutcomeStoreFs,
} from "../../maestro/runtime/file-outcome-store.ts";

export const SCENARIO_PARENT = "parent-session";

export function sequence(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}-${++next}`;
}

export function clock(start = 1_000): () => number {
	let now = start;
	return () => now++;
}

export function openScenarioStore(
	dir: string,
	fs: OutcomeStoreFs | undefined,
	prefix: string,
	extra: Partial<FileOutcomeStoreOptions> = {},
): Promise<FileOutcomeStore> {
	return FileOutcomeStore.open({
		dir,
		parent: SCENARIO_PARENT,
		fs,
		// The simulated filesystem has no real directory to bind a socket in.
		lock: fs instanceof DurableFs ? fs.lock : undefined,
		newId: sequence(prefix),
		now: clock(),
		compactAfter: 1_000,
		...extra,
	});
}

export function draft(
	taskId: string,
	kind: OutcomeDraft["kind"],
	text: string,
	extra: Partial<OutcomeDraft> = {},
): OutcomeDraft {
	return {
		taskId,
		attempt: 1,
		kind,
		outcome: kind === "help" ? "help" : "completed",
		text,
		...extra,
	};
}

interface Context {
	ids: Record<string, string>;
}

type Step = (store: FileOutcomeStore, context: Context) => Promise<void>;

/** A step resolves once its write is durable; its value is not part of the view. */
async function done(write: Promise<object | void>): Promise<void> {
	await write;
}

/** Appends, delivery transitions, an observer batch and a compaction. */
export const SCENARIO: readonly Step[] = [
	(store) =>
		done(store.recordAttempt({ taskId: "a", attempt: 1, model: "m/one" })),
	(store) => done(store.recordAttempt({ taskId: "b", attempt: 1 })),
	(store) =>
		done(
			store.recordCheck({
				taskId: "a",
				attempt: 1,
				subject: { checkHash: "sha256:check", headSha: "abc" },
			}),
		),
	async (store, context) => {
		context.ids.a = (
			await store.commit(
				draft("a", "result", "a finished", {
					verdict: { verdict: "accepted" },
				}),
			)
		).outcome.deliveryId;
	},
	(store, context) => done(store.dispatch(context.ids.a!)),
	(store, context) =>
		done(
			store.settle(context.ids.a!, {
				state: "admitted",
				evidence: "process-local",
			}),
		),
	async (store, context) => {
		const [help] = await store.commitBatch({
			outcomes: [draft("b", "help", "b needs input")],
			observer: { key: "observer", state: { version: 1, cursor: "c-1" } },
		});
		context.ids.b = help!.outcome.deliveryId;
	},
	(store, context) => done(store.dispatch(context.ids.b!)),
	(store) => done(store.compact()),
	(store, context) =>
		done(store.settle(context.ids.b!, { state: "uncertain", reason: "lost" })),
	(store) => done(store.recordAttempt({ taskId: "c", attempt: 1 })),
	async (store, context) => {
		context.ids.c = (
			await store.commit(draft("c", "result", "c finished"))
		).outcome.deliveryId;
	},
	(store) => done(store.closeRun("b", "suppressed")),
	(store, context) => done(store.dispatch(context.ids.c!)),
	(store) =>
		done(
			store.commitBatch({
				observer: { key: "observer", state: { version: 1, cursor: "c-2" } },
			}),
		),
];

/** What a restarted owner recovers; `dispatching` always recovers as `uncertain`. */
export function view(store: FileOutcomeStore) {
	const recovery = store.recovery();
	return {
		outcomes: recovery.outcomes
			.map(({ outcome, delivery }) => ({
				id: outcome.deliveryId,
				task: outcome.taskId,
				kind: outcome.kind,
				text: outcome.text,
				state: delivery.state === "dispatching" ? "uncertain" : delivery.state,
				attempts: delivery.attempts,
			}))
			.sort((x, y) => x.id.localeCompare(y.id)),
		final: recovery.final
			.map(({ deliveryId, state, evidence }) => ({
				deliveryId,
				state,
				evidence,
			}))
			.sort((x, y) => x.deliveryId.localeCompare(y.deliveryId)),
		interrupted: recovery.interrupted
			.map((run) => ({
				task: run.taskId,
				attempts: run.attempts.length,
				checks: run.checks.length,
			}))
			.sort((x, y) => x.task.localeCompare(y.task)),
		observer: store.observerState("observer") ?? null,
	};
}

export type ScenarioView = ReturnType<typeof view>;

/**
 * Runs the workload; `acked` reports each step whose promise resolved.
 * Returns the view after every step (index 0: freshly opened).
 */
export async function runScenario(
	store: FileOutcomeStore,
	acked: (step: number) => void = () => {},
): Promise<ScenarioView[]> {
	const views = [view(store)];
	const context: Context = { ids: {} };
	for (const [index, step] of SCENARIO.entries()) {
		await step(store, context);
		acked(index + 1);
		views.push(view(store));
	}
	return views;
}
