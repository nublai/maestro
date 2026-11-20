import { randomUUID } from "node:crypto";
import type { PaneConfig } from "../../core/config/pane-config.ts";
import {
	observeSupervision,
	type ExecCapabilities,
	type ExecHandle,
	type ExecLaunch,
	type ExecObserveOptions,
	type ExecPromptInput,
	type ExecReconciliation,
	type ExecRequirement,
	type ExecStopReport,
	type ExecStopRequest,
	type ExecSupervision,
} from "../../core/exec-provider.ts";
import type { SupervisionCoordinator } from "../../core/supervision.ts";
import type { PiExecProvider } from "./pi-harness-adapter.ts";
import type {
	AcquisitionControl,
	SurfaceProvider,
} from "../../core/surface-provider.ts";
import type { PaneInspection } from "../../core/types.ts";
import type { WorktreeOperations } from "../../core/worktree.ts";
import {
	launchOperationsFromSurface,
	settleBefore,
	type PiLaunchOperations,
} from "./launch-operations.ts";
import {
	AcquiredPiLaunchError,
	launchPiSubagent,
	startProcessIdentityCapture,
	type PiLaunchRequest,
	type PiRunningChild,
} from "./launch.ts";
import {
	judgeProcessIdentity,
	linuxProcessProbe,
	terminateProcessIdentity,
	type PiProcessIdentity,
	type ProcessIdentityProbe,
	type ProcessIdentityState,
} from "./process-identity.ts";
import { writePersistentTaskInbox } from "./session.ts";

/** Whether this stop's request has reached the execution yet. */
interface StopProgress {
	request: ExecStopRequest;
}

export type { PiExecProvider, PiExecution } from "./pi-harness-adapter.ts";

/** Herdr Core's existing refusal; the capability gate keeps its text. */
const CORE_REFUSAL =
	"Herdr Core supports ordinary native execution only; managed worktrees, handoffs and supplied panes are deferred";

export interface TerminalExecProviderOptions {
	/** The owning terminal provider: inspection, input, output and teardown. */
	surface: SurfaceProvider;
	/** Pane placement; required when `operations` is not injected. */
	paneConfig?: PaneConfig;
	/** Launch operations; default: from `surface` and `paneConfig`. */
	operations?: PiLaunchOperations;
	worktreeOperations?: WorktreeOperations;
	/** Kernel process facts for a retained worktree child's identity; tests inject it. */
	processProbe?: ProcessIdentityProbe;
	/** Bound for confirming a retained worktree child's exit. Default: 5000ms. */
	killTimeoutMs?: number;
	/**
	 * Batched pane presence and session-file wake-ups for completion. Without
	 * it each execution's completion polls `observe`.
	 */
	supervision?: SupervisionCoordinator;
}

/**
 * The existing Herdr/Core terminal execution behind the ExecProvider seam.
 * Launches run Pi's launch transaction in a pane (legacy Herdr) or as a
 * native program (Herdr Core); every later effect addresses that surface.
 */
export class TerminalExecProvider implements PiExecProvider<PiRunningChild> {
	readonly name: string;
	readonly capabilities: Readonly<ExecCapabilities>;
	readonly operations: PiLaunchOperations;
	private readonly options: TerminalExecProviderOptions;
	private readonly children = new Map<string, PiRunningChild>();

	constructor(options: TerminalExecProviderOptions) {
		this.options = options;
		// Like the pre-seam adapter, a missing placement surfaces at pane creation.
		this.operations =
			options.operations ??
			launchOperationsFromSurface(
				options.surface,
				options.paneConfig!,
				options.worktreeOperations,
			);
		if (this.operations.nativeExecution !== options.surface.nativeExecution)
			throw new Error(
				"Pi owning provider and launch operations must use the same native execution binding",
			);
		this.name = options.surface.name;
		const native = !!options.surface.nativeExecution;
		this.capabilities = Object.freeze({
			resume: true,
			fork: true,
			persistent: true,
			sharedCheckout: true,
			worktree: !native,
			callerSurface: !native,
			executionExit: native,
			// Terminal delivery is a host message: no receipt, no deduplication.
			parentAdmission: "best-effort",
		});
	}

	refusalMessage(requirement: ExecRequirement): string | undefined {
		return requirement === "worktree" || requirement === "callerSurface"
			? CORE_REFUSAL
			: undefined;
	}

	isAvailable(): boolean {
		return this.options.surface.isAvailable();
	}

	async launch(
		request: PiLaunchRequest,
		control?: AcquisitionControl,
	): Promise<ExecLaunch<PiRunningChild>> {
		if (control?.signal && control.signal !== request.acquisitionSignal) {
			if (request.acquisitionSignal)
				throw new Error(
					"Terminal launch has two acquisition signals; pass one",
				);
			request = { ...request, acquisitionSignal: control.signal };
		}
		let child: PiRunningChild;
		try {
			child = await launchPiSubagent(request, this.operations);
		} catch (error) {
			// The transaction transfers its fully initialized owner, not a made-up handle.
			if (!(error instanceof AcquiredPiLaunchError)) throw error;
			child = error.child;
		}
		return this.adopt(child);
	}

	/** Issue a handle for a child this terminal already hosts. */
	adopt(child: PiRunningChild): ExecLaunch<PiRunningChild> {
		const ref = randomUUID();
		this.children.set(ref, child);
		const launch: ExecLaunch<PiRunningChild> = {
			handle: Object.freeze({
				provider: this.name,
				ref,
				capabilities: this.capabilities,
				surfaceId: child.surface,
			}),
			launched: child,
		};
		if (child.launchFailure) launch.launchFailure = child.launchFailure;
		return launch;
	}

	async inspect(handle: ExecHandle): Promise<PaneInspection> {
		return this.options.surface.inspectSurface(this.child(handle).surface);
	}

	async *observe(
		handle: ExecHandle,
		options: ExecObserveOptions,
	): AsyncIterable<PaneInspection> {
		const surface = this.child(handle).surface;
		const intervalMs = options.intervalMs ?? 1_000;
		while (!options.signal.aborted) {
			let snapshot: PaneInspection;
			try {
				snapshot = await this.options.surface.inspectSurface(surface);
			} catch (error) {
				snapshot = { kind: "unavailable", error: errorText(error) };
			}
			if (options.signal.aborted) return;
			yield snapshot;
			if (snapshot.kind === "missing") return;
			await abortableDelay(intervalMs, options.signal);
		}
	}

	supervise(handle: ExecHandle): ExecSupervision {
		const child = this.child(handle);
		const coordinator = this.options.supervision;
		if (!coordinator) return observeSupervision(this, handle);
		const registration = coordinator.register(child.sessionFile, child.surface);
		return {
			wait: registration.wait,
			inspect: registration.inspectPane,
			close: registration.unregister,
		};
	}

	async read(handle: ExecHandle, lines?: number): Promise<string> {
		return this.options.surface.readScreen(this.child(handle).surface, lines);
	}

	async prompt(handle: ExecHandle, input: ExecPromptInput): Promise<void> {
		const child = this.child(handle);
		// Terminal hosts share the child's filesystem: Pi's task inbox is the input.
		writePersistentTaskInbox(
			child.sessionFile,
			(child.inboxSequence = (child.inboxSequence ?? 0) + 1),
			{ task: input.id, message: input.text },
		);
	}

	async interrupt(handle: ExecHandle): Promise<void> {
		await this.options.surface.sendKeys(this.child(handle).surface, "Escape");
	}

	async stop(handle: ExecHandle): Promise<ExecStopReport> {
		const child = this.child(handle);
		const progress: StopProgress = { request: "not-sent" };
		try {
			await this.terminate(child, progress);
			return { request: progress.request, termination: "confirmed" };
		} catch (error) {
			return { request: progress.request, termination: "unconfirmed", error };
		}
	}

	async reconcile(handle: ExecHandle): Promise<ExecReconciliation> {
		const child = this.child(handle);
		const native = this.options.surface.nativeExecution;
		if (native) return native.inspect(child.surface);
		let pane: PaneInspection;
		try {
			pane = await this.options.surface.inspectSurface(child.surface);
		} catch (error) {
			return { kind: "unavailable", error: errorText(error) };
		}
		// A legacy pane proves only its host's presence, never the program's exit.
		if (pane.kind === "present") return { kind: "live" };
		return pane.error === undefined ? { kind: pane.kind } : pane;
	}

	private child(handle: ExecHandle): PiRunningChild {
		const child =
			handle.provider === this.name ? this.children.get(handle.ref) : undefined;
		if (!child) throw new Error(`Unknown terminal execution ${handle.ref}`);
		return child;
	}

	/** Resolves only with termination evidence; otherwise rejects (unconfirmed). */
	private async terminate(
		child: PiRunningChild,
		progress: StopProgress,
	): Promise<void> {
		const surface = this.options.surface;
		if (surface.nativeExecution) {
			progress.request = "unknown";
			await surface.nativeExecution.terminate(child.surface);
			progress.request = "sent";
			return;
		}
		// A worktree root pane is the retained review workspace (Herdr refuses to
		// close it): stop only the owned Pi process and keep pane and checkout.
		if (child.worktree || !child.ownsSurface)
			return this.stopRetainedPi(child, progress);
		let closeError: unknown;
		progress.request = "unknown";
		try {
			await surface.closeSurface(child.surface);
			progress.request = "sent";
		} catch (error) {
			// Absence is still checked: a pane that is already gone is terminated.
			closeError = error;
		}
		try {
			await surface.waitForSurfaceAbsence(child.surface);
		} catch (error) {
			if (closeError === undefined) throw error;
			throw new Error(`${errorText(closeError)}; ${errorText(error)}`);
		}
	}

	/**
	 * Observation only, never a signal: the evidence kill() accepts, read again
	 * later. An unconfirmed cancel polls it, so a pane closed or a Pi that
	 * exited after the kill deadline still settles the run. A retained
	 * child is gone when its captured identity has exited, or when its pane is
	 * gone while that identity is not known alive; any other child, when its
	 * pane is gone. Without an identity a live pane proves nothing.
	 */
	async confirmTerminated(handle: ExecHandle): Promise<boolean> {
		const child = this.child(handle);
		const deadline = Date.now() + (this.options.killTimeoutMs ?? 5_000);
		const native = this.options.surface.nativeExecution;
		if (native) {
			const state = await settleBefore(
				Promise.resolve()
					.then(() => native.inspect(child.surface))
					.catch(() => undefined),
				deadline,
				{ unref: true },
			);
			return state?.kind === "finished" || state?.kind === "missing";
		}
		const retained = child.worktree || !child.ownsSurface;
		const probe = this.options.processProbe ?? linuxProcessProbe;
		const identityBefore = retained ? child.processIdentity : undefined;
		if (identityBefore) {
			const state = judgeProcessIdentity(identityBefore, probe);
			if (state.kind !== "unknown") return state.kind === "exited";
		}
		// Background observation never holds the process open.
		if (!(await this.paneIsMissing(child, deadline, { unref: true })))
			return false;
		// The inspection awaited: an identity captured meanwhile is judged too, and
		// confirms only while not known alive.
		const identity = retained ? child.processIdentity : undefined;
		return !identity || judgeProcessIdentity(identity, probe).kind !== "alive";
	}
	/** Herdr reports the pane absent; a failure or late answer is never "gone". */
	private async paneIsMissing(
		child: PiRunningChild,
		deadline: number,
		options: { unref?: boolean } = {},
	): Promise<boolean> {
		return (
			(
				await settleBefore(
					// Providers may throw synchronously or reject; both mean "unknown".
					Promise.resolve()
						.then(() => this.options.surface.inspectSurface(child.surface))
						.catch(() => undefined),
					deadline,
					options,
				)
			)?.kind === "missing"
		);
	}
	/**
	 * Exit evidence is only the launch-verified identity (PID + start time, on
	 * this boot and PID namespace) no longer existing, or a gone pane while that
	 * identity is not known alive. SIGTERM goes only to that identity,
	 * re-verified first; without it nothing is signalled and the cancel stays
	 * unconfirmed. A failed SIGTERM to a live identity stays unconfirmed unless
	 * that identity then exits. Herdr's foreground list and argv text are never
	 * evidence.
	 * Every provider await is bounded by the deadline, and a late answer is
	 * dropped, so an unconfirmed outcome is reported on time and never flipped.
	 */
	private async stopRetainedPi(
		child: PiRunningChild,
		progress: StopProgress,
	): Promise<void> {
		const probe = this.options.processProbe ?? linuxProcessProbe;
		const retainedDescription = child.worktree
			? "retained worktree pane"
			: "caller-provided pane";
		const timeoutMs = this.options.killTimeoutMs ?? 5_000;
		const deadline = Date.now() + timeoutMs;
		const paneGone = () => this.paneIsMissing(child, deadline);
		let identity = child.processIdentity;
		if (!identity) {
			// An expired capture gets one fresh attempt within this cancel's budget.
			if (child.processIdentityError !== undefined)
				startProcessIdentityCapture(child, this.operations, {
					timeoutMs: Math.max(0, deadline - Date.now()),
				});
			// Inspect alongside the capture wait so absence evidence is not
			// starved by it; the identity is re-read after the inspection.
			const absence = paneGone();
			const captured = await settleBefore(
				child.processIdentityCapture,
				deadline,
			);
			const gone = (child.processIdentity ?? captured) ? false : await absence;
			identity = child.processIdentity ?? captured;
			if (!identity) {
				if (gone) return;
				throw new Error(
					`Owned Pi process identity was not captured for ${retainedDescription} ${child.surface}; nothing was signalled: ${child.processIdentityError ?? (child.processIdentityCapture ? "identity capture is still pending" : "no identity was recorded at launch")}`,
				);
			}
		}
		let signalled = false;
		const verified = identity;
		const signal = (): ProcessIdentityState => {
			const before = judgeProcessIdentity(verified, probe);
			if (before.kind !== "alive") return before;
			progress.request = "unknown";
			const after = terminateProcessIdentity(verified, probe);
			if (after.kind === "alive") signalled = true;
			if (after.kind !== "unknown") {
				progress.request = "sent";
				return after;
			}
			// The identity was just known alive and the signal failed: only its
			// own exit confirms; pane absence never does.
			if (judgeProcessIdentity(verified, probe).kind === "exited")
				return { kind: "exited" };
			throw new Error(
				`Owned Pi process exit unconfirmed in ${retainedDescription} ${child.surface}: ${after.reason}; process ${verified.pid} was alive when signalled`,
			);
		};
		let state = signal();
		let paneSeenGone = false;
		for (;;) {
			if (state.kind === "exited") return;
			// Unknown is never signalled and waiting cannot make it evidence.
			if (state.kind === "unknown") {
				if (!paneSeenGone && !(await paneGone())) break;
				paneSeenGone = true;
				// The inspection awaited: confirm only while still not known alive.
				state = judgeProcessIdentity(identity, probe);
				if (state.kind === "alive" && !signalled) state = signal();
				if (state.kind !== "alive") return;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(50, remaining)),
			);
			state = judgeProcessIdentity(identity, probe);
		}
		throw new Error(
			`Owned Pi process exit unconfirmed in ${retainedDescription} ${child.surface}: ${describeIdentityState(identity, state, signalled, timeoutMs)}`,
		);
	}
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function describeIdentityState(
	identity: PiProcessIdentity,
	state: ProcessIdentityState,
	signalled: boolean,
	timeoutMs: number,
): string {
	if (state.kind === "unknown")
		return `${state.reason}${signalled ? " after SIGTERM" : "; not signalled"}`;
	return `process ${identity.pid} (start time ${identity.startTime}) is still ${state.kind} ${timeoutMs}ms after SIGTERM`;
}
