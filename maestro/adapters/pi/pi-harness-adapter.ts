import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type {
	HarnessAdapter,
	ResumeOptions,
	SpawnOptions,
} from "../../core/harness-adapter.ts";
import type {
	AgentHandle,
	AgentState,
	CompletionEvidence,
} from "../../core/types.ts";
import type { SurfaceProvider } from "../../core/surface-provider.ts";
import {
	execRefusal,
	projectAgentHandle,
	type ExecHandle,
	type ExecRequirement,
} from "../../core/exec-provider.ts";
import { readSubagentActivityFile } from "./activity-file.ts";
import {
	markCompletionDetected,
	markInterruptRequested,
	observeActivity,
	observePaneInspection,
} from "../../core/lifecycle.ts";
import type { PaneConfig } from "../../core/config/pane-config.ts";
import {
	isThinkingLevel,
	parseExactModelRef,
	resolveRuntimePlan,
	type ModelRegistryAdapter,
	type ParentRuntime,
	type ResolvedRuntimePlan,
} from "../../core/routing.ts";
import type { FileWakeRegistry } from "../../core/wake.ts";
import type { SupervisionCoordinator } from "../../core/supervision.ts";
import {
	judgeProcessIdentity,
	linuxProcessProbe,
	type ProcessIdentityProbe,
} from "./process-identity.ts";
import type { PiLaunchOperations } from "./launch-operations.ts";
import type {
	PiLaunchRequest,
	FreshPiLaunchRequest,
	PiRunningChild,
} from "./launch.ts";
import {
	TerminalExecProvider,
	type PiExecProvider,
} from "./terminal-exec-provider.ts";
import type { WorktreeOperations } from "../../core/worktree.ts";
import { shellExitFileFor, waitForCompletion } from "./completion.ts";
import { acceptLaunchRefusal } from "../../core/accept.ts";
import { notifyLaunchRefusal } from "../../core/specialist-notice.ts";
import {
	EXIT_OUTPUT_READ_TIMEOUT_MS,
	EXIT_OUTPUT_SCREEN_LINES,
	extractExitOutput,
	readWithin,
} from "./exit-output.ts";
import {
	appendPersistentDeliveryLedger,
	findObservedSessionRuntime,
	getNewEntries,
	inspectFinalAssistantMessage,
	readPersistentTaskEvents,
} from "./session.ts";

export interface PiSpawnOptions extends SpawnOptions {
	/** Pi host normalization: retain validation/provenance and raw cwd/config origins.
	 * Presence selects this snapshot, including intentionally omitted agent/tools/cwd.
	 * Generic callers continue to resolve their role/runtime through the adapter.
	 */
	resolvedLaunch?: {
		runtimePlan: ResolvedRuntimePlan;
		agent?: string;
		cwd?: string;
		roleCwd?: string;
		tools?: string;
	};
	/** Preserve opaque host identities during the staged migration. Not the core task/session ID. */
	launchIdentity?: {
		id?: string;
		logicalId?: string;
		generationId?: string;
		taskId?: string;
	};
}
export interface PiHarnessAdapterOptions {
	childEntryPath?: string;
	/**
	 * The one execution provider for this adapter's runs. Default: the terminal
	 * implementation over `surface`, `paneConfig` and `operations`.
	 */
	exec?: PiExecProvider;
	/** Terminal composition; required unless `exec` is supplied. */
	surface?: SurfaceProvider;
	/** Terminal pane placement; required unless `exec` or `operations` is supplied. */
	paneConfig?: PaneConfig;
	modelRegistry: ModelRegistryAdapter;
	parent: FreshPiLaunchRequest["parent"];
	/** Compatibility only; supervision owns its wake registry and registrations. */
	wake?: FileWakeRegistry;
	supervision: SupervisionCoordinator;
	/** The active parent's registry runtime can precede persisted model-change entries. */
	parentRuntime?: ParentRuntime;
	/** Optional launch-operation injection, keeping the real Pi protocol in unit tests. */
	operations?: PiLaunchOperations;
	worktreeOperations?: WorktreeOperations;
	/** Kernel process facts for a retained worktree child's identity; tests inject it. */
	processProbe?: ProcessIdentityProbe;
	/** Bound for confirming a retained worktree child's exit. Default: 5000ms. */
	killTimeoutMs?: number;
	/** Explicit local evidence/lifecycle bridge. The host still owns delivery and deduplication. */
	onObservation?(
		child: PiRunningChild,
		kind:
			| "local-evidence"
			| "pane"
			| "tick"
			| "completion"
			| "state"
			| "interrupt",
	): void;
}
interface CompletionWait {
	controller: AbortController;
	promise: Promise<CompletionEvidence>;
	waiters: number;
}

/** Pi's existing launch and child-sidecar protocol behind the harness seam. */
export class PiHarnessAdapter implements HarnessAdapter {
	readonly name = "pi";
	private readonly options: PiHarnessAdapterOptions;
	private readonly exec: PiExecProvider;
	private readonly children = new Map<string, PiRunningChild>();
	private readonly execHandles = new WeakMap<PiRunningChild, ExecHandle>();
	private readonly evidence = new Map<string, CompletionEvidence>();
	private readonly waits = new Map<string, CompletionWait>();
	constructor(options: PiHarnessAdapterOptions) {
		this.options = options;
		if (options.exec) this.exec = options.exec;
		else if (options.surface)
			this.exec = new TerminalExecProvider({
				surface: options.surface,
				paneConfig: options.paneConfig,
				operations: options.operations,
				worktreeOperations: options.worktreeOperations,
				processProbe: options.processProbe,
				killTimeoutMs: options.killTimeoutMs,
			});
		else
			throw new Error(
				"Pi harness adapter requires an execution provider or a terminal surface",
			);
	}
	isAvailable(): boolean {
		return (process.env.PATH ?? "").split(delimiter).some((directory) => {
			try {
				const path = join(directory, "pi");
				accessSync(path, constants.X_OK);
				return statSync(path).isFile();
			} catch {
				return false;
			}
		});
	}
	async spawn(opts: PiSpawnOptions): Promise<AgentHandle> {
		this.rejectEnvironment(opts.env);
		if (opts.worktree && !opts.worktreeRequest)
			throw new Error(
				"Pi requires an unprovisioned worktreeRequest; it owns worktree acquisition",
			);
		// One ordinary attempt per spawn; the run session owns retries and their evidence.
		if (opts.worktreeRequest && opts.runtime?.fallbacks?.length)
			throw new Error(
				"Model fallbacks are not supported for worktree subagents.",
			);
		if (
			opts.session?.parentSessionId &&
			opts.session.parentSessionId !== this.options.parent.sessionId
		)
			throw new Error(
				"Pi session parent identity does not match the launch parent",
			);
		const defaults = opts.role.defaults;
		const persistent =
			opts.behavior?.persistent ?? defaults?.persistent ?? false;
		const autoExit = persistent
			? false
			: (opts.behavior?.autoExit ?? defaults?.autoExit ?? false);
		const interactive =
			opts.behavior?.interactive ??
			opts.interactive ??
			(persistent ? false : (defaults?.interactive ?? !autoExit));
		const acceptRefusal =
			opts.accept && acceptLaunchRefusal({ persistent, autoExit });
		if (acceptRefusal) throw new Error(acceptRefusal);
		const notify = opts.behavior?.notify === true;
		const notifyRefusal = notifyLaunchRefusal({ persistent, notify });
		if (notifyRefusal) throw new Error(notifyRefusal);
		const denied = new Set([
			...(defaults?.denyTools ?? []),
			...(opts.behavior?.denyTools ?? []),
		]);
		if (defaults?.spawning === false)
			for (const name of [
				"subagent",
				"subagent_interrupt",
				"subagent_cancel",
				"subagent_send",
				"subagent_stop",
				"subagents_list",
				"subagent_resume",
			])
				denied.add(name);
		const resolved = opts.resolvedLaunch;
		const cwd = resolved ? resolved.cwd : opts.cwd;
		const roleCwd = resolved ? resolved.roleCwd : defaults?.cwd;
		const id = opts.launchIdentity?.id ?? randomUUID();
		const taskId = opts.launchIdentity?.taskId ?? randomUUID();
		const launch = await this.acquireChild({
			kind: "fresh",
			childEntryPath: this.options.childEntryPath,
			acquisitionSignal: opts.acquisitionSignal,
			id,
			name: opts.name,
			task: opts.task,
			agent: resolved ? resolved.agent : opts.role.name,
			cwd,
			worktree: opts.worktreeRequest,
			accept: opts.accept,
			// An omitted override must not force lineage-only/default fork to standalone.
			fork: opts.session
				? opts.session.mode === "fork"
					? true
					: opts.session.mode === "standalone"
						? false
						: undefined
				: undefined,
			surface: opts.surface?.id,
			parent: this.options.parent,
			runtimePlan:
				resolved?.runtimePlan ??
				resolveRuntimePlan(
					opts.runtime ?? {},
					defaults ?? {},
					this.parentRuntime(opts),
					this.options.modelRegistry,
				),
			modelScope: this.options.modelRegistry.scope,
			behavior: {
				tools: resolved
					? resolved.tools
					: (opts.tools ?? opts.role.allowedTools).join(","),
				cwd: roleCwd,
				skills: (opts.behavior?.skills ?? defaults?.skills)?.join(","),
				deniedTools: [...denied],
				// `spawning: false` removes the spawning tools, so it always wins.
				selfSpawn: defaults?.selfSpawn === true && defaults.spawning !== false,
				autoExit,
				interactive,
				persistent,
				notify,
				logicalId: opts.launchIdentity?.logicalId ?? id,
				generationId: opts.launchIdentity?.generationId ?? randomUUID(),
				taskId,
				identity: opts.systemPrompt ?? opts.role.systemPrompt,
				systemPromptMode:
					opts.behavior?.systemPromptMode ?? defaults?.systemPromptMode,
				sessionMode:
					opts.session?.mode ?? defaults?.sessionMode ?? "standalone",
			},
		});
		// Launch returns a fully initialized owner; no fallible I/O may separate
		// command dispatch from tracking (a rejection could start a fallback).
		return this.track(launch.launched, launch.handle);
	}
	async resume(opts: ResumeOptions): Promise<AgentHandle> {
		this.rejectEnvironment(opts.env);
		if (opts.surface)
			throw new Error("Pi public resume owns its new ordinary pane");
		if (opts.tools)
			throw new Error(
				"Pi resume restores saved tools; tool overrides are not supported",
			);
		const launch = await this.acquireChild({
			kind: "resume",
			childEntryPath: this.options.childEntryPath,
			acquisitionSignal: opts.acquisitionSignal,
			name: opts.name,
			sessionFile: opts.sessionId,
			message: opts.message,
			parent: this.options.parent,
			modelScope: this.options.modelRegistry.scope,
			behavior: { autoExit: opts.autoExit },
		});
		return this.track(launch.launched, launch.handle);
	}
	/**
	 * The one execution path: refuse what the provider cannot run before any
	 * acquisition, then launch. The provider transfers an acquired owner even
	 * when its dispatch is uncertain (`launchFailure`), never a made-up handle.
	 */
	private async acquireChild(request: PiLaunchRequest) {
		const refusal = execRefusal(this.exec, piLaunchRequirements(request));
		if (refusal) throw new Error(refusal);
		return this.exec.launch(request);
	}
	/** The provider's handle for a child this adapter tracks. */
	private execHandle(child: PiRunningChild): ExecHandle {
		const handle = this.execHandles.get(child);
		if (!handle) throw new Error(`Unknown Pi child ${child.id}`);
		return handle;
	}
	/** Temporary Pi-specific bridge for runtime migration; never infer task delivery from coarse state. */
	getRunningChild(handle: AgentHandle): PiRunningChild {
		const child = this.children.get(handle.id);
		if (
			!child ||
			handle.harness !== this.name ||
			handle.sessionId !== child.sessionFile
		)
			throw new Error(`Unknown Pi child ${handle.id}`);
		return child;
	}
	readPersistentEvents(handle: AgentHandle) {
		const child = this.getRunningChild(handle);
		return readPersistentTaskEvents(child.sessionFile).filter(
			(event) => event.generation === child.generationId,
		);
	}
	async getState(handle: AgentHandle): Promise<AgentState> {
		try {
			if (handle.harness !== this.name) return "unknown";
			if (this.evidence.has(this.runKey(handle))) return "done";
			const child = this.getRunningChild(handle);
			const read = readSubagentActivityFile(child.activityFile, child.id);
			let pane;
			try {
				pane = await this.exec.inspect(this.execHandle(child));
			} catch {
				pane = { kind: "unavailable" as const };
			}
			child.lifecycle = observeActivity(
				observePaneInspection(child.lifecycle, pane, Date.now()),
				read,
				Date.now(),
			);
			this.options.onObservation?.(child, "state");
			if (pane.kind !== "present") return "unknown";
			switch (child.lifecycle.turn.kind) {
				case "active":
					return "working";
				case "blocked":
				case "waiting":
					return "blocked";
				case "starting":
					return "idle";
				default:
					return "unknown";
			}
		} catch {
			return "unknown";
		}
	}
	async interrupt(handle: AgentHandle): Promise<void> {
		const child = this.getRunningChild(handle);
		await this.exec.interrupt(this.execHandle(child));
		child.lifecycle = markInterruptRequested(child.lifecycle, Date.now());
		this.options.onObservation?.(child, "interrupt");
	}
	/** Resolves only with termination evidence; otherwise rejects (unconfirmed). */
	async kill(handle: AgentHandle): Promise<void> {
		const child = this.getRunningChild(handle);
		const report = await this.exec.stop(this.execHandle(child));
		if (report.termination === "unconfirmed") throw report.error;
	}
	async readOutput(handle: AgentHandle, lines?: number): Promise<string> {
		const child = this.getRunningChild(handle);
		return this.exec.read(this.execHandle(child), lines);
	}
	exitCode(handle: AgentHandle): number | undefined {
		return this.evidence.get(this.runKey(handle))?.exitCode;
	}
	async sendInput(handle: AgentHandle, text: string): Promise<void> {
		const child = this.getRunningChild(handle);
		if (!child.persistent)
			throw new Error("child is not a persistent specialist");
		const task = randomUUID();
		const facts = {
			task,
			generation: child.generationId!,
			logicalId: child.logicalId!,
			policyHash: child.policyHash!,
		};
		if (
			this.evidence.has(this.runKey(handle)) ||
			child.launchFailure ||
			child.stopState ||
			child.taskId != null ||
			child.tasksCompleted == null
		) {
			appendPersistentDeliveryLedger(child.sessionFile, {
				...facts,
				outcome: "rejected-busy",
			});
			throw new Error(
				`Persistent specialist "${child.name}" is busy or stopped; task ${task} was rejected-busy. Resend after the pending result.`,
			);
		}
		// Claim the task before the provider await, so a concurrent send sees it
		// busy; a delivery that failed leaves the specialist as it was.
		const previousTask = child.taskId;
		child.taskId = task;
		const issued = (child.issuedTaskIds ??= []);
		issued.push(task);
		try {
			await this.exec.prompt(this.execHandle(child), { id: task, text });
		} catch (error) {
			if (child.taskId === task) child.taskId = previousTask;
			const index = issued.lastIndexOf(task);
			if (index !== -1) issued.splice(index, 1);
			throw error;
		}
		appendPersistentDeliveryLedger(child.sessionFile, {
			...facts,
			outcome: "dispatched",
		});
	}
	async awaitCompletion(
		handle: AgentHandle,
		signal: AbortSignal,
	): Promise<CompletionEvidence> {
		if (signal.aborted)
			throw new Error("Aborted while waiting for subagent to finish");
		const key = this.runKey(handle);
		const recorded = this.evidence.get(key);
		if (recorded) return recorded;
		const child = this.getRunningChild(handle);
		const execHandle = this.execHandle(child);
		let wait = this.waits.get(key);
		if (!wait || wait.controller.signal.aborted) {
			const controller = new AbortController();
			const registration = this.options.supervision.register(
				child.sessionFile,
				child.surface,
			);
			const next: CompletionWait = {
				controller,
				waiters: 0,
				promise: (async () => {
					if (child.launchFailure && !execHandle.capabilities.executionExit) {
						try {
							await this.kill(handle);
							return {
								reason: "error" as const,
								exitCode: 1,
								errorMessage: child.launchFailure,
								errorSource: "host" as const,
							};
						} catch {
							/* unconfirmed: keep the actual owner supervised and controllable */
						}
					}
					return waitForCompletion(controller.signal, {
						intervalMs: 1000,
						inspectExecution: execHandle.capabilities.executionExit
							? () => this.exec.reconcile(execHandle)
							: undefined,
						sessionFile: child.sessionFile,
						requireProcessExit: child.persistent || !!child.launchFailure,
						shellExitFile: child.persistent
							? shellExitFileFor(child.sessionFile)
							: undefined,
						inspectProcess: () =>
							child.processIdentity
								? judgeProcessIdentity(
										child.processIdentity,
										this.options.processProbe ?? linuxProcessProbe,
									).kind
								: "unknown",
						waitForNextCheck: registration.wait,
						readTerminalTail: async () =>
							// A caller-provided terminal can contain an earlier run's marker.
							child.launchFailure && !child.ownsSurface && !child.worktree
								? ""
								: this.exec.read(execHandle, 5),
						inspectPane: registration.inspectPane,
						onLocalEvidence: () =>
							this.options.onObservation?.(child, "local-evidence"),
						onPaneInspection: (pane, at) => {
							child.lifecycle = observePaneInspection(
								child.lifecycle,
								pane,
								at,
							);
							this.options.onObservation?.(child, "pane");
						},
						onTick: () => {
							this.options.onObservation?.(child, "tick");
						},
					});
				})()
					.then(async (result) => {
						if (child.launchFailure)
							result = {
								...result,
								reason: "error",
								exitCode: 1,
								errorMessage: child.launchFailure,
								errorSource: "host",
							};
						const entries = existsSync(child.sessionFile)
							? getNewEntries(child.sessionFile, 0)
							: undefined;
						const final = entries
							? inspectFinalAssistantMessage(entries)
							: undefined;
						const evidence: CompletionEvidence = {
							...result,
							sessionRef: child.sessionFile,
						};
						const exitOutput = await this.readExitOutput(
							child,
							result,
							entries,
						);
						if (exitOutput) evidence.exitOutput = exitOutput;
						if (final && (final.text != null || final.stopReason)) {
							evidence.finalMessage = {
								text: final.text ?? "",
								stopReason: final.stopReason,
							};
							if (final.stopReason === "error" && result.errorMessage)
								evidence.finalMessage.errorMessage = result.errorMessage;
						}
						// RunSession finalization is the single Git handoff capture owner.
						this.evidence.set(key, evidence);
						child.lifecycle = markCompletionDetected(
							child.lifecycle,
							result,
							Date.now(),
						);
						this.options.onObservation?.(child, "completion");
						return evidence;
					})
					.finally(() => {
						registration.unregister();
						if (this.waits.get(key) === next) this.waits.delete(key);
					}),
			};
			this.waits.set(key, next);
			wait = next;
		}
		return this.joinWait(wait, signal);
	}
	/**
	 * A child that failed before its session started has no transcript to
	 * explain it; relay the terminal's last lines instead (#149).
	 */
	private async readExitOutput(
		child: PiRunningChild,
		result: { exitCode: number; errorMessage?: string },
		entries: { type?: string }[] | undefined,
	): Promise<string | undefined> {
		if (
			result.exitCode === 0 ||
			result.errorMessage ||
			entries?.some((entry) => entry.type === "message")
		)
			return undefined;
		// The output only explains the failure; a terminal that cannot be read
		// in time leaves the exit code as the result.
		const screen = await readWithin(
			() => this.exec.read(this.execHandle(child), EXIT_OUTPUT_SCREEN_LINES),
			EXIT_OUTPUT_READ_TIMEOUT_MS,
		);
		return screen === undefined
			? undefined
			: extractExitOutput(screen, child.launchScriptFile);
	}
	private joinWait(
		wait: CompletionWait,
		signal: AbortSignal,
	): Promise<CompletionEvidence> {
		wait.waiters++;
		const abort = () =>
			rejectWait(new Error("Aborted while waiting for subagent to finish"));
		let rejectWait!: (error: Error) => void;
		return new Promise<CompletionEvidence>((resolve, reject) => {
			rejectWait = reject;
			signal.addEventListener("abort", abort, { once: true });
			wait.promise.then(resolve, reject);
		}).finally(() => {
			// Each consumer owns only its cancellation, never another consumer's wait.
			signal.removeEventListener("abort", abort);
			wait.waiters--;
			if (wait.waiters === 0) wait.controller.abort();
		});
	}
	private runKey(handle: Pick<AgentHandle, "id" | "sessionId">): string {
		// Legacy fallback retries reuse the opaque child ID, but create a new Pi session.
		return JSON.stringify([handle.id, handle.sessionId]);
	}
	private track(child: PiRunningChild, exec: ExecHandle): AgentHandle {
		this.children.set(child.id, child);
		this.execHandles.set(child, exec);
		return projectAgentHandle(exec, {
			id: child.id,
			name: child.name,
			role: child.agent ?? "",
			harness: this.name,
			cwd: child.cwd!,
			startedAt: child.startTime,
			sessionId: child.sessionFile,
			launchFailure: child.launchFailure || undefined,
			worktree: child.worktree
				? {
						id: child.id,
						owner: "maestro",
						branch: child.worktree.branch,
						baseRef: child.worktree.baseRef,
						baseSha: child.worktree.baseSha,
						createdAt: child.startTime,
						path: child.worktree.path,
						state: child.launchFailure ? "failed" : "running",
						manifestFile: child.worktree.manifestFile,
					}
				: undefined,
		});
	}
	private parentRuntime(opts: SpawnOptions): ParentRuntime {
		if (this.options.parentRuntime) return this.options.parentRuntime;
		const observed = existsSync(this.options.parent.sessionFile)
			? findObservedSessionRuntime(
					getNewEntries(this.options.parent.sessionFile, 0),
				)
			: {};
		if (
			observed.provider &&
			observed.modelId &&
			observed.thinking &&
			isThinkingLevel(observed.thinking)
		)
			return {
				provider: observed.provider,
				modelId: observed.modelId,
				thinking: observed.thinking,
			};
		const model = parseExactModelRef(
			opts.runtime?.model ?? opts.role.defaults?.model ?? "",
		);
		const thinking = opts.runtime?.thinking ?? opts.role.defaults?.thinking;
		if (model && thinking) return { ...model, thinking };
		throw new Error(
			"Pi launch requires the active parent runtime or explicit model and thinking",
		);
	}
	private rejectEnvironment(env: Record<string, string> | undefined): void {
		if (env && Object.keys(env).length)
			throw new Error(
				"The existing Pi launch protocol does not support per-child environment overrides",
			);
	}
}

/** What a Pi launch request needs from its execution provider. */
function piLaunchRequirements(request: PiLaunchRequest): ExecRequirement[] {
	if (request.kind === "resume") return ["resume"];
	const requirements: ExecRequirement[] = [
		request.worktree ? "worktree" : "sharedCheckout",
	];
	if (request.surface !== undefined) requirements.push("callerSurface");
	if (request.behavior.sessionMode === "fork") requirements.push("fork");
	if (request.behavior.persistent) requirements.push("persistent");
	return requirements;
}
