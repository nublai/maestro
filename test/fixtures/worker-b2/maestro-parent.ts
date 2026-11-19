/**
 * The Maestro side of a worker parent, in its own process, for the O1 crash
 * cuts (P3-9) against the real-B2 fixture: the worker provider, the parent's
 * outcome store, the receipt-backed admission outbox and the shared run owner,
 * as `test/helpers/worker-admission.ts` composes them.
 *
 * argv[2]: JSON `{ started, dir, mode, cut? }`.
 * - `run`: launches one child task and supervises it to delivery. With `cut`,
 *   the process SIGKILLs itself at that point (after printing `{event:"cut"}`).
 * - `recover`: reopens the same store (a new owner), starts the outbox
 *   (receipt reads first, then delivery) and prints what it recovered. With
 *   `checks` it first hands off every run the killed owner left open (P3-10).
 *
 * P3-10: `checks` composes `WorkerRunChecks`; `accept` is the task's check
 * command; `cancel` cancels the run once launched. Cuts `during-check` (the
 * check's subject is durable, its command not started) and `before-stop` (the
 * cancel's stop command is durable, not sent). `cancelWriteFails`: the
 * cancel's durable intent write fails (the launch manifests directory is
 * read-only for it); the process prints the cancel's report and whether a
 * stop was sent, then SIGKILLs itself (`after-refused-cancel`).
 *
 * Events: one JSON object per stdout line. Synthetic environment only.
 */
import { chmodSync, renameSync } from "node:fs";
import type { Receipt } from "@nublai/pi-worker-client";
import type {
	OutcomeRecovery,
	OutcomeStore,
	StoredOutcome,
} from "../../../maestro/core/outcome-store.ts";
import type { AdmissionAttention } from "../../../maestro/runtime/admission-outbox.ts";
import type { FileOutcomeStore } from "../../../maestro/runtime/file-outcome-store.ts";
import { nodeOutcomeStoreFs } from "../../../maestro/runtime/file-outcome-store.ts";
import {
	composeWorkerParent,
	type WorkerParentOptions,
	workerTask,
} from "../../helpers/worker-admission.ts";
import type { B2Started } from "../../helpers/worker-b2-fixture.ts";

export type MaestroCut =
	| "before-commit"
	| "after-commit"
	| "after-dispatch"
	| "after-admission"
	| "after-ack"
	| "compaction-before-rename"
	| "compaction-after-rename"
	| "during-check"
	| "before-stop"
	| "after-refused-cancel";

interface Args {
	started: B2Started;
	dir: string;
	mode: "run" | "recover";
	cut?: MaestroCut;
	checks?: boolean;
	accept?: string;
	cancel?: boolean;
	cancelWriteFails?: boolean;
}

// SAFETY: the test passes this JSON (Args) itself.
const args = JSON.parse(process.argv[2] ?? "{}") as Args;

/** One event line, as the test parses it back. */
export type MaestroEvent =
	| { event: "cut"; where: MaestroCut }
	| { event: "launched"; workerId: string }
	| { event: "cancel"; status: string; error?: string; stops: number }
	| {
			event: "settled";
			outcome: string;
			recovery: OutcomeRecovery;
			attention: AdmissionAttention[];
	  }
	| {
			event: "recovered";
			recovery: OutcomeRecovery;
			attention: AdmissionAttention[];
			handed?: StoredOutcome[];
	  }
	| { event: "error"; message: string };

function emit(event: MaestroEvent): void {
	// Pipes are synchronous on Linux: the line is written before any SIGKILL.
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function cut(where: MaestroCut): never {
	emit({ event: "cut", where });
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable after SIGKILL");
}

/** Whether the wrapped store is inside a commit (the compaction cuts' window). */
interface CommitWindow {
	committing: boolean;
}

/** A store whose calls reach `real`, except the cut points. */
function cutting(real: FileOutcomeStore, at: MaestroCut | undefined) {
	const state: CommitWindow = { committing: false };
	const store: OutcomeStore = {
		parent: real.parent,
		owner: real.owner,
		recordAttempt: (attempt) => real.recordAttempt(attempt),
		async recordCheck(check) {
			await real.recordCheck(check);
			if (at === "during-check") cut(at);
		},
		async commit(draft) {
			if (at === "before-commit") cut(at);
			state.committing = true;
			const stored = await real.commit(draft);
			state.committing = false;
			if (at === "after-commit") cut(at);
			return stored;
		},
		commitBatch: (batch) => real.commitBatch(batch),
		async dispatch(deliveryId, dispatch) {
			const delivery = await real.dispatch(deliveryId, dispatch);
			if (at === "after-dispatch") cut(at);
			return delivery;
		},
		async settle(deliveryId, settlement) {
			const delivery = await real.settle(deliveryId, settlement);
			if (at === "after-ack" && settlement.state === "admitted") cut(at);
			return delivery;
		},
		closeRun: (taskId, reason, owner) => real.closeRun(taskId, reason, owner),
		get: (deliveryId) => real.get(deliveryId),
		observerState: (key) => real.observerState(key),
		recovery: () => real.recovery(),
		compact: () => real.compact(),
		close: () => real.close(),
	};
	return { store, state };
}

async function main(): Promise<void> {
	const { started, dir, mode } = args;
	const at = mode === "run" ? args.cut : undefined;
	let committing: CommitWindow = { committing: false };
	const options: WorkerParentOptions = {
		wrapStore(real) {
			const wrapped = cutting(real, at);
			committing = wrapped.state;
			return wrapped.store;
		},
	};
	if (at === "compaction-before-rename" || at === "compaction-after-rename")
		options.store = {
			// Every record compacts; the cut lands in the commit's compaction.
			compactAfter: 1,
			fs: {
				...nodeOutcomeStoreFs,
				renameSync(from, to) {
					const snapshot = to.endsWith("snapshot.json");
					if (
						snapshot &&
						committing.committing &&
						at === "compaction-before-rename"
					)
						cut(at);
					renameSync(from, to);
					if (
						snapshot &&
						committing.committing &&
						at === "compaction-after-rename"
					)
						cut(at);
				},
			},
		};
	if (args.checks) options.checks = {};
	const parent = await composeWorkerParent(started, dir, options);
	if (at === "before-stop") {
		const { client } = parent.composed;
		const call = client.call.bind(client);
		// SAFETY: a pass-through wrapper with the client's own signature.
		client.call = (async (op: string, opts: never) => {
			if (op === "workers.stop") cut("before-stop");
			// SAFETY: forwards the caller's own operation and options unchanged.
			return call(op as never, opts);
		}) as typeof client.call;
	}
	if (at === "after-admission") {
		const { client } = parent.composed;
		const call = client.call.bind(client);
		// SAFETY: a pass-through wrapper with the client's own signature.
		client.call = (async (
			op: string,
			opts: { path?: { worker_id?: string } },
		) => {
			// SAFETY: forwards the caller's own operation and options unchanged.
			const reply = await call(op as never, opts as never);
			if (
				op === "sessions.prompt" &&
				opts?.path?.worker_id === started.parentWorkerId &&
				// SAFETY: a mutation's reply is its receipt.
				(reply as Receipt).admission === "accepted"
			)
				cut("after-admission");
			return reply;
		}) as typeof client.call;
	}
	if (mode === "recover") {
		await parent.outbox.start();
		const handed = parent.checks
			? await parent.checks.handOffInterrupted(parent.store, parent.outbox)
			: undefined;
		// Let any delivery the recovery made settle before reporting.
		const deadline = Date.now() + 3_000;
		while (
			Date.now() < deadline &&
			parent.outbox
				.attention()
				.some((item) => item.needs !== "owner" && item.needs !== "busy")
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		const recovered: MaestroEvent = {
			event: "recovered",
			recovery: parent.store.recovery(),
			attention: parent.outbox.attention(),
		};
		if (handed) recovered.handed = handed;
		emit(recovered);
		await parent.dispose();
		return;
	}
	await parent.outbox.start();
	const task = workerTask(
		"o1",
		parent.session.root,
		args.accept === undefined ? undefined : { run: args.accept },
	);
	const handle = await parent.runs.spawn(task);
	emit({ event: "launched", workerId: parent.workerOf(handle) });
	if (args.cancelWriteFails) {
		const { client, launches } = parent.composed;
		let stops = 0;
		const call = client.call.bind(client);
		// SAFETY: a pass-through wrapper with the client's own signature.
		client.call = (async (op: string, opts: never) => {
			if (op === "workers.stop") stops++;
			// SAFETY: forwards the caller's own operation and options unchanged.
			return call(op as never, opts);
		}) as typeof client.call;
		chmodSync(launches.dir, 0o500);
		let report;
		try {
			report = await parent.runs.cancel(task.id);
		} finally {
			chmodSync(launches.dir, 0o700);
		}
		const event: MaestroEvent = {
			event: "cancel",
			status: report.status,
			stops,
		};
		if (report.error !== undefined) event.error = report.error;
		emit(event);
		cut("after-refused-cancel");
	}
	if (args.cancel) void parent.runs.cancel(task.id);
	const result = await parent.runs.supervise(handle, task);
	emit({
		event: "settled",
		outcome: result.outcome,
		recovery: parent.store.recovery(),
		attention: parent.outbox.attention(),
	});
	await parent.dispose();
}

main().then(
	() => process.exit(0),
	(error) => {
		emit({
			event: "error",
			message: error instanceof Error ? error.message : "failure",
		});
		process.exit(1);
	},
);
