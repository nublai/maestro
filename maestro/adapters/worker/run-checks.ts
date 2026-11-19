/**
 * Worker runs under the shared run owner (P3-10): the V1 bound check and the
 * failure and cancellation hand-offs, composed explicitly by a worker parent.
 *
 * - `operations` launches each run through the shared Pi adapter over the
 *   worker provider (the task's own ID is the child's B2 task, so a restarted
 *   owner can find its launch) and finalizes it: a requested accept check is
 *   the V1 bound check (`bound-check.ts`), never the terminal re-check. Its
 *   command runs in a verified copy of the subject tree read from the parent
 *   root's repository (`materialize.ts`), never in the child's checkout.
 * - `describeOutcome` puts the check's verdict (command hash, exit or result,
 *   environment, termination) and both subjects, and the run's hand-off facts,
 *   into the outcome the run owner commits to the outbox.
 * - `persistCancelIntent` is the cancellation path's mandatory gate: the run's
 *   cancel intent is durable in its launch manifest before any stop the
 *   cancel leads to is sent; when the write fails no stop is sent and the
 *   cancel reports the failure.
 * - `prepare` refuses, before any acquisition, a model fallback list, which a
 *   worker child cannot honour (a persistent specialist is refused by the
 *   provider's capabilities, also before acquisition).
 * - `handOffInterrupted` turns each run a previous owner left open (a restart)
 *   into a host-authored hand-off outcome with its saved check subject, its
 *   commands, cancellation and termination facts and the parent's fence. It
 *   re-runs nothing and makes up no child result.
 *
 * Hand-off facts keep the child's termination and the parent's state apart:
 * a confirmed child stop says nothing about whether the parent may take more
 * input. A child stopped without a result report fences its parent
 * (invariant 4a, kept); the hand-off then names the fence and asks for owner
 * reconciliation, and nothing here clears it or relaunches anything. One
 * run's failure is its own outcome: nothing here touches a sibling.
 */
import { createHash } from "node:crypto";
import {
	isOutcomeStoreError,
	type OutcomeDraft,
	type OutcomeJson,
	type OutcomeJsonObject,
	type OutcomeStore,
	type StoredOutcome,
} from "../../core/outcome-store.ts";
import type { OutcomeAdmission } from "../../core/parent-admission.ts";
import type { AgentHandle, RunResult, Task } from "../../core/types.ts";
import type {
	OutcomeDescription,
	OwnedRunAttempt,
	PreparedRun,
	RunSessionHooks,
	RunSessionOperations,
} from "../../runtime/run-session.ts";
import type { AcceptCheckOwner } from "../pi/accept-groups.ts";
import { type AcceptRunner, runAcceptCommand } from "../pi/accept-runner.ts";
import type {
	PiExecution,
	PiHarnessAdapter,
} from "../pi/pi-harness-adapter.ts";
import {
	type CheckEnvironmentOptions,
	runWorkerBoundCheck,
	type WorkerBoundCheck,
} from "./bound-check.ts";
import type { WorkerAcquisitionManifest } from "./launch-store.ts";
import { type MaterializeLimits, objectsGitDir } from "./materialize.ts";
import type {
	WorkerExecutionProvider,
	WorkerRowState,
	WorkerRunBinding,
} from "./worker-exec-provider.ts";

export interface WorkerRunChecksOptions {
	provider: WorkerExecutionProvider;
	/** The shared Pi adapter over `provider`. */
	adapter: PiHarnessAdapter<PiExecution>;
	/** Maestro's parent-side accept runner. Default `runAcceptCommand`. */
	runner?: AcceptRunner;
	/** Stops running checks at the parent's shutdown. */
	owner?: AcceptCheckOwner;
	/**
	 * The accept command's synthetic environment: its source of allowlisted
	 * values, the variables the approved command declares, its scratch root.
	 */
	checkEnvironment?: CheckEnvironmentOptions;
	/**
	 * The Git directory whose object database the accept command's verified
	 * copy is read from. Default: the repository of the provider's parent root
	 * (`objectsGitDir`), resolved per check; never the child's checkout.
	 */
	repository?: string;
	/** Caps of the verified copy. Default `MATERIALIZE_LIMITS`. */
	materializeLimits?: Partial<MaterializeLimits>;
}

/** What one finalized run hands to its committed outcome. */
interface Described {
	check?: WorkerBoundCheck;
	handoff: OutcomeJsonObject;
	reportId?: string;
	generation?: string;
}

/** The text of a run handed off after its owner stopped: host-authored, never a child result. */
export const INTERRUPTED_RUN_TEXT =
	"Subagent run was interrupted: the parent's Maestro stopped before this run's outcome was recorded. Nothing was re-run; the facts below are what the worker and the run's records show.";

export class WorkerRunChecks {
	readonly #provider: WorkerExecutionProvider;
	readonly #adapter: PiHarnessAdapter<PiExecution>;
	readonly #runner: AcceptRunner;
	readonly #owner: AcceptCheckOwner | undefined;
	readonly #environment: CheckEnvironmentOptions | undefined;
	readonly #repository: () => string;
	readonly #limits: Partial<MaterializeLimits> | undefined;
	readonly #described = new WeakMap<Task, Described>();

	constructor(options: WorkerRunChecksOptions) {
		this.#provider = options.provider;
		this.#adapter = options.adapter;
		this.#runner = options.runner ?? runAcceptCommand;
		this.#owner = options.owner;
		this.#environment = options.checkEnvironment;
		const repository = options.repository;
		this.#repository = repository
			? () => repository
			: () => objectsGitDir(options.provider.parentRoot);
		this.#limits = options.materializeLimits;
	}

	/** Launch and finalization for `createRunSession({ operations })`. */
	readonly operations: RunSessionOperations = {
		prepare: async (task, role): Promise<PreparedRun> => {
			// Refused before acquisition (root decision 8), never downgraded.
			if (task.runtime?.fallbacks?.length)
				throw new Error(
					`${this.#provider.name} execution does not support model fallback lists (each attempt would be a new child in a new slot); refused before acquisition.`,
				);
			return {
				role,
				// A persistent run is refused by the provider's capabilities.
				persistent:
					task.behavior?.persistent ?? role.defaults?.persistent ?? false,
				candidates: task.runtime
					? [{ model: task.runtime.model, thinking: task.runtime.thinking }]
					: [],
				spawnAttempt: async (options, _index, cancelled) =>
					this.#spawn(task, options, cancelled),
			};
		},
	};

	/** One attempt: the shared adapter's launch, finalized with the bound check. */
	async #spawn(
		task: Task,
		options: Parameters<PreparedRun["spawnAttempt"]>[0],
		cancelled: Parameters<PreparedRun["spawnAttempt"]>[2],
	): Promise<OwnedRunAttempt> {
		const handle = await this.#adapter.spawn({
			...options,
			acquisitionSignal: cancelled,
			accept: task.accept,
			// The child's B2 task is the run's own: a restart finds its launch.
			launchIdentity: { taskId: task.id },
		});
		return {
			handle,
			adapter: this.#adapter,
			finalize: async (result, finalized, control) => {
				const described = await this.#finalize(
					handle,
					result,
					finalized,
					control,
				);
				this.#described.set(finalized, described);
				return result;
			},
		};
	}

	/** The run owner's hooks: the outcome's check and hand-off, the durable cancel intent. */
	readonly hooks: Required<
		Pick<RunSessionHooks, "describeOutcome" | "persistCancelIntent">
	> = {
		describeOutcome: (result, task) => this.describeOutcome(result, task),
		persistCancelIntent: (handle) => {
			const exec = this.#exec(handle);
			if (!exec) throw new Error("the run has no worker execution");
			// The gate: a failed write sends no stop (the run owner reports it).
			const failure = this.#provider.recordCancelIntent(exec);
			if (failure !== undefined)
				throw new Error(`the launch manifest write failed (${failure})`);
		},
	};

	describeOutcome(result: RunResult, task: Task): OutcomeDescription {
		const described = this.#described.get(task);
		if (!described) return {};
		const description: OutcomeDescription = {
			facts: { handoff: described.handoff },
		};
		if (described.check) {
			description.verdict = committedVerdict(described.check, result);
			if (described.check.subject)
				description.subject = described.check.subject;
		}
		if (described.reportId !== undefined)
			description.reportId = described.reportId;
		if (described.generation !== undefined)
			description.generation = described.generation;
		return description;
	}

	/**
	 * Hands off every run an earlier owner of `store` left open (attempts
	 * recorded, no outcome): one host-authored `interrupted` outcome each, with
	 * its saved check subject (the check is never re-run), its launch's
	 * commands, cancel intent and termination facts, and the parent's state;
	 * then closes that owner's run. A hand-off committed before a crash is not
	 * committed again. With `admission` each is handed to the outbox.
	 */
	async handOffInterrupted(
		store: OutcomeStore,
		admission?: OutcomeAdmission,
	): Promise<StoredOutcome[]> {
		const handed: StoredOutcome[] = [];
		const parent = await this.#provider.parentState();
		const launches = this.#provider.launchManifests();
		for (const run of store.recovery().interrupted) {
			if (run.owner === store.owner) continue;
			const deliveryId = interruptedDeliveryId(run.owner, run.taskId);
			let stored = store.get(deliveryId);
			if (!stored) {
				const launch = launches
					.filter((manifest) => manifest.task_id === run.taskId)
					.at(-1);
				const child = launch?.worker_id
					? await this.#provider.workerState(launch.worker_id)
					: undefined;
				const draft = interruptedDraft(run, deliveryId, launch, child, parent);
				if (admission)
					draft.envelope = admission.envelope({ ...draft, deliveryId });
				try {
					stored = await store.commit(draft);
				} catch (error) {
					// Delivered and retired since: the identity is final, never committed again.
					if (!isOutcomeStoreError(error, "conflict")) throw error;
				}
			}
			await store.closeRun(run.taskId, "handed off after restart", run.owner);
			if (stored) {
				handed.push(stored);
				if (admission) await admission.submit(stored.outcome.deliveryId);
			}
		}
		return handed;
	}

	#exec(handle: AgentHandle) {
		try {
			return this.#provider.handleOf(this.#adapter.getRunningChild(handle));
		} catch {
			return undefined;
		}
	}

	async #finalize(
		handle: AgentHandle,
		result: RunResult,
		task: Task,
		control: Parameters<NonNullable<OwnedRunAttempt["finalize"]>>[2],
	): Promise<Described> {
		const exec = this.#exec(handle);
		if (!exec)
			return { handoff: { worker: null, reason: "no worker execution" } };
		let check: WorkerBoundCheck | undefined;
		if (task.accept) {
			const input: Parameters<typeof runWorkerBoundCheck>[1] = {
				handle: exec,
				spec: task.accept,
				result,
				control,
				runner: this.#runner,
				owner: this.#owner,
				repository: this.#repository,
			};
			if (this.#environment) input.environment = this.#environment;
			if (this.#limits) input.materializeLimits = this.#limits;
			check = await runWorkerBoundCheck(this.#provider, input);
		}
		const binding = this.#provider.runBinding(exec);
		const manifest = this.#provider.manifest(exec);
		const [child, parent] = await Promise.all([
			binding
				? this.#provider.workerState(binding.workerId)
				: Promise.resolve(undefined),
			this.#provider.parentState(),
		]);
		const handoff = handoffFacts(manifest, binding, child, parent);
		if (check) {
			const termination = check.verdict.termination;
			if (termination !== undefined) handoff.termination = termination;
		}
		const described: Described = { handoff };
		if (check) described.check = check;
		if (binding?.claim && result.outcome !== "help")
			described.reportId = binding.claim.reportId;
		if (manifest?.binding) described.generation = manifest.binding.worker_epoch;
		return described;
	}
}

/**
 * The verdict the committed outcome carries, re-checked against the result
 * actually delivered: a run that delivers cancelled never carries a bound
 * verdict, whatever the check decided (`skipped (cancelled)` instead).
 */
export function committedVerdict(
	check: WorkerBoundCheck,
	result: RunResult,
): OutcomeJsonObject {
	if (!result.cancellation || !check.bound) return check.verdict;
	// The command's exit decided nothing: it is not carried as the verdict's.
	const { exitCode: _exit, ...evidence } = check.verdict;
	return {
		...evidence,
		verdict: "skipped",
		bound: false,
		reason: "cancelled",
		check: "cancelled",
	};
}

/** A stable delivery identity for one interrupted run of one earlier owner. */
export function interruptedDeliveryId(owner: string, taskId: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(["interrupted", owner, taskId]))
		.digest("hex");
	return `interrupted-${digest.slice(0, 32)}`;
}

/** A worker row as a fact: status, epoch, fence; or why it was not read. */
function stateFacts(state: WorkerRowState | undefined): OutcomeJson {
	if (!state) return null;
	if (state.kind === "missing") return { read: "missing" };
	if (state.kind === "unavailable")
		return { read: "unavailable", error: state.error };
	const facts: OutcomeJsonObject = {
		read: "row",
		status: state.status,
		worker_epoch: state.workerEpoch,
		fenced: state.fenced,
	};
	if (state.fenceCommandId !== undefined)
		facts.fence_command_id = state.fenceCommandId;
	return facts;
}

/** The parent's state, kept apart from the child's termination. */
function parentFacts(parent: WorkerRowState): OutcomeJsonObject {
	const facts: OutcomeJsonObject = { state: stateFacts(parent) };
	if (parent.kind === "row") {
		facts.may_take_input = parent.status === "ready" && !parent.fenced;
		// Invariant 4a: only the owner resolves a fence; nothing here clears it.
		if (parent.fenced) facts.needs = "owner-reconciliation";
	}
	return facts;
}

/** The commands a launch sent and what each proved (identity only, never a payload). */
function commandFacts(
	manifest: WorkerAcquisitionManifest | undefined,
): OutcomeJson {
	if (!manifest) return null;
	return manifest.commands.map((command) => {
		const facts: OutcomeJsonObject = {
			purpose: command.purpose,
			operation: command.operation,
			command_id: command.command_id,
			outcome: command.outcome,
		};
		if (command.reason !== undefined) facts.reason = command.reason;
		return facts;
	});
}

/** The hand-off facts of one finalized run. */
function handoffFacts(
	manifest: WorkerAcquisitionManifest | undefined,
	binding: WorkerRunBinding | undefined,
	child: WorkerRowState | undefined,
	parent: WorkerRowState,
): OutcomeJsonObject {
	const facts: OutcomeJsonObject = {
		worker: binding
			? {
					worker_id: binding.workerId,
					slot: binding.slot.name,
					branch: binding.slot.branch,
					base: binding.slot.baseSha,
				}
			: null,
		reports: binding
			? {
					result: binding.claim?.reportId ?? null,
					claimed_commit:
						binding.claim?.decoded.type === "done"
							? (binding.claim.decoded.commit ?? null)
							: null,
					help: binding.help,
				}
			: null,
		commands: commandFacts(manifest),
		child: stateFacts(child),
		parent: parentFacts(parent),
	};
	if (manifest?.uncertainty !== undefined)
		facts.launch_uncertainty = manifest.uncertainty;
	if (binding?.cancelRequestedAt !== undefined)
		facts.cancel = { requested_at: binding.cancelRequestedAt };
	return facts;
}

/** The host-authored hand-off of a run an earlier owner left open. */
function interruptedDraft(
	run: ReturnType<OutcomeStore["recovery"]>["interrupted"][number],
	deliveryId: string,
	launch: WorkerAcquisitionManifest | undefined,
	child: WorkerRowState | undefined,
	parent: WorkerRowState,
): OutcomeDraft {
	const attempt = run.attempts.at(-1)?.attempt ?? 1;
	const facts: OutcomeJsonObject = {
		handoff: {
			interrupted: {
				owner: run.owner,
				attempts: run.attempts.length,
				checks: run.checks.length,
			},
			worker: launch
				? {
						worker_id: launch.worker_id ?? null,
						slot: launch.slot.name,
						branch: launch.slot.branch,
						base: launch.slot.base_sha,
						launch_state: launch.state,
					}
				: null,
			commands: commandFacts(launch),
			child: stateFacts(child),
			parent: parentFacts(parent),
		},
	};
	const draft: OutcomeDraft = {
		taskId: run.taskId,
		attempt,
		kind: "result",
		generation: `interrupted:${run.owner}`,
		reportId: "interrupted-run",
		deliveryId,
		outcome: "interrupted",
		text: INTERRUPTED_RUN_TEXT,
		textSource: "host",
		facts,
		// The earlier owner's run is closed separately (`closeRun`).
		closesRun: false,
	};
	const check = run.checks.at(-1);
	if (check) {
		// Verification began and never committed: incomplete, never re-run.
		draft.verdict = {
			verdict: "error",
			bound: false,
			reason: "check interrupted",
			check: "interrupted",
		};
		const hash = check.subject.checkHash;
		if (hash !== undefined) draft.verdict.checkHash = hash;
		draft.subject = { before: check.subject };
	}
	if (launch?.cancel_requested_at !== undefined) {
		const stopped =
			child?.kind === "row" &&
			(child.status === "stopped" || child.status === "failed");
		draft.cancellation = {
			requestedAt: launch.cancel_requested_at,
			termination: stopped ? "confirmed" : "unconfirmed",
		};
	}
	return draft;
}
