/**
 * The ExecProvider seam: where one run actually executes.
 *
 * The run owner (RunSession) drives a HarnessAdapter; the shared Pi adapter
 * keeps the harness protocol (session files, policy, completion evidence) and
 * hands every execution effect to exactly one ExecProvider. The terminal
 * implementation runs children in Herdr/Core surfaces; a future worker
 * implementation runs them through B2. Neither is a fallback for the other:
 * the host composes one provider explicitly.
 *
 * Plain TypeScript, Promises, AbortSignal and AsyncIterable only. Shared DTOs
 * carry provider-owned opaque references and explicit capabilities, never
 * invented pane IDs, PIDs, socket paths or secrets.
 */
import type { AcquisitionControl } from "./surface-provider.ts";
import type { AgentHandle, PaneInspection } from "./types.ts";

/**
 * What a provider can execute. A request that needs a missing capability is
 * refused before any acquisition (no surface, worktree or worker exists yet),
 * never silently downgraded.
 */
export interface ExecCapabilities {
	/** Resume a saved harness session in a new execution. */
	resume: boolean;
	/** Start a child on a fork of the parent's session. */
	fork: boolean;
	/** A long-lived specialist that takes later tasks through `prompt`. */
	persistent: boolean;
	/** Run in the caller's own checkout, without an isolated worktree. */
	sharedCheckout: boolean;
	/** Run in a managed, isolated worktree. */
	worktree: boolean;
	/** Run inside a terminal surface the caller already owns. */
	callerSurface: boolean;
	/**
	 * `reconcile` reports the execution's own exit (with its exit code when
	 * known), not only whether its host is still present.
	 */
	executionExit: boolean;
	/**
	 * How a checked result reaches the parent. `best-effort`: a host message
	 * with no receipt and no deduplication (terminal hosts). `receipt`: the
	 * provider returns a durable admission receipt. Never advertise `receipt`
	 * for a delivery path that cannot prove it.
	 */
	parentAdmission: "best-effort" | "receipt";
}

/** The request-shaped capabilities a launch or resume can require. */
export type ExecRequirement =
	| "resume"
	| "fork"
	| "persistent"
	| "sharedCheckout"
	| "worktree"
	| "callerSurface";

export const EXEC_REQUIREMENTS: readonly ExecRequirement[] = [
	"resume",
	"fork",
	"persistent",
	"sharedCheckout",
	"worktree",
	"callerSurface",
];

const REQUIREMENT_TEXT = {
	resume: "resuming a saved session",
	fork: "forking the parent session",
	persistent: "persistent specialists",
	sharedCheckout: "running in the caller's checkout",
	worktree: "managed worktrees",
	callerSurface: "a caller-provided terminal surface",
} satisfies Record<ExecRequirement, string>;

/** One execution as the shared layer sees it. */
export interface ExecHandle {
	/** The issuing provider's `name`. */
	readonly provider: string;
	/** Provider-owned opaque reference. Callers never parse it. */
	readonly ref: string;
	/** The issuing provider's capabilities when this execution started. */
	readonly capabilities: Readonly<ExecCapabilities>;
	/**
	 * The terminal surface hosting this execution, present only when the
	 * provider really hosts it in one the host can address. Never invented.
	 */
	readonly surfaceId?: string;
}

/** A launch that acquired a real owner. */
export interface ExecLaunch<Launched> {
	handle: ExecHandle;
	/** The harness record for this execution, built by the provider's launch. */
	launched: Launched;
	/**
	 * Set when an owner was acquired but its dispatch or rollback is
	 * uncertain: it stays owned and controllable, and is never retried.
	 */
	launchFailure?: string;
}

/**
 * Execution-level fact from `reconcile`: whether the execution itself is live,
 * finished (with its exit code when known), gone, or unreadable now.
 */
export type ExecReconciliation =
	| { kind: "live" }
	| { kind: "finished"; exitCode?: number }
	| { kind: "missing" }
	| { kind: "unavailable"; error?: string };

/** Whether a stop request reached the execution. */
export type ExecStopRequest = "sent" | "not-sent" | "unknown";

/**
 * A stop reports the request and its confirmation separately. Only
 * `confirmed` is termination evidence; `unconfirmed` keeps the run owned.
 */
export type ExecStopReport =
	| { request: ExecStopRequest; termination: "confirmed" }
	| {
			request: ExecStopRequest;
			termination: "unconfirmed";
			/** The provider's own failure, preserved as thrown. */
			error: unknown;
	  };

export interface ExecPromptInput {
	/** Stable identifier of this input (task or command ID). */
	id: string;
	text: string;
}

export interface ExecObserveOptions {
	signal: AbortSignal;
	/** Poll interval for providers without push events. */
	intervalMs?: number;
}

export interface ExecProvider<Launch, Launched> {
	/** Stable provider name, recorded on every handle it issues. */
	readonly name: string;
	readonly capabilities: Readonly<ExecCapabilities>;
	/**
	 * Optional provider wording for a refused requirement, so an existing
	 * refusal keeps its text. The default names the provider and requirement.
	 */
	refusalMessage?(requirement: ExecRequirement): string | undefined;
	/** False when the provider cannot execute anything here. Never throws. */
	isAvailable(): boolean;
	/**
	 * Acquire and start one execution. An abort before acquisition starts
	 * nothing; once acquired, abort is admission intent only and never proof
	 * of remote cancellation. A rejection means no owner was acquired, except
	 * an `AcquisitionUncertainError`, whose outcome is unknown: never retry it.
	 */
	launch(
		request: Launch,
		control?: AcquisitionControl,
	): Promise<ExecLaunch<Launched>>;
	/** One presence snapshot of the execution's host. Pure observation. */
	inspect(handle: ExecHandle): Promise<PaneInspection>;
	/**
	 * Presence snapshots: the current one first, then later ones until the
	 * signal aborts or the host is gone (`missing`). A failed read yields
	 * `unavailable` instead of throwing.
	 */
	observe(
		handle: ExecHandle,
		options: ExecObserveOptions,
	): AsyncIterable<PaneInspection>;
	/** Recent output text, most recent `lines` lines. */
	read(handle: ExecHandle, lines?: number): Promise<string>;
	/** Deliver input to a live execution that accepts later tasks. */
	prompt(handle: ExecHandle, input: ExecPromptInput): Promise<void>;
	/** Ask the execution to stop its current turn; it keeps running. */
	interrupt(handle: ExecHandle): Promise<void>;
	/** Stop the execution. Never throws: an unconfirmed stop is a report. */
	stop(handle: ExecHandle): Promise<ExecStopReport>;
	/** Re-read the execution's own state. Pure observation. */
	reconcile(handle: ExecHandle): Promise<ExecReconciliation>;
}

/**
 * The refusal for the first requirement the provider cannot meet, or
 * undefined when it meets them all. Call before any acquisition.
 */
export function execRefusal(
	provider: Pick<
		ExecProvider<unknown, unknown>,
		"name" | "capabilities" | "refusalMessage"
	>,
	requirements: Iterable<ExecRequirement>,
): string | undefined {
	for (const requirement of requirements) {
		if (provider.capabilities[requirement]) continue;
		return (
			provider.refusalMessage?.(requirement) ??
			`${provider.name} execution does not support ${REQUIREMENT_TEXT[requirement]}; refused before acquisition.`
		);
	}
	return undefined;
}

/**
 * The shared projection of one execution onto the run owner's AgentHandle.
 * The surface ID is the provider's own, and only when it has one.
 */
export function projectAgentHandle(
	exec: ExecHandle,
	fields: Omit<AgentHandle, "surfaceId" | "pid">,
): AgentHandle {
	const { worktree, launchFailure, ...base } = fields;
	const handle: AgentHandle = { ...base };
	if (exec.surfaceId !== undefined) handle.surfaceId = exec.surfaceId;
	if (launchFailure !== undefined) handle.launchFailure = launchFailure;
	if (worktree) handle.worktree = worktree;
	return handle;
}
