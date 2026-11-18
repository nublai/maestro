/**
 * The V1 bound check (P3-10, plan section 6 "V1 check binding"): the parent's
 * accept check of a worker child's result, bound to the exact revision owner
 * Git reads, never to anything the child reports about itself.
 *
 * For a child that reported a result:
 * 1. Its termination is confirmed for the generation that ran (`stop`; only a
 *    stop of that epoch confirms), before any authoritative reading.
 * 2. `artifacts.inspect` at the worker's saved launch pin (owner Git, P3-6)
 *    resolves the slot's branch and the issued base: the base must be an
 *    ancestor, HEAD must be on the issued branch at that commit, a commit the
 *    child claimed must be that commit, and the checkout must be clean except
 *    for the worker's own staged runtime directories (listed, never ignored).
 *    The subject is the commit, its native tree, the base, the branch, the
 *    root and the pin's identity.
 * 3. The subject is durable (`recordCheck`) before the approved command runs
 *    with Maestro's parent-side accept runner in the slot, cancellable.
 * 4. The same inspection after the check must read the same subject and the
 *    same checkout status; anything else is a changed subject.
 *
 * A changed subject, a missing object, a pin mismatch, a dirty or conflicted
 * checkout, an unconfirmed termination or an inspection that is refused or
 * unanswered gives no accepted revision-bound verdict: `error`, with the
 * reason, and the command does not run when the subject was never bound. A
 * cancel that wins during the check is `skipped (cancelled)`, its own
 * outcome. Facts only: the verdict comes from the command's exit.
 */
import {
	acceptCheckHash,
	type AcceptOutcome,
	type AcceptSpec,
	skippedOutcome,
	verdictFromCommand,
} from "../../core/accept.ts";
import type { ExecHandle, ExecStopReport } from "../../core/exec-provider.ts";
import type {
	OutcomeJson,
	OutcomeJsonObject,
} from "../../core/outcome-store.ts";
import type { CompletionEvidence, RunResult } from "../../core/types.ts";
import type { FinalizeControl } from "../../runtime/run-session.ts";
import type { AcceptCheckOwner } from "../pi/accept-groups.ts";
import type { AcceptRunner } from "../pi/accept-runner.ts";
import type {
	ArtifactFacts,
	WorkerArtifactRead,
	WorkerRunBinding,
} from "./worker-exec-provider.ts";

/**
 * The worker's own runtime directories a sandboxed child's root holds (its
 * session directory and its staged profile, P2-7): untracked, accounted for
 * by name in the evidence, and required unchanged across the check. Any
 * other entry makes the checkout dirty.
 */
export const WORKER_RUNTIME_DIRECTORIES: readonly string[] = Object.freeze([
	".piw-agent/",
	".piw-worker/",
]);

/** What the bound check needs from the worker provider (`WorkerExecutionProvider`). */
export interface WorkerCheckPort {
	runBinding(handle: ExecHandle): WorkerRunBinding | undefined;
	stop(handle: ExecHandle): Promise<ExecStopReport>;
	inspectArtifact(
		handle: ExecHandle,
		request: { epoch: string; commit: string; base?: string },
	): Promise<WorkerArtifactRead>;
}

export interface WorkerBoundCheckInput {
	handle: ExecHandle;
	spec: AcceptSpec;
	result: RunResult;
	control: FinalizeControl;
	runner: AcceptRunner;
	/** Stops this check at shutdown (`accept-groups.ts`). */
	owner?: AcceptCheckOwner;
}

export interface WorkerBoundCheck {
	/** The delegation-outcome verdict and its evidence. */
	accept: AcceptOutcome;
	/** The verdict is bound to an inspected revision (`accepted` or `rejected` only). */
	bound: boolean;
	/** For the outcome store: verdict, command hash, exit/result, environment, termination. */
	verdict: OutcomeJsonObject;
	/** For the outcome store: the subject before and after the check, when read. */
	subject?: OutcomeJsonObject;
}

/** Where and how the command runs: Maestro's parent-side runner, never the worker. */
function environment(cwd: string): OutcomeJsonObject {
	return {
		runner: "maestro-parent-accept-runner",
		shell: "sh -c",
		cwd,
		// Variable names only, never values.
		env: "the parent process environment without PI_SUBAGENT_*",
	};
}

/** Why a requested check does not run; undefined when the run completed naturally. */
function skipReason(
	result: RunResult,
	evidence: CompletionEvidence | undefined,
): string | undefined {
	if (result.cancellation) return "cancelled";
	if (result.outcome === "killed") return "stopped before completion";
	if (evidence?.ping || result.outcome === "help") return "help request";
	if (evidence?.errorMessage) return "provider error";
	if (!evidence) return "run failed";
	if (result.outcome !== "completed" || evidence.exitCode !== 0)
		return `exit code ${evidence.exitCode}`;
	return undefined;
}

/** The bound subject read from one inspection, or why it binds nothing. */
type Judged =
	| { kind: "bound"; subject: OutcomeJsonObject }
	| { kind: "refused"; reason: string; facts?: OutcomeJsonObject };

/** The facts that identify a revision and its checkout (never the read's time). */
function subjectOf(
	facts: ArtifactFacts,
	root: string,
	runtime: readonly string[],
): OutcomeJsonObject {
	return {
		source: "artifacts.inspect",
		evidence: facts.provenance.evidence,
		worker_id: facts.worker_id,
		worker_epoch: facts.worker_epoch,
		root,
		branch: facts.head.ref,
		commit: facts.commit.commit_id,
		tree: facts.commit.tree_id,
		base: facts.base?.base_id ?? null,
		pin: facts.pin.sha256,
		pin_head_ref: facts.pin.head_ref,
		git_version: facts.provenance.git_version,
		replace_objects: facts.provenance.replace_objects,
		worktree: facts.worktree.state,
		runtime: [...runtime],
	};
}

/** What a refused or unanswered inspection says, as closed host text. */
function unread(read: WorkerArtifactRead, when: string): string {
	if (read.kind === "refused")
		return `artifact inspection ${when} refused (${read.code}${read.detail ? `: ${read.detail}` : ""})`;
	return `artifact inspection ${when} unavailable`;
}

/**
 * Binds one inspection to the issued slot, the confirmed generation and the
 * child's claim. Every condition fails closed.
 */
function judge(
	read: WorkerArtifactRead,
	binding: WorkerRunBinding,
	epoch: string,
	claimed: string | undefined,
	when: string,
): Judged {
	if (read.kind !== "facts")
		return { kind: "refused", reason: unread(read, when) };
	const { facts } = read;
	const refuse = (reason: string): Judged => ({
		kind: "refused",
		reason,
		facts: subjectOf(facts, binding.slot.path, []),
	});
	if (facts.worker_id !== binding.workerId || facts.worker_epoch !== epoch)
		return refuse("artifact facts name another worker or generation");
	const base = facts.base;
	if (!base || base.base_id !== binding.slot.baseSha || !base.is_ancestor)
		return refuse("the issued base is not an ancestor of the child's commit");
	if (
		facts.head.ref !== binding.slot.branch ||
		facts.pin.head_ref !== binding.slot.branch
	)
		return refuse("the checkout is not on its issued branch");
	if (!facts.head.matches_commit)
		return refuse("the checkout's HEAD is not its branch's commit");
	if (claimed !== undefined && claimed !== facts.commit.commit_id)
		return refuse("the child's claimed commit is not its branch's commit");
	const { worktree } = facts;
	if (worktree.state === "conflicted")
		return refuse("the checkout is conflicted");
	if (worktree.truncated) return refuse("the checkout's status is truncated");
	const runtime: string[] = [];
	let unexpected = 0;
	for (const entry of worktree.entries)
		if (entry.code === "??" && WORKER_RUNTIME_DIRECTORIES.includes(entry.path))
			runtime.push(entry.path);
		else unexpected++;
	if (unexpected)
		return refuse(
			`the checkout is dirty (${unexpected} unexpected ${unexpected === 1 ? "entry" : "entries"})`,
		);
	return {
		kind: "bound",
		subject: subjectOf(facts, binding.slot.path, runtime.sort()),
	};
}

/** The fields that differ between two bound subjects. */
function changed(
	before: OutcomeJsonObject,
	after: OutcomeJsonObject,
): string[] {
	return Object.keys(before).filter(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	);
}

function errorOutcome(spec: AcceptSpec, reason: string): AcceptOutcome {
	return {
		verdict: "error",
		reason,
		checkHash: acceptCheckHash(spec.run),
		timeoutSec: spec.timeoutSec,
	};
}

/**
 * Stops one bound check may make. B2 confirms a stop only once the child's
 * leader is proven gone; under load a stop that did end the child can be
 * `outcome_unknown`, and a later stop finds the end recorded. The same bound
 * as the ExecProvider conformance kit's repeated stops.
 */
export const TERMINATION_STOPS = 3;
const TERMINATION_RETRY_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no static type; only an Error's own message is read. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "unknown failure";
}

/**
 * Runs the V1 bound check of one worker run. Rejects only when the check's
 * subject could not be recorded (`recordCheck`): the command then never ran.
 */
export async function runWorkerBoundCheck(
	port: WorkerCheckPort,
	input: WorkerBoundCheckInput,
): Promise<WorkerBoundCheck> {
	const { spec, result, handle } = input;
	const record: Record<string, OutcomeJson> = {};
	const finish = (
		accept: AcceptOutcome,
		bound: boolean,
		subject?: OutcomeJsonObject,
	): WorkerBoundCheck => {
		const verdict: OutcomeJsonObject = {
			verdict: accept.verdict,
			bound,
			checkHash: accept.checkHash ?? acceptCheckHash(spec.run),
			timeoutSec: spec.timeoutSec,
			...record,
		};
		if (accept.reason !== undefined) verdict.reason = accept.reason;
		if (accept.exitCode !== undefined) verdict.exitCode = accept.exitCode;
		if (accept.tries !== undefined) verdict.tries = accept.tries;
		if (accept.childVerdict !== undefined)
			verdict.childVerdict = accept.childVerdict;
		const check: WorkerBoundCheck = { accept, bound, verdict };
		if (subject) check.subject = subject;
		return check;
	};
	const skip = skipReason(result, result.evidence);
	if (skip) {
		record.check = "not-run";
		return finish(skippedOutcome(spec, skip), false);
	}
	const binding = port.runBinding(handle);
	if (!binding) {
		record.check = "not-run";
		return finish(errorOutcome(spec, "the run's binding is unreadable"), false);
	}
	const claim = binding.claim;
	if (claim) record.reportId = claim.reportId;
	if (!claim || claim.decoded.type !== "done") {
		record.check = "not-run";
		return finish(errorOutcome(spec, "no result report to check"), false);
	}
	const claimed = claim.decoded.commit;
	record.claimedCommit = claimed ?? null;
	// 1. Termination of the generation that ran, before any authoritative read.
	// A stop the worker may not have observed (unconfirmed, sent or maybe sent)
	// is repeated, as an owner may, at most TERMINATION_STOPS in all; a stop
	// never sent, or one that rejects, is not. A repeat finding the row stopped
	// sends nothing.
	let stop: ExecStopReport;
	let stops = 0;
	for (;;) {
		stops++;
		try {
			stop = await port.stop(handle);
		} catch (error) {
			stop = { request: "not-sent", termination: "unconfirmed", error };
		}
		if (
			stop.termination === "confirmed" ||
			stop.request === "not-sent" ||
			stops >= TERMINATION_STOPS
		)
			break;
		await delay(TERMINATION_RETRY_MS);
	}
	const epoch = port.runBinding(handle)?.terminatedEpoch;
	const termination: OutcomeJsonObject = {
		request: stop.request,
		termination: stop.termination,
		stops,
	};
	if (epoch !== undefined) termination.epoch = epoch;
	if (stop.termination === "unconfirmed")
		termination.error = errorText(stop.error);
	record.termination = termination;
	if (stop.termination !== "confirmed" || epoch === undefined) {
		record.check = "not-run";
		return finish(errorOutcome(spec, "child termination not confirmed"), false);
	}
	// 2. The subject, read by owner Git at the saved launch pin.
	const request = {
		epoch,
		commit: binding.slot.branch,
		base: binding.slot.baseSha,
	};
	const before = judge(
		await port.inspectArtifact(handle, request),
		binding,
		epoch,
		claimed,
		"before the check",
	);
	if (before.kind !== "bound") {
		record.check = "not-run";
		return finish(
			errorOutcome(spec, before.reason),
			false,
			before.facts ? { before: before.facts } : undefined,
		);
	}
	const cwd = binding.slot.path;
	record.environment = environment(cwd);
	// 3. Durable before it runs; a rejection means the check never ran.
	if (input.control.recordCheck)
		await input.control.recordCheck({
			checkHash: acceptCheckHash(spec.run),
			cwd,
			...before.subject,
		});
	const command = await input.control.cancellable((signal) =>
		input.runner({
			run: spec.run,
			cwd,
			timeoutMs: spec.timeoutSec * 1000,
			signal,
			owner: input.owner,
		}),
	);
	record.result = command.kind;
	const interruption = input.control.interruption();
	if (interruption) {
		record.check = interruption;
		const skipped = skippedOutcome(
			spec,
			interruption === "cancelled" ? "cancelled" : "parent shut down",
		);
		skipped.cwd = cwd;
		return finish(skipped, false, { before: before.subject });
	}
	record.check = "ran";
	// 4. The same subject and checkout after the check, or no bound verdict.
	const after = judge(
		await port.inspectArtifact(handle, request),
		binding,
		epoch,
		claimed,
		"after the check",
	);
	const subjects: OutcomeJsonObject = { before: before.subject };
	if (after.kind === "bound") subjects.after = after.subject;
	else if (after.facts) subjects.after = after.facts;
	if (after.kind !== "bound") {
		const outcome = errorOutcome(spec, `subject changed: ${after.reason}`);
		if (command.kind === "exit") outcome.exitCode = command.exitCode;
		outcome.cwd = cwd;
		return finish(outcome, false, subjects);
	}
	const differs = changed(before.subject, after.subject);
	if (differs.length) {
		const outcome = errorOutcome(
			spec,
			`subject changed during the check (${differs.join(", ")})`,
		);
		if (command.kind === "exit") outcome.exitCode = command.exitCode;
		outcome.cwd = cwd;
		return finish(outcome, false, subjects);
	}
	const outcome = verdictFromCommand(command, spec, result.evidence?.accept);
	outcome.cwd = cwd;
	return finish(
		outcome,
		outcome.verdict === "accepted" || outcome.verdict === "rejected",
		subjects,
	);
}
