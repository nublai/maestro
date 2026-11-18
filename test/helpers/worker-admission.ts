/**
 * P3-9 composition over the real-B2 fixture: the worker provider, the
 * parent's outcome store (identity: its worker, epoch and session), the
 * receipt-backed parent admission and its outbox, the Observer persisted with
 * the outbox, and the shared run owner. Used in-process and by the crash-cut
 * child (`test/fixtures/worker-b2/maestro-parent.ts`).
 */
import { join } from "node:path";
import { Client } from "@nublai/pi-worker-client";
import {
	readWorkerParent,
	restoredWorkerObserverState,
	type WorkerObserverPersistence,
	workerObserverPersistence,
	workerParentIdentity,
	type WorkerParentBinding,
} from "../../maestro/adapters/worker/parent-admission.ts";
import type { WorkerExecutionProviderOptions } from "../../maestro/adapters/worker/worker-exec-provider.ts";
import type { OutcomeStore } from "../../maestro/core/outcome-store.ts";
import type { Task } from "../../maestro/core/types.ts";
import { AdmissionOutbox } from "../../maestro/runtime/admission-outbox.ts";
import {
	FileOutcomeStore,
	type FileOutcomeStoreOptions,
} from "../../maestro/runtime/file-outcome-store.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";
import {
	adapterOver,
	type B2Started,
	composeProviderAt,
	parentSession,
	role,
	workerOf,
} from "./worker-b2-fixture.ts";

export interface WorkerParentOptions {
	/** Wraps the store every consumer uses (a crash cut or a fault). */
	wrapStore?(store: FileOutcomeStore): OutcomeStore;
	store?: Partial<FileOutcomeStoreOptions>;
	provider?: Partial<WorkerExecutionProviderOptions>;
	/** The parent identity the store is opened for; default the parent's current one. */
	parent?: WorkerParentBinding;
	pollMs?: number;
}

/** The parent's state directory layout under `dir`. */
export function outcomesDir(dir: string): string {
	return join(dir, ".piw-maestro", "outcomes");
}

export async function composeWorkerParent(
	started: B2Started,
	dir: string,
	options: WorkerParentOptions = {},
) {
	const reader = new Client({
		socketPath: started.socketPath,
		grantFile: started.grantFile,
		timeoutMs: 10_000,
	});
	const binding =
		options.parent ?? (await readWorkerParent(reader, started.parentWorkerId));
	const opened = await FileOutcomeStore.open({
		dir: outcomesDir(dir),
		parent: workerParentIdentity(binding),
		...options.store,
	});
	const store = options.wrapStore?.(opened) ?? opened;
	// The provider's Observer resumes from the state saved with the outbox and
	// saves each batch through the persistence built over its own manifests.
	let persistence: WorkerObserverPersistence | undefined;
	const observer: NonNullable<WorkerExecutionProviderOptions["observer"]> = {
		backoff: { initialMs: 20, maxMs: 200 },
		persist: (batch, row) => persistence!.persist(batch, row),
	};
	const restored = restoredWorkerObserverState(store);
	if (restored) observer.restored = restored;
	const composed = composeProviderAt(started, dir, {
		...options.provider,
		observer,
	});
	const outbox = new AdmissionOutbox({
		store,
		admission: composed.provider.parentAdmission(binding),
		pollMs: options.pollMs ?? 20,
	});
	persistence = workerObserverPersistence({
		store,
		launches: composed.launches,
		client: composed.client,
		envelope: (draft) => outbox.envelope(draft),
		committed: () => outbox.wake(),
	});
	const session = parentSession();
	const { adapter, launchOf } = adapterOver(composed.provider, session);
	const runs = createRunSession({
		adapter,
		roles: [role],
		cwd: session.root,
		outcomeStore: store,
		parentAdmission: outbox,
	});
	return {
		binding,
		store,
		opened,
		outbox,
		composed,
		runs,
		adapter,
		session,
		workerOf: (handle: Parameters<typeof launchOf>[0]) =>
			workerOf(composed.provider, launchOf(handle)),
		execOf: (handle: Parameters<typeof launchOf>[0]) => launchOf(handle).handle,
		async dispose() {
			await outbox.close();
			await composed.provider.close();
			await opened.close();
			session.dispose();
		},
	};
}

export function workerTask(id: string, root: string): Task {
	return {
		id,
		name: id,
		role: role.name,
		prompt: "bounded task",
		cwd: root,
		worktree: { branch: "w" },
		runtime: { model: "fake/test", thinking: "off" },
	};
}
