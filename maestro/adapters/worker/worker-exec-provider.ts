/**
 * WorkerExecutionProvider (P3-7): the ExecProvider that runs Pi children as
 * typed pi-worker children over B2, through `@nublai/pi-worker-client`.
 *
 * One call path (plan section 3):
 * - launch: refuse unsupported requests before acquisition (the shared
 *   adapter refuses missing capabilities first), read the parent's current
 *   binding and running execution, durably claim an owner-prepared slot,
 *   write the launch's acquisition manifest, then `workers.create {parent,
 *   launch_spec}` and, as a separate command, the initial `sessions.prompt`
 *   (never `first_prompt`).
 * - observe/read: wake-ups from the client's Observer (one supervisor-wide
 *   stream, reconnected from snapshots), presence and claims from
 *   `workers.get`, output from `history.page`.
 * - prompt (`sessions.prompt`, `if_busy: reject`), interrupt
 *   (`executions.interrupt`) and stop (`workers.stop`) report what their
 *   receipts prove.
 *
 * Every mutation's UUIDv7 command ID and request hash are durable in the
 * launch's manifest before its transport. A lost reply is reconciled by one
 * receipt read; an outcome that stays unknown is kept and never sent again.
 * A create whose outcome is unknown keeps its manifest and slot claim. A
 * local abort only stops waiting. No terminal is constructed on this path.
 *
 * Completion: the leaf reports through its FD 3 (`fd-report.ts`); the worker
 * records it as a `children.report` receipt and lists the claim on the
 * child's row. The provider transcribes the first `result` claim into the
 * run's parent-local completion record (the session-file sidecar the shared
 * Pi adapter reads), after mirroring the child's history there. A claim is
 * never proof: the parent's checks decide.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	acquisition,
	type Client,
	ClientFailure,
	classifyReceipt,
	type components,
	type Expected,
	Observer,
	type ObserverBatch,
	type ObserverState,
	type ObserverStop,
	type Receipt,
	type Reconciliation,
	reconcile,
	requestHash,
} from "@nublai/pi-worker-client";
import type {
	ExecCapabilities,
	ExecHandle,
	ExecLaunch,
	ExecObserveOptions,
	ExecPromptInput,
	ExecReconciliation,
	ExecStopReport,
} from "../../core/exec-provider.ts";
import { isString } from "../../core/config/type-guards.ts";
import { createLifecycle } from "../../core/lifecycle.ts";
import {
	type AcquisitionControl,
	AcquisitionUncertainError,
} from "../../core/surface-provider.ts";
import type { PaneInspection } from "../../core/types.ts";
import type { FreshPiLaunchRequest, PiLaunchRequest } from "../pi/launch.ts";
import type { PiExecProvider, PiExecution } from "../pi/pi-harness-adapter.ts";
import { type DecodedResultClaim, decodeResultClaim } from "./fd-report.ts";
import { MAESTRO_WORKER_CHILD_METHODS } from "./grant-profile.ts";
import {
	privateDirectory,
	uuidv7,
	type WorkerCommandPurpose,
	type WorkerLaunchStore,
	type WorkerMutation,
	writeDurable,
} from "./launch-store.ts";
import {
	WorkerParentAdmission,
	type WorkerParentBinding,
} from "./parent-admission.ts";
import type { ClaimedSlot, WorkerSlotPool } from "./slots.ts";

type Worker = components["schemas"]["Worker"];
type LaunchSpec = components["schemas"]["LaunchSpec"];
type Create = components["schemas"]["Create"];
type ChildClaim = components["schemas"]["ChildClaim"];
export type ArtifactFacts = components["schemas"]["ArtifactFacts"];
type HistoryQuery = { limit: number; watermark?: string; after?: string };
type HistoryEntry = components["schemas"]["HistoryPage"]["entries"][number];

/**
 * What a worker child supports in P3 (root decision Q4): isolated fan-out in
 * owner-prepared slots. Resume (B2 refuses sandboxed-child resume), fork,
 * persistent specialists, the caller's checkout and caller surfaces are
 * refused before acquisition. B2 reports a worker's status, not an exit code.
 * Parent admission is receipt-backed (P3-9): a checked outcome reaches the
 * parent worker as its own `sessions.prompt`, proven by its receipt
 * ({@link WorkerExecutionProvider.parentAdmission} with the outcome store's
 * `AdmissionOutbox`).
 */
export const WORKER_EXEC_CAPABILITIES: Readonly<ExecCapabilities> =
	Object.freeze({
		resume: false,
		fork: false,
		persistent: false,
		sharedCheckout: false,
		worktree: true,
		callerSurface: false,
		executionExit: false,
		parentAdmission: "receipt",
	});

/** How long a stopped child's FD 3 report may take to reach its row. pi-worker drains for 2 s. */
const REPORT_DRAIN_MS = 2_500;
const HISTORY_PAGE = 100;
const HISTORY_PAGES = 50;

export interface WorkerChildSpecOptions {
	/** Tools when the request names none. */
	defaultTools?: readonly string[];
	/**
	 * Absolute resource paths for a request (extensions and skills in the
	 * parent's profile). Without it a request naming skills is refused.
	 */
	resources?(request: FreshPiLaunchRequest): LaunchSpec["resources"];
	/**
	 * The child's filesystem. Default `bwrap`: the child runs in the bwrap
	 * profile of its slot (`environment.root` is the slot, as B2 requires and
	 * as a sandboxed parent's channel normalizes it), so the worker saves the
	 * launch's Git pin and `artifacts.inspect` can bind a check to the child's
	 * commit. With `none` no pin is saved and every bound check fails closed.
	 */
	filesystem?: "none" | "bwrap";
}

/**
 * One `artifacts.inspect` read (P3-6): the worker's owner-Git facts, a typed
 * refusal the worker proved (`no_effect`), or no answer (a lost reply, an
 * unreadable one, B2 unreachable). Facts are never a verdict.
 */
export type WorkerArtifactRead =
	| { kind: "facts"; facts: ArtifactFacts }
	| { kind: "refused"; code: string; detail?: string }
	| { kind: "unavailable"; error: string };

/** A worker's row as a hand-off states it: its status and fence, or why it is unread. */
export type WorkerRowState =
	| {
			kind: "row";
			status: Worker["status"];
			fenced: boolean;
			fenceCommandId?: string;
			foreground?: Worker["foreground"];
			workerEpoch: string;
			reports?: { kind: string; reportId: string }[];
	  }
	| { kind: "missing" }
	| { kind: "unavailable"; error: string };

/** One `workers.get`, as a hand-off fact. */
export async function readWorkerState(
	client: Client,
	workerId: string,
): Promise<WorkerRowState> {
	let row: Worker;
	try {
		row = await client.call("workers.get", { path: { worker_id: workerId } });
	} catch (error) {
		if (
			error instanceof ClientFailure &&
			error.phase === "http" &&
			error.message === "unknown_worker"
		)
			return { kind: "missing" };
		return { kind: "unavailable", error: errorText(error) };
	}
	const state: WorkerRowState = {
		kind: "row",
		status: row.status,
		fenced: Boolean(row.fence),
		workerEpoch: row.worker_epoch,
		reports: (row.child_reports ?? []).map((claim) => ({
			kind: claim.kind,
			reportId: claim.command_id,
		})),
	};
	if (row.fence) state.fenceCommandId = row.fence.command_id;
	if (row.foreground) state.foreground = row.foreground;
	return state;
}

/** What a run's bound check reads about its child (P3-10): issued, claimed and terminated. */
export interface WorkerRunBinding {
	workerId: string;
	/** The owner-issued slot: its root, branch and exact base. */
	slot: { name: string; path: string; branch: string; baseSha: string };
	/** The first result claim the child reported, once transcribed. */
	claim?: { reportId: string; decoded: DecodedResultClaim };
	/** Help claims seen so far, by report ID. */
	help: string[];
	/** The epoch whose termination a stop confirmed, once one did. */
	terminatedEpoch?: string;
	/** When the run's owner recorded its cancel intent, if it did. */
	cancelRequestedAt?: number;
}

export interface WorkerExecutionProviderOptions {
	/** A client on the parent's channel or a socket with Maestro's method profile. */
	client: Client;
	/** The parent's own worker ID (`PI_WORKER_ID` inside a sandboxed parent). */
	parentWorkerId: string;
	slots: WorkerSlotPool;
	launches: WorkerLaunchStore;
	/** Parent-private run records (completion record, mirrored history), outside every slot. */
	runsDir: string;
	childSpec?: WorkerChildSpecOptions;
	/**
	 * The initial prompt text. Default: {@link workerInitialPrompt}. Called
	 * before acquisition: a throw is an ordinary refusal with nothing claimed.
	 */
	initialPrompt?(request: FreshPiLaunchRequest): string;
	/** Stable provider name on every handle. Default `pi-worker`. */
	name?: string;
	/** Default 2500 ms. */
	reportDrainMs?: number;
	observer?: {
		/** The last persisted state: a diff after a restart, never a cold seed over pending outcomes. */
		restored?: ObserverState;
		/**
		 * Persist a batch's state (with the outbox: `workerObserverPersistence`)
		 * before its notices count as surfaced. `row` is the Observer's latest
		 * row of a worker, for reading the claims a notice names.
		 */
		persist?(
			batch: ObserverBatch,
			row: (workerId: string) => Worker | undefined,
		): void | Promise<void>;
		backoff?: { initialMs?: number; maxMs?: number };
	};
	now?(): number;
}

/** A provider-level refusal: nothing was claimed or sent. */
export class WorkerLaunchRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerLaunchRefusal";
	}
}

/** A mutation whose outcome is not proven. Never send it again; the owner reconciles. */
export class WorkerCommandUncertain extends Error {
	readonly commandId: string;
	/** B2's own reason when its receipt read left the command unknown (`outcome_unknown`, ...). */
	readonly unknownReason?: string;
	constructor(message: string, commandId: string, unknownReason?: string) {
		super(message);
		this.name = "WorkerCommandUncertain";
		this.commandId = commandId;
		if (unknownReason !== undefined) this.unknownReason = unknownReason;
	}
}

/**
 * The initial prompt: the task, preceded by the role identity when there is
 * one. B2's LaunchSpec has no system-prompt field, so the identity travels as
 * the first input's preamble until a typed field exists. That is weaker than
 * a system prompt (it is ordinary conversation input), accepted by root only
 * as interim append semantics; a request to replace the system prompt is
 * refused before acquisition.
 */
export function workerInitialPrompt(request: FreshPiLaunchRequest): string {
	const identity = request.behavior.identity?.trim();
	return identity
		? `${identity}\n\n---\n\nTask:\n${request.task}`
		: request.task;
}

interface WorkerExecution {
	readonly ref: string;
	readonly workerId: string;
	readonly child: PiExecution;
	/** The first result claim, once transcribed into the completion record. */
	transcribed?: string;
	/** That claim, decoded. */
	claim?: DecodedResultClaim;
	/** The epoch whose termination a stop confirmed (only that generation's). */
	terminatedEpoch?: string;
	/** Help claims seen on the row, in order. */
	help: ChildClaim[];
	/** A stopped child's report channel had its chance to drain. */
	drained: boolean;
	readonly waiters: Set<() => void>;
}

type RowRead =
	| { kind: "row"; worker: Worker }
	| { kind: "missing"; error: string }
	| { kind: "unavailable"; error: string };

type Settled = Reconciliation | ClientFailure;

/** A sent command's outcome; `unrecorded` is the store failure that kept it off disk. */
interface Sent {
	settled: Settled;
	unrecorded?: string;
}

const LIVE_STATUSES = new Set<Worker["status"]>([
	"starting",
	"ready",
	"cleanup_pending",
]);

export class WorkerExecutionProvider implements PiExecProvider<PiExecution> {
	readonly name: string;
	readonly capabilities = WORKER_EXEC_CAPABILITIES;
	readonly #options: WorkerExecutionProviderOptions;
	readonly #client: Client;
	readonly #executions = new Map<string, WorkerExecution>();
	readonly #byWorker = new Map<string, WorkerExecution>();
	readonly #now: () => number;
	#observer?: Observer;
	#observerAbort?: AbortController;
	#observerRun?: Promise<ObserverStop>;
	#observerState?: ObserverState;
	#closed = false;
	#negotiated?: Promise<void>;

	constructor(options: WorkerExecutionProviderOptions) {
		this.#options = options;
		this.#client = options.client;
		this.name = options.name ?? "pi-worker";
		this.#now = options.now ?? Date.now;
		privateDirectory(options.runsDir);
	}

	isAvailable(): boolean {
		return !this.#closed;
	}

	refusalMessage(requirement: string): string | undefined {
		return `${this.name} execution does not support ${
			{
				resume: "resuming a saved session (B2 refuses sandboxed-child resume)",
				fork: "forking the parent session (B2 seeds standalone children only)",
				persistent: "persistent specialists",
				sharedCheckout:
					"running in the caller's checkout; a worker child runs in an owner-prepared slot",
				worktree: "managed worktrees",
				callerSurface: "a caller-provided terminal surface",
			}[requirement] ?? requirement
		}; refused before acquisition.`;
	}

	/**
	 * The parent's root, whose repository's object database holds every
	 * slot's commits (the slots are its linked worktrees).
	 */
	get parentRoot(): string {
		return this.#options.slots.root;
	}

	/** The launch's acquisition manifest (slot, commands, outcomes). */
	manifest(handle: ExecHandle) {
		return this.#options.launches.read(this.#execution(handle).ref);
	}

	/** Help claims the child reported so far (P3-9 delivers them). */
	help(handle: ExecHandle): readonly ChildClaim[] {
		return this.#execution(handle).help;
	}

	/** The handle of an execution this provider launched, by its harness record. */
	handleOf(child: PiExecution): ExecHandle | undefined {
		for (const execution of this.#executions.values())
			if (execution.child === child)
				return Object.freeze({
					provider: this.name,
					ref: execution.ref,
					capabilities: this.capabilities,
				});
		return undefined;
	}

	/**
	 * What a bound check of this run reads (P3-10): the issued slot, the
	 * child's claims, the epoch a stop confirmed terminated, the recorded
	 * cancel intent. Undefined when its manifest cannot be read.
	 */
	runBinding(handle: ExecHandle): WorkerRunBinding | undefined {
		const execution = this.#execution(handle);
		const manifest = this.#options.launches.read(execution.ref);
		if (!manifest) return undefined;
		const binding: WorkerRunBinding = {
			workerId: execution.workerId,
			slot: {
				name: manifest.slot.name,
				path: manifest.slot.path,
				branch: manifest.slot.branch,
				baseSha: manifest.slot.base_sha,
			},
			help: execution.help.map((claim) => claim.command_id),
		};
		if (execution.transcribed !== undefined && execution.claim)
			binding.claim = {
				reportId: execution.transcribed,
				decoded: execution.claim,
			};
		if (execution.terminatedEpoch !== undefined)
			binding.terminatedEpoch = execution.terminatedEpoch;
		if (manifest.cancel_requested_at !== undefined)
			binding.cancelRequestedAt = manifest.cancel_requested_at;
		return binding;
	}

	/**
	 * The parent's current state, for a hand-off (P3-10): whether it is fenced
	 * (invariant 4a: a child stopped without a result report fences it until
	 * the owner resolves the fence) and whether it may take input. A read only;
	 * the provider never clears a fence.
	 */
	async parentState(): Promise<WorkerRowState> {
		return readWorkerState(this.#client, this.#options.parentWorkerId);
	}

	/** One owned child's current state, by its worker ID (a read only). */
	async workerState(workerId: string): Promise<WorkerRowState> {
		return readWorkerState(this.#client, workerId);
	}

	/** Every acquisition manifest this provider's store keeps, oldest first. */
	launchManifests() {
		return this.#options.launches.list();
	}

	/**
	 * Records the run owner's cancel intent in the launch's manifest, durably,
	 * before the stop it leads to is sent. Returns the write's failure, if any:
	 * the intent then lives in memory only.
	 */
	recordCancelIntent(handle: ExecHandle, at = this.#now()): string | undefined {
		const execution = this.#execution(handle);
		return this.#tryWrite(() =>
			this.#options.launches.update(execution.ref, (manifest) => {
				manifest.cancel_requested_at ??= at;
			}),
		);
	}

	/**
	 * Owner-Git facts about the child's checkout (`artifacts.inspect`) at the
	 * worker's saved launch pin, for `epoch` (B2 refuses any other as
	 * `stale_binding`). `commit` and `base` are full object IDs or branches of
	 * the child's own namespace, never paths. A read: no command is recorded,
	 * and a lost reply is `unavailable`, never retried here.
	 */
	async inspectArtifact(
		handle: ExecHandle,
		request: { epoch: string; commit: string; base?: string },
	): Promise<WorkerArtifactRead> {
		const execution = this.#execution(handle);
		const body: components["schemas"]["ArtifactInspect"] = {
			worker_epoch: request.epoch,
			commit: request.commit,
		};
		if (request.base !== undefined) body.base = request.base;
		try {
			return {
				kind: "facts",
				facts: await this.#client.call("artifacts.inspect", {
					path: { worker_id: execution.workerId },
					body,
				}),
			};
		} catch (error) {
			if (
				error instanceof ClientFailure &&
				error.phase === "http" &&
				error.effect === "no_effect"
			) {
				const detail = error.details.detail;
				return isString(detail) && /^[a-z0-9_]{1,128}$/.test(detail)
					? { kind: "refused", code: error.message, detail }
					: { kind: "refused", code: error.message };
			}
			return { kind: "unavailable", error: errorText(error) };
		}
	}

	/** The Observer's latest state (persisted with the outbox by P3-9). */
	observerState(): ObserverState | undefined {
		return this.#observerState;
	}

	/**
	 * Starts the Observer without a launch: a restarted parent resumes from
	 * its restored state, so reports made meanwhile surface (once). Idempotent.
	 */
	resumeObservation(): void {
		this.#startObserver();
	}

	/**
	 * The receipt-backed admission to this provider's parent generation, over
	 * the provider's own client and grant. Its identity is the store's parent.
	 */
	parentAdmission(parent: WorkerParentBinding): WorkerParentAdmission {
		if (parent.worker_id !== this.#options.parentWorkerId)
			throw new Error(
				"Parent admission must name this provider's own parent worker.",
			);
		return new WorkerParentAdmission({
			client: this.#client,
			parent,
			now: this.#now,
		});
	}

	async launch(
		request: PiLaunchRequest,
		control?: AcquisitionControl,
	): Promise<ExecLaunch<PiExecution>> {
		const signal = control?.signal ?? request.acquisitionSignal;
		signal?.throwIfAborted();
		if (this.#closed)
			throw new WorkerLaunchRefusal("Worker provider is closed");
		const fresh = this.#admit(request);
		// Fallible caller code runs before acquisition, never after the create.
		const message = (this.#options.initialPrompt ?? workerInitialPrompt)(fresh);
		await this.#hello();
		const parent = await this.#parentBinding();
		signal?.throwIfAborted();
		const launchId = uuidv7(this.#now());
		const runId = fresh.id ?? launchId;
		const taskId = fresh.behavior.taskId ?? runId;
		const generationId = fresh.behavior.generationId ?? launchId;
		const plan = fresh.runtimePlan;
		const slot = this.#options.slots.claim(launchId, fresh.worktree ?? {});
		const { launches } = this.#options;
		let spec: LaunchSpec;
		let child: PiExecution;
		try {
			spec = this.#childSpec(fresh, slot);
			child = this.#record(fresh, slot, runId, taskId, generationId);
			const created: Parameters<WorkerLaunchStore["create"]>[0] = {
				launch_id: launchId,
				run_id: runId,
				name: fresh.name,
				task_id: taskId,
				generation_id: generationId,
				parent_worker_id: parent.worker_id,
				slot: {
					name: slot.name,
					path: slot.path,
					branch: slot.branch,
					base_sha: slot.baseSha,
				},
				model: {
					provider: plan.provider,
					model: plan.modelId,
					thinking: plan.thinking,
				},
				state: "claimed",
			};
			if (fresh.worktree?.branch !== undefined)
				created.requested_branch = fresh.worktree.branch;
			launches.create(created);
		} catch (error) {
			this.#options.slots.release(slot.name, launchId);
			throw error;
		}
		if (signal?.aborted) {
			this.#notAcquired(launchId, slot);
			signal.throwIfAborted();
		}
		// From here an abort is admission intent only: nothing remote is cancelled by it.
		// Once the create is sent, a failing store never turns into a plain rejection.
		const createId = uuidv7(this.#now());
		const body: Create = {
			command_id: createId,
			cwd: slot.path,
			provider: plan.provider,
			model: plan.modelId,
			thinking: plan.thinking,
			host: "sdk",
			parent: {
				...parent,
				task_id: taskId,
				generation_id: generationId,
			},
			launch_spec: spec,
		};
		let sentCreate: Sent;
		try {
			launches.update(launchId, (manifest) => {
				manifest.state = "creating";
			});
			sentCreate = await this.#mutate(
				launchId,
				"create",
				"workers.create",
				requestHash("workers.create", { body }),
				undefined,
				createId,
				() => this.#client.call("workers.create", { body }),
			);
		} catch (error) {
			// #mutate throws only before its transport: nothing was sent.
			this.#tryWrite(() => this.#notAcquired(launchId, slot));
			throw error;
		}
		const { settled: created, unrecorded: createUnrecorded } = sentCreate;
		const acquired = acquisition(created);
		if (acquired.worker === "not_acquired") {
			// An unrecorded refusal keeps everything: its manifest still says `creating`.
			const kept =
				createUnrecorded ??
				this.#tryWrite(() => this.#notAcquired(launchId, slot));
			throw new WorkerLaunchRefusal(
				kept === undefined
					? `Worker create refused (${failureCode(created)}); nothing acquired, slot ${slot.name} released.`
					: `Worker create refused (${failureCode(created)}); nothing acquired, but its outcome could not be recorded (${kept}): slot ${slot.name} and its acquisition manifest retained.`,
			);
		}
		const workerId = acquired.worker_id;
		if (workerId === undefined) {
			const why = `Worker create outcome unknown (${failureCode(created)}); slot ${slot.name} and its acquisition manifest retained, never retried.`;
			const unwritten =
				createUnrecorded ??
				this.#tryWrite(() =>
					launches.update(launchId, (manifest) => {
						manifest.state = "uncertain";
						manifest.uncertainty = why;
					}),
				);
			throw new AcquisitionUncertainError(
				unwritten === undefined
					? why
					: `${why} Its outcome could not be recorded (${unwritten}).`,
				{ kind: "execution-start" },
			);
		}
		const execution: WorkerExecution = {
			ref: launchId,
			workerId,
			child,
			help: [],
			drained: false,
			waiters: new Set(),
		};
		this.#executions.set(launchId, execution);
		this.#byWorker.set(workerId, execution);
		const handle: ExecHandle = Object.freeze({
			provider: this.name,
			ref: launchId,
			capabilities: this.capabilities,
		});
		// The worker is owned from here: every failure is this handle's launchFailure.
		try {
			this.#startObserver();
			return await this.#launchAcquired(
				launchId,
				handle,
				child,
				workerId,
				created,
				acquired,
				createUnrecorded,
				message,
			);
		} catch (error) {
			const why = `Worker ${workerId} acquired, but its launch failed after acquisition (${errorText(error)}); retained and owned, nothing re-sent.`;
			const kept = this.#tryWrite(() =>
				launches.update(launchId, (manifest) => {
					manifest.uncertainty = why;
				}),
			);
			return {
				handle,
				launched: child,
				launchFailure:
					kept === undefined
						? why
						: `${why} Its outcome could not be recorded (${kept}).`,
			};
		}
	}

	/** After an acquired create: record it and send the initial prompt once. */
	async #launchAcquired(
		launchId: string,
		handle: ExecHandle,
		child: PiExecution,
		workerId: string,
		created: Settled,
		acquired: Exclude<
			ReturnType<typeof acquisition>,
			{ worker: "not_acquired" }
		>,
		createUnrecorded: string | undefined,
		message: string,
	): Promise<ExecLaunch<PiExecution>> {
		const { launches } = this.#options;
		const unrecorded = (failure: string) =>
			`Worker ${workerId} acquired, but its outcome could not be recorded (${failure}); not prompted, retained and owned.`;
		if (createUnrecorded !== undefined)
			return {
				handle,
				launched: child,
				launchFailure: unrecorded(createUnrecorded),
			};
		if (acquired.worker === "unknown") {
			const why = `Worker ${workerId} create outcome unknown (${failureCode(created)}); retained and owned, never retried.`;
			const unwritten = this.#tryWrite(() =>
				launches.update(launchId, (manifest) => {
					manifest.state = "uncertain";
					manifest.worker_id = workerId;
					manifest.uncertainty = why;
				}),
			);
			return {
				handle,
				launched: child,
				launchFailure:
					unwritten === undefined
						? why
						: `${why} Its outcome could not be recorded (${unwritten}).`,
			};
		}
		const binding = acquired.binding ?? (await this.#bindingOf(workerId));
		const unwritten = this.#tryWrite(() =>
			launches.update(launchId, (manifest) => {
				manifest.state = "acquired";
				manifest.worker_id = workerId;
				if (binding)
					manifest.binding = {
						worker_epoch: binding.worker_epoch,
						session_id: binding.session_id,
						binding_revision: binding.binding_revision,
					};
			}),
		);
		if (unwritten !== undefined)
			return { handle, launched: child, launchFailure: unrecorded(unwritten) };
		if (!binding)
			return {
				handle,
				launched: child,
				launchFailure: `Worker ${workerId} acquired but its binding is unreadable; not prompted, retained.`,
			};
		// The initial prompt is its own command: acquired-but-unprompted stays explicit.
		const promptId = uuidv7(this.#now());
		const promptBody = {
			command_id: promptId,
			worker_epoch: binding.worker_epoch,
			session_id: binding.session_id,
			binding_revision: binding.binding_revision,
			message,
			if_busy: "reject" as const,
		};
		let sentPrompt: Sent;
		try {
			sentPrompt = await this.#mutate(
				launchId,
				"initial-prompt",
				"sessions.prompt",
				requestHash("sessions.prompt", {
					path: { worker_id: workerId },
					body: promptBody,
				}),
				workerId,
				promptId,
				() =>
					this.#client.call("sessions.prompt", {
						path: { worker_id: workerId },
						body: promptBody,
					}),
			);
		} catch (error) {
			// Not sent: its command could not be recorded first.
			return {
				handle,
				launched: child,
				launchFailure: unrecorded(errorText(error)),
			};
		}
		const { settled: prompted } = sentPrompt;
		if (sentPrompt.unrecorded !== undefined)
			return {
				handle,
				launched: child,
				launchFailure: `Worker ${workerId} initial prompt was ${provenText(prompted)}, but its outcome could not be recorded (${sentPrompt.unrecorded}); retained and owned, never re-sent.`,
			};
		const outcome = acquisition(created, prompted);
		const prompt = outcome.worker === "acquired" ? outcome.prompt : "unknown";
		if (prompt === "prompted") return { handle, launched: child };
		const why =
			prompt === "not_prompted"
				? `Worker ${workerId} acquired but its initial prompt was refused (${failureCode(prompted)}); not prompted, retained.`
				: `Worker ${workerId} initial prompt outcome unknown (${failureCode(prompted)}); retained and owned, never re-sent.`;
		const kept = this.#tryWrite(() =>
			launches.update(launchId, (manifest) => {
				manifest.uncertainty = why;
			}),
		);
		return {
			handle,
			launched: child,
			launchFailure:
				kept === undefined
					? why
					: `${why} Its outcome could not be recorded (${kept}).`,
		};
	}

	async inspect(handle: ExecHandle): Promise<PaneInspection> {
		const execution = this.#execution(handle);
		const read = await this.#absorb(execution, await this.#read(execution));
		if (read.kind !== "row") return { kind: read.kind, error: read.error };
		const worker = read.worker;
		if (!LIVE_STATUSES.has(worker.status))
			return { kind: "missing", error: `worker ${worker.status}` };
		return {
			kind: "present",
			agentStatus:
				worker.foreground === "running"
					? "working"
					: worker.foreground === "idle"
						? "idle"
						: "unknown",
			observedAt: this.#now(),
		};
	}

	async *observe(
		handle: ExecHandle,
		options: ExecObserveOptions,
	): AsyncIterable<PaneInspection> {
		const execution = this.#execution(handle);
		const { signal } = options;
		while (!signal.aborted) {
			let snapshot: PaneInspection;
			try {
				snapshot = await this.inspect(handle);
			} catch (error) {
				snapshot = { kind: "unavailable", error: errorText(error) };
			}
			if (signal.aborted) return;
			yield snapshot;
			if (snapshot.kind === "missing") return;
			await this.#changed(execution, signal, options.intervalMs ?? 1_000);
		}
	}

	async read(handle: ExecHandle, lines?: number): Promise<string> {
		const execution = this.#execution(handle);
		const text = (await this.#history(execution.workerId)).flatMap(entryLines);
		return (lines === undefined ? text : text.slice(-lines)).join("\n");
	}

	async prompt(handle: ExecHandle, input: ExecPromptInput): Promise<void> {
		const execution = this.#execution(handle);
		const binding = await this.#bindingOf(execution.workerId);
		if (!binding)
			throw new Error(
				`Worker ${execution.workerId} binding is unreadable; input not sent`,
			);
		const commandId = uuidv7(this.#now());
		const body = {
			command_id: commandId,
			worker_epoch: binding.worker_epoch,
			session_id: binding.session_id,
			binding_revision: binding.binding_revision,
			message: input.text,
			if_busy: "reject" as const,
		};
		const path = { worker_id: execution.workerId };
		const { settled, unrecorded } = await this.#mutate(
			execution.ref,
			"prompt",
			"sessions.prompt",
			requestHash("sessions.prompt", { path, body }),
			execution.workerId,
			commandId,
			() => this.#client.call("sessions.prompt", { path, body }),
			input.id,
		);
		if (unrecorded !== undefined)
			throw new WorkerCommandUncertain(
				`Worker ${execution.workerId} input ${input.id} was ${provenText(settled)}, but its outcome could not be recorded (${unrecorded}); never re-sent.`,
				commandId,
			);
		const receipt = observed(settled);
		if (receipt?.admission === "accepted") return;
		if (receipt || isNoEffect(settled))
			throw new Error(
				`Worker ${execution.workerId} refused input ${input.id} (${failureCode(settled)}); not delivered.`,
			);
		throw new WorkerCommandUncertain(
			`Worker ${execution.workerId} input ${input.id} outcome unknown (${failureCode(settled)}); never re-sent.`,
			commandId,
		);
	}

	async interrupt(handle: ExecHandle): Promise<void> {
		const execution = this.#execution(handle);
		const read = await this.#read(execution);
		if (read.kind !== "row")
			throw new Error(
				`Worker ${execution.workerId} is ${read.kind}: ${read.error}`,
			);
		const worker = read.worker;
		if (!worker.session_id)
			throw new Error(`Worker ${execution.workerId} has no bound session`);
		const commandId = uuidv7(this.#now());
		const body: components["schemas"]["Control"] = {
			command_id: commandId,
			worker_epoch: worker.worker_epoch,
			session_id: worker.session_id,
			binding_revision: worker.binding_revision,
		};
		const running = worker.execution;
		if (running && running.state !== "settled")
			body.execution_id = running.execution_id;
		const path = { worker_id: execution.workerId };
		const { settled, unrecorded } = await this.#mutate(
			execution.ref,
			"interrupt",
			"executions.interrupt",
			requestHash("executions.interrupt", { path, body }),
			execution.workerId,
			commandId,
			() => this.#client.call("executions.interrupt", { path, body }),
		);
		if (unrecorded !== undefined)
			throw new WorkerCommandUncertain(
				`Worker ${execution.workerId} interrupt was ${provenText(settled)}, but its outcome could not be recorded (${unrecorded}); never re-sent.`,
				commandId,
			);
		if (observed(settled)) return;
		if (isNoEffect(settled))
			throw new Error(
				`Worker ${execution.workerId} refused the interrupt (${failureCode(settled)}).`,
			);
		throw new WorkerCommandUncertain(
			`Worker ${execution.workerId} interrupt outcome unknown (${failureCode(settled)}); never re-sent.`,
			commandId,
		);
	}

	async stop(handle: ExecHandle): Promise<ExecStopReport> {
		const execution = this.#execution(handle);
		const read = await this.#read(execution);
		if (read.kind !== "row")
			return {
				request: "not-sent",
				termination: "unconfirmed",
				error: new Error(
					`Worker ${execution.workerId} is ${read.kind}: ${read.error}`,
				),
			};
		const worker = read.worker;
		// Only a stop the worker recorded as complete (cleanup confirmed) ends ownership.
		if (worker.status === "stopped" || worker.status === "failed") {
			execution.terminatedEpoch = worker.worker_epoch;
			return { request: "not-sent", termination: "confirmed" };
		}
		if (!worker.session_id)
			return {
				request: "not-sent",
				termination: "unconfirmed",
				error: new Error(`Worker ${execution.workerId} has no bound session`),
			};
		const commandId = uuidv7(this.#now());
		const epoch = worker.worker_epoch;
		const body = {
			command_id: commandId,
			worker_epoch: epoch,
			session_id: worker.session_id,
			binding_revision: worker.binding_revision,
		};
		const path = { worker_id: execution.workerId };
		let sent: Sent;
		try {
			sent = await this.#mutate(
				execution.ref,
				"stop",
				"workers.stop",
				requestHash("workers.stop", { path, body }),
				execution.workerId,
				commandId,
				() => this.#client.call("workers.stop", { path, body }),
			);
		} catch (error) {
			// Not sent: its command could not be recorded first.
			return { request: "not-sent", termination: "unconfirmed", error };
		}
		this.#wake(execution);
		const { settled, unrecorded } = sent;
		// An unrecorded outcome confirms nothing: the next stop reads the row again.
		if (unrecorded !== undefined)
			return {
				request: isNoEffect(settled)
					? "not-sent"
					: observed(settled)
						? "sent"
						: "unknown",
				termination: "unconfirmed",
				error: new WorkerCommandUncertain(
					`Worker ${execution.workerId} stop was ${provenText(settled)}, but its outcome could not be recorded (${unrecorded}); the worker stays owned.`,
					commandId,
				),
			};
		if (isNoEffect(settled))
			return {
				request: "not-sent",
				termination: "unconfirmed",
				error: new Error(
					`Worker ${execution.workerId} refused the stop (${failureCode(settled)})`,
				),
			};
		const receipt = observed(settled);
		const result = receipt?.result;
		// Only this generation's observed termination confirms; a newer generation never does.
		if (
			result &&
			result.stopped_worker_epoch === epoch &&
			(result.termination === "observed_stopped" ||
				result.termination === "superseded_generation_stopped")
		) {
			execution.terminatedEpoch = epoch;
			return { request: "sent", termination: "confirmed" };
		}
		return {
			request: receipt ? "sent" : "unknown",
			termination: "unconfirmed",
			error: new WorkerCommandUncertain(
				`Worker ${execution.workerId} stop not confirmed (${failureCode(settled)}); the worker stays owned.`,
				commandId,
				settled instanceof ClientFailure || settled.outcome !== "unknown"
					? undefined
					: settled.reason,
			),
		};
	}

	async reconcile(handle: ExecHandle): Promise<ExecReconciliation> {
		const execution = this.#execution(handle);
		const read = await this.#absorb(execution, await this.#read(execution));
		if (read.kind === "missing") return { kind: "missing" };
		if (read.kind === "unavailable")
			return { kind: "unavailable", error: read.error };
		return LIVE_STATUSES.has(read.worker.status)
			? { kind: "live" }
			: { kind: "finished" };
	}

	/** Stops the Observer. Executions stay as the worker keeps them. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#observerAbort?.abort();
		await this.#observerRun;
		for (const execution of this.#executions.values()) this.#wake(execution);
	}

	// ---- launch ----

	#admit(request: PiLaunchRequest): FreshPiLaunchRequest {
		if (request.kind !== "fresh")
			throw new WorkerLaunchRefusal(this.refusalMessage("resume") ?? "resume");
		const refuse = (requirement: string) => {
			throw new WorkerLaunchRefusal(
				this.refusalMessage(requirement) ?? requirement,
			);
		};
		if (!request.worktree) refuse("sharedCheckout");
		if (request.surface !== undefined) refuse("callerSurface");
		if (request.behavior.persistent) refuse("persistent");
		if (request.behavior.sessionMode === "fork" || request.fork === true)
			refuse("fork");
		if (request.handoff)
			throw new WorkerLaunchRefusal(
				`${this.name} execution does not support worktree handoffs; refused before acquisition.`,
			);
		// A worker child has no terminal for a person and no authority to spawn:
		// its launch spec grants children.report only (P3-10).
		if (request.behavior.interactive)
			throw new WorkerLaunchRefusal(
				`${this.name} execution does not support interactive children (a worker child has no terminal for a person; it ends by its FD 3 report); refused before acquisition.`,
			);
		if (request.behavior.selfSpawn)
			throw new WorkerLaunchRefusal(
				`${this.name} execution does not support children that spawn subagents (a worker child's grant is children.report only); refused before acquisition.`,
			);
		// Root decision (P3-7 open items): the identity travels as the first input's
		// preamble, accepted as interim append semantics only; replacing the system
		// prompt waits for a typed LaunchSpec field.
		if (
			request.behavior.systemPromptMode === "replace" &&
			request.behavior.identity?.trim()
		)
			throw new WorkerLaunchRefusal(
				`${this.name} execution cannot replace a child's system prompt (B2's LaunchSpec has no system-prompt field; the role identity is only the first input's preamble); refused before acquisition.`,
			);
		const skills = request.behavior.skills?.trim();
		if (skills && !this.#options.childSpec?.resources)
			throw new WorkerLaunchRefusal(
				`${this.name} execution needs the host's resource mapping for skills (${skills}); refused before acquisition.`,
			);
		const plan = request.runtimePlan;
		if (!plan.provider || !plan.modelId || !plan.thinking)
			throw new WorkerLaunchRefusal(
				`${this.name} execution needs an explicit provider, model and thinking level; refused before acquisition.`,
			);
		return request;
	}

	/** Protocol negotiation, once: a worker speaking another major is refused before any acquisition. */
	async #hello(): Promise<void> {
		this.#negotiated ??= this.#client.hello().then(
			() => undefined,
			(error) => {
				this.#negotiated = undefined;
				throw new WorkerLaunchRefusal(
					`Cannot negotiate B2 with the worker (${errorText(error)}); refused before acquisition.`,
				);
			},
		);
		await this.#negotiated;
	}

	/** The parent's current binding and running execution: a typed child names both. */
	async #parentBinding() {
		const id = this.#options.parentWorkerId;
		let parent: Worker;
		try {
			parent = await this.#client.call("workers.get", {
				path: { worker_id: id },
			});
		} catch (error) {
			throw new WorkerLaunchRefusal(
				`Cannot read the parent worker (${errorText(error)}); refused before acquisition.`,
			);
		}
		const running = parent.execution;
		if (
			parent.status !== "ready" ||
			!parent.session_id ||
			!running ||
			running.state === "settled" ||
			parent.fence
		)
			throw new WorkerLaunchRefusal(
				`The parent worker has no running, unfenced execution to launch a child from; refused before acquisition.`,
			);
		return {
			worker_id: parent.worker_id,
			worker_epoch: parent.worker_epoch,
			session_id: parent.session_id,
			binding_revision: parent.binding_revision,
			execution_id: running.execution_id,
		};
	}

	#childSpec(request: FreshPiLaunchRequest, slot: ClaimedSlot): LaunchSpec {
		const options = this.#options.childSpec ?? {};
		const denied = [...new Set(request.behavior.deniedTools)];
		const named = request.behavior.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		const tools = [
			...new Set(
				named ?? options.defaultTools ?? ["read", "bash", "edit", "write"],
			),
		].filter((tool) => !denied.includes(tool));
		const filesystem = options.filesystem ?? "bwrap";
		const environment: LaunchSpec["environment"] = {
			id: `maestro-${slot.name}`,
			revision: 1,
			allowed_methods: [...MAESTRO_WORKER_CHILD_METHODS],
			base_sha: slot.baseSha,
			filesystem,
		};
		// B2 requires a sandbox's root to be its cwd; a parent's channel normalizes
		// the create the same way, so the request hash is the one B2 records.
		if (filesystem === "bwrap") environment.root = slot.path;
		return {
			environment,
			role: request.agent ?? "subagent",
			tools,
			denied_tools: denied,
			resources: options.resources?.(request) ?? { extensions: [], skills: [] },
			grant_methods: [...MAESTRO_WORKER_CHILD_METHODS],
			seed_mode: "standalone",
		};
	}

	/** Pi's shared record for this execution: paths under the parent-private runs directory only. */
	#record(
		request: FreshPiLaunchRequest,
		slot: ClaimedSlot,
		runId: string,
		taskId: string,
		generationId: string,
	): PiExecution {
		const startTime = this.#now();
		const runs = this.#options.runsDir;
		// Its own identity: the run handle (session ID) never carries the provider reference.
		const record = uuidv7(this.#now());
		const child: PiExecution = {
			id: runId,
			name: request.name,
			task: request.task,
			startTime,
			sessionFile: join(runs, `${record}.jsonl`),
			activityFile: join(runs, `${record}.activity.json`),
			interactive: false,
			runtimePlan: request.runtimePlan,
			cwd: slot.path,
			lifecycle: createLifecycle(startTime),
			persistent: false,
			generationId,
			taskId,
		};
		if (request.agent !== undefined) child.agent = request.agent;
		if (request.behavior.logicalId !== undefined)
			child.logicalId = request.behavior.logicalId;
		if (request.accept !== undefined) child.accept = request.accept;
		return child;
	}

	#notAcquired(launchId: string, slot: ClaimedSlot): void {
		const { launches, slots } = this.#options;
		launches.update(launchId, (manifest) => {
			manifest.state = "not_acquired";
		});
		launches.discard(launchId);
		slots.release(slot.name, launchId);
	}

	/** Runs one store write; returns its failure instead of throwing (the store may be failing). */
	#tryWrite(write: () => void): string | undefined {
		try {
			write();
			return undefined;
		} catch (error) {
			return errorText(error);
		}
	}

	/**
	 * Sends one mutation once. Its command is durable first; a lost reply is
	 * reconciled by one receipt read, never by sending again. Throws only
	 * before the transport (its command could not be recorded: nothing sent);
	 * a store that fails after it is reported as `unrecorded`, never thrown.
	 */
	async #mutate(
		launchId: string,
		purpose: WorkerCommandPurpose,
		operation: WorkerMutation,
		hash: string,
		workerId: string | undefined,
		commandId: string,
		send: () => Promise<Receipt>,
		inputId?: string,
	): Promise<Sent> {
		const { launches } = this.#options;
		const command: Parameters<WorkerLaunchStore["record"]>[1] = {
			command_id: commandId,
			operation,
			purpose,
			request_hash: hash,
		};
		if (workerId !== undefined) command.worker_id = workerId;
		if (inputId !== undefined) command.input_id = inputId;
		launches.record(launchId, command);
		const expected: Expected = {
			command_id: commandId,
			operation,
			request_hash: hash,
		};
		if (workerId !== undefined) expected.worker_id = workerId;
		let settled: Settled;
		try {
			settled = classifyReceipt(await send(), expected);
		} catch (error) {
			if (error instanceof ClientFailure && error.effect === "no_effect")
				settled = error;
			else settled = await reconcile(this.#client, expected);
		}
		const outcome =
			settled instanceof ClientFailure ? "no_effect" : settled.outcome;
		const unrecorded = this.#tryWrite(() =>
			launches.settle(launchId, commandId, outcome, failureCode(settled)),
		);
		return unrecorded === undefined ? { settled } : { settled, unrecorded };
	}

	// ---- observation ----

	#execution(handle: ExecHandle): WorkerExecution {
		const execution =
			handle.provider === this.name
				? this.#executions.get(handle.ref)
				: undefined;
		if (!execution)
			throw new Error(`Unknown ${this.name} execution ${handle.ref}`);
		return execution;
	}

	async #read(execution: WorkerExecution): Promise<RowRead> {
		try {
			return {
				kind: "row",
				worker: await this.#client.call("workers.get", {
					path: { worker_id: execution.workerId },
				}),
			};
		} catch (error) {
			const code = errorText(error);
			return error instanceof ClientFailure &&
				error.phase === "http" &&
				code === "unknown_worker"
				? { kind: "missing", error: code }
				: { kind: "unavailable", error: code };
		}
	}

	async #bindingOf(workerId: string) {
		try {
			const worker = await this.#client.call("workers.get", {
				path: { worker_id: workerId },
			});
			return worker.session_id
				? {
						worker_epoch: worker.worker_epoch,
						session_id: worker.session_id,
						binding_revision: worker.binding_revision,
					}
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Takes the claims a row lists: help claims are kept, the first result
	 * claim becomes the completion record. A stopped child whose report pipe
	 * may still be draining is re-read for a bounded time before its absence
	 * of a report is believed.
	 */
	async #absorb(execution: WorkerExecution, read: RowRead): Promise<RowRead> {
		let current = read;
		const deadline =
			this.#now() + (this.#options.reportDrainMs ?? REPORT_DRAIN_MS);
		for (;;) {
			if (current.kind !== "row") return current;
			const worker = current.worker;
			const claims = worker.child_reports ?? [];
			for (const claim of claims)
				if (
					claim.kind === "help" &&
					!execution.help.some((seen) => seen.command_id === claim.command_id)
				)
					execution.help.push(claim);
			const result = claims.find((claim) => claim.kind === "result");
			if (result && execution.transcribed === undefined)
				await this.#transcribe(execution, result);
			if (
				result ||
				execution.drained ||
				LIVE_STATUSES.has(worker.status) ||
				this.#now() >= deadline
			) {
				if (!LIVE_STATUSES.has(worker.status)) execution.drained = true;
				return current;
			}
			await delay(50);
			current = await this.#read(execution);
		}
	}

	/** Mirrors the child's history, then writes the completion record the shared adapter reads. */
	async #transcribe(
		execution: WorkerExecution,
		claim: ChildClaim,
	): Promise<void> {
		execution.transcribed = claim.command_id;
		const { sessionFile } = execution.child;
		const decoded = decodeResultClaim(claim.message);
		execution.claim = decoded;
		let entries: HistoryEntry[] = [];
		try {
			entries = await this.#history(execution.workerId);
		} catch {
			/* history is readback only; the claim still completes */
		}
		const hasAssistant = entries.some(
			(entry) =>
				entry.type === "message" && messageOfEntry(entry)?.role === "assistant",
		);
		if (!hasAssistant && decoded.type !== "invalid" && decoded.summary)
			entries.push({
				type: "message",
				source: "child-report-claim",
				message: {
					role: "assistant",
					content: [{ type: "text", text: decoded.summary }],
					stopReason: "stop",
				},
			});
		writeDurable(
			sessionFile,
			entries.map((entry) => JSON.stringify(entry)).join("\n") +
				(entries.length ? "\n" : ""),
		);
		const sidecar =
			decoded.type === "done"
				? decoded.accept === undefined
					? { type: "done" }
					: { type: "done", accept: decoded.accept }
				: decoded.type === "error"
					? {
							type: "error",
							errorMessage: decoded.errorMessage ?? "Child reported an error",
						}
					: { type: "unrecognized-report-claim" };
		writeFileSync(`${sessionFile}.exit`, JSON.stringify(sidecar), {
			mode: 0o600,
		});
		this.#wake(execution);
	}

	/** Every history entry of the worker's session, oldest first (bounded). */
	async #history(workerId: string): Promise<HistoryEntry[]> {
		const entries: HistoryEntry[] = [];
		let cursor: { watermark: string; after: string } | undefined;
		for (let page = 0; page < HISTORY_PAGES; page++) {
			const query: HistoryQuery = {
				limit: HISTORY_PAGE,
			};
			if (cursor) {
				query.watermark = cursor.watermark;
				query.after = cursor.after;
			}
			const result = await this.#client.call("history.page", {
				path: { worker_id: workerId },
				query,
			});
			entries.push(...result.entries);
			if (!result.next?.after) break;
			cursor = { watermark: result.next.watermark, after: result.next.after };
		}
		return entries;
	}

	#startObserver(): void {
		if (this.#observer || this.#closed) return;
		const abort = new AbortController();
		const options = this.#options.observer;
		const observerOptions: ConstructorParameters<typeof Observer>[0] = {
			client: this.#client,
			signal: abort.signal,
			deliver: async (batch) => {
				await options?.persist?.(batch, (id) => this.#observer?.row(id));
				this.#observerState = batch.state;
				for (const notice of batch.notices)
					if ("worker_id" in notice) {
						const execution = this.#byWorker.get(notice.worker_id);
						if (execution) this.#wake(execution);
					}
			},
			pending: () => this.#pending(),
		};
		if (options?.restored) observerOptions.restored = options.restored;
		if (options?.backoff) observerOptions.backoff = options.backoff;
		const observer = new Observer(observerOptions);
		this.#observer = observer;
		this.#observerAbort = abort;
		this.#observerRun = observer.run().then((stop) => {
			for (const execution of this.#executions.values()) this.#wake(execution);
			return stop;
		});
	}

	/** Commands whose outcome is not proven: the Observer reconciles them after a settlement gap. */
	#pending(): Expected[] {
		return this.#options.launches.list().flatMap((manifest) =>
			manifest.commands
				.filter((c) => c.outcome === "pending" || c.outcome === "unknown")
				.map((c) => {
					const expected: Expected = {
						command_id: c.command_id,
						operation: c.operation,
						request_hash: c.request_hash,
					};
					if (c.worker_id !== undefined) expected.worker_id = c.worker_id;
					return expected;
				}),
		);
	}

	#wake(execution: WorkerExecution): void {
		const waiters = [...execution.waiters];
		execution.waiters.clear();
		for (const wake of waiters) wake();
	}

	/** Resolves on the next notice for this worker, after `intervalMs`, or on abort. */
	#changed(
		execution: WorkerExecution,
		signal: AbortSignal,
		intervalMs: number,
	): Promise<void> {
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				execution.waiters.delete(finish);
				resolve();
			};
			const timer = setTimeout(finish, intervalMs);
			signal.addEventListener("abort", finish, { once: true });
			execution.waiters.add(finish);
		});
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no static type; only an Error's own message is read. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "unknown failure";
}

function observed(settled: Settled): Receipt | undefined {
	return settled instanceof ClientFailure || settled.outcome !== "observed"
		? undefined
		: settled.receipt;
}

/** What a sent command's reply or receipt proved, in words. */
function provenText(settled: Settled): string {
	if (isNoEffect(settled)) return "refused";
	const receipt = observed(settled);
	return receipt ? (receipt.admission ?? "observed") : "of unknown outcome";
}

function isNoEffect(settled: Settled): boolean {
	return settled instanceof ClientFailure
		? settled.effect === "no_effect"
		: settled.outcome === "no_effect";
}

/** A refusal code or unknown reason: never a payload, never a value from the reply. */
function failureCode(settled: Settled): string {
	if (settled instanceof ClientFailure) return settled.message;
	if (settled.outcome === "unknown") return settled.reason;
	return settled.receipt.error ?? settled.receipt.state;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- history entries are pi's raw session lines (an open object in the B2 schema); only their message text is read, checked field by field. */
/** A history entry's pi message (role and text blocks), or undefined. */
function messageOfEntry(
	entry: HistoryEntry,
): { role: string; texts: string[] } | undefined {
	const message = entry.message;
	if (message === null || typeof message !== "object" || Array.isArray(message))
		return undefined;
	const role = "role" in message ? message.role : undefined;
	const content = "content" in message ? message.content : undefined;
	if (typeof role !== "string") return undefined;
	const texts = Array.isArray(content)
		? content.flatMap((block) =>
				block !== null &&
				typeof block === "object" &&
				block.type === "text" &&
				typeof block.text === "string"
					? [block.text]
					: [],
			)
		: [];
	return { role, texts };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The text lines of one history entry: message text, oldest first. */
function entryLines(entry: HistoryEntry): string[] {
	if (entry.type !== "message") return [];
	const message = messageOfEntry(entry);
	return message ? message.texts.join("\n").split("\n") : [];
}
