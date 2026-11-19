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
 *    ancestor, HEAD must be on the issued branch at that commit, the commit
 *    the child's result report claims (mandatory) must be that commit, and
 *    the checkout must be clean except
 *    for the worker's own staged runtime directories (listed, never ignored).
 *    The subject is the commit, its native tree, the base, the branch, the
 *    root and the pin's identity.
 * 3. The subject is durable (`recordCheck`) before the approved command runs
 *    with Maestro's parent-side accept runner in the slot, cancellable, in a
 *    synthetic environment built from an explicit allowlist (never the
 *    parent's environment passed through).
 * 4. The same inspection after the check must read the same subject and the
 *    same checkout status; anything else is a changed subject. It is inside
 *    the cancellable window: a cancel that arrives at any point before the
 *    verdict is decided wins, and the verdict is then `skipped (cancelled)`.
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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecHandle, ExecStopReport } from "../../core/exec-provider.ts";
import type {
	OutcomeJson,
	OutcomeJsonObject,
} from "../../core/outcome-store.ts";
import type { CompletionEvidence, RunResult } from "../../core/types.ts";
import type { FinalizeControl } from "../../runtime/run-session.ts";
import type { AcceptCheckOwner } from "../pi/accept-groups.ts";
import type { AcceptRunner } from "../pi/accept-runner.ts";
import {
	type ArtifactFacts,
	type WorkerArtifactRead,
	WorkerCommandUncertain,
	type WorkerRunBinding,
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

/**
 * The variables a check's environment may take from its source, by name
 * (root decision, P3-10): `PATH` and the locale. `HOME` and `TMPDIR` are
 * always the check's own scratch directories; anything else reaches the
 * command only when the approved check declares it
 * ({@link CheckEnvironmentOptions.declared}).
 */
export const CHECK_ENV_ALLOWLIST: readonly string[] = Object.freeze([
	"PATH",
	"LANG",
	"LC_ALL",
]);

/** How a bound check builds its command's synthetic environment. */
export interface CheckEnvironmentOptions {
	/** Where allowlisted values are read from. Default `process.env`. */
	source?: Readonly<Record<string, string | undefined>>;
	/** Further variable names the approved accept command declares. */
	declared?: readonly string[];
	/** Where the check's scratch directory (its HOME and TMPDIR) is made. Default `os.tmpdir()`. */
	scratchRoot?: string;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The names a check's environment carries: the allowlist and the declared
 * names, then `HOME` and `TMPDIR`. A declared name that is not a plain
 * variable name, or that names `HOME` or `TMPDIR`, is refused.
 */
export function checkEnvironmentNames(
	declared: readonly string[] = [],
): string[] {
	for (const name of declared)
		if (!VARIABLE_NAME.test(name) || name === "HOME" || name === "TMPDIR")
			throw new Error(
				"An accept check declares an environment variable it may not pass",
			);
	return [...new Set([...CHECK_ENV_ALLOWLIST, ...declared])];
}

/**
 * The check command's environment: only allowlisted and declared variables
 * present in `source`, with `HOME` and `TMPDIR` inside `scratch`. Nothing
 * else of the parent's environment reaches the command.
 */
export function checkEnvironment(
	source: Readonly<Record<string, string | undefined>>,
	declared: readonly string[],
	scratch: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of checkEnvironmentNames(declared)) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	env.HOME = join(scratch, "home");
	env.TMPDIR = join(scratch, "tmp");
	return env;
}

export interface WorkerBoundCheckInput {
	handle: ExecHandle;
	spec: AcceptSpec;
	result: RunResult;
	control: FinalizeControl;
	runner: AcceptRunner;
	/** Stops this check at shutdown (`accept-groups.ts`). */
	owner?: AcceptCheckOwner;
	/** The command's synthetic environment. */
	environment?: CheckEnvironmentOptions;
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
function environment(cwd: string, names: readonly string[]): OutcomeJsonObject {
	return {
		runner: "maestro-parent-accept-runner",
		shell: "sh -c",
		cwd,
		// Variable names only, never values.
		env: {
			kind: "synthetic",
			names: [...names, "HOME", "TMPDIR"],
			home: "check scratch",
			tmpdir: "check scratch",
		},
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
	claimed: string,
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
	if (claimed !== facts.commit.commit_id)
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

/**
 * Whether a stop may be repeated (root decision, P3-10): only an unconfirmed
 * report naming B2's own `outcome_unknown` receipt for that stop. A refusal,
 * a stop never sent, any other uncertainty or error is never repeated.
 */
export function unobservedStop(stop: ExecStopReport): boolean {
	return (
		stop.termination === "unconfirmed" &&
		stop.error instanceof WorkerCommandUncertain &&
		stop.error.unknownReason === "outcome_unknown"
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no static type; only an Error's own message is read. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "unknown failure";
}

/**
 * Runs the V1 bound check of one worker run. Rejects only when the check's
 * subject could not be recorded (`recordCheck`, mandatory): the command then
 * never ran.
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
	// Root decision: the claimed commit is mandatory for a bound verdict.
	if (claimed === undefined) {
		record.check = "not-run";
		return finish(
			errorOutcome(spec, "the child's result report claims no commit"),
			false,
		);
	}
	const recordCheck = input.control.recordCheck;
	if (!recordCheck) {
		record.check = "not-run";
		return finish(
			errorOutcome(
				spec,
				"the check's subject cannot be recorded (no outcome store)",
			),
			false,
		);
	}
	// 1. Termination of the generation that ran, before any authoritative read.
	// Only a stop B2 reports as `outcome_unknown` is repeated, as an owner may,
	// at most TERMINATION_STOPS in all; a refusal, a stop never sent, one that
	// rejects or any other uncertainty is not. A repeat finding the row
	// stopped sends nothing. When the budget runs out the worker stays owned.
	let stop: ExecStopReport;
	let stops = 0;
	for (;;) {
		stops++;
		try {
			stop = await port.stop(handle);
		} catch (error) {
			stop = { request: "not-sent", termination: "unconfirmed", error };
		}
		if (!unobservedStop(stop) || stops >= TERMINATION_STOPS) break;
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
	const options = input.environment ?? {};
	const declared = options.declared ?? [];
	let names: string[];
	try {
		names = checkEnvironmentNames(declared);
	} catch (error) {
		record.check = "not-run";
		return finish(errorOutcome(spec, errorText(error)), false, {
			before: before.subject,
		});
	}
	record.environment = environment(cwd, names);
	// 3. Durable before it runs; a rejection means the check never ran.
	await recordCheck({
		checkHash: acceptCheckHash(spec.run),
		cwd,
		...before.subject,
	});
	// The check's own HOME and TMPDIR, outside the checkout, removed after it.
	const scratch = mkdtempSync(
		join(options.scratchRoot ?? tmpdir(), "maestro-check-"),
	);
	let command: Awaited<ReturnType<AcceptRunner>>;
	let afterRead: WorkerArtifactRead | undefined;
	try {
		mkdirSync(join(scratch, "home"));
		mkdirSync(join(scratch, "tmp"));
		const env = checkEnvironment(
			options.source ?? process.env,
			declared,
			scratch,
		);
		// The command and the reading after it share one cancellable window:
		// a cancel that arrives during either wins once termination is
		// confirmed (the kernel reports it), so a bound verdict is never
		// decided after a cancel was accepted.
		command = await input.control.cancellable(async (signal) => {
			const ran = await input.runner({
				run: spec.run,
				cwd,
				timeoutMs: spec.timeoutSec * 1000,
				signal,
				owner: input.owner,
				env,
			});
			if (!signal.aborted)
				afterRead = await port.inspectArtifact(handle, request);
			return ran;
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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
	const after: Judged = afterRead
		? judge(afterRead, binding, epoch, claimed, "after the check")
		: {
				kind: "refused",
				reason: "artifact inspection after the check not made",
			};
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
