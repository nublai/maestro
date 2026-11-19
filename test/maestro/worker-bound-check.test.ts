/**
 * P3-10 V1 bound check, unit cases over a fake port (the worker provider's
 * stop, run binding and `artifacts.inspect`): a verdict is bound only to the
 * subject owner Git read before and after the check, every failure to bind
 * fails closed, and a cancelled check is its own outcome. The real-B2 cases
 * (an actual child commit) are in test/worker/b2-bound-check.test.ts.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import { runAcceptCommand } from "../../maestro/adapters/pi/accept-runner.ts";
import { committedVerdict } from "../../maestro/adapters/worker/run-checks.ts";
import {
	type AcceptCommandResult,
	acceptCheckHash,
	normalizeAcceptSpec,
} from "../../maestro/core/accept.ts";
import type {
	ExecHandle,
	ExecStopReport,
} from "../../maestro/core/exec-provider.ts";
import { isRecord } from "../../maestro/core/config/type-guards.ts";
import type {
	OutcomeJson,
	OutcomeJsonObject,
} from "../../maestro/core/outcome-store.ts";
import type { AgentHandle, RunResult } from "../../maestro/core/types.ts";
import {
	createRunSession,
	type FinalizeControl,
} from "../../maestro/runtime/run-session.ts";
import type { Role, Task } from "../../maestro/core/types.ts";
import {
	CHECK_ENV_ALLOWLIST,
	runWorkerBoundCheck,
	TERMINATION_STOPS,
	type WorkerBoundCheck,
	type WorkerCheckPort,
} from "../../maestro/adapters/worker/bound-check.ts";
import type { AcceptCommandOptions } from "../../maestro/adapters/pi/accept-runner.ts";
import {
	type ArtifactFacts,
	type WorkerArtifactRead,
	WorkerCommandUncertain,
	type WorkerRunBinding,
} from "../../maestro/adapters/worker/worker-exec-provider.ts";
import { MATERIALIZE_LIMITS } from "../../maestro/adapters/worker/materialize.ts";
import { makeRepo } from "../helpers/git-objects.ts";

const BASE = "b".repeat(40);
/** Where checks make their scratch HOME/TMPDIR; removed after the file. */
const SCRATCH = mkdtempSync(join(tmpdir(), "bound-check-unit-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
/** A real repository: the subject's commit and tree are materialized from it. */
const REPO = makeRepo(join(SCRATCH, "repo"));
const COMMIT = REPO.commit({ "feature.txt": "feature\n" });
const TREE = REPO.treeOf(COMMIT);
const REPOSITORY = () => REPO.gitDir;
const OTHER = "e".repeat(40);
const BRANCH = "refs/heads/maestro-s0/s0";
const ROOT = "/parent/.piw-slots/s0";
const handle: ExecHandle = {
	provider: "pi-worker",
	ref: "launch",
	capabilities: {
		resume: false,
		fork: false,
		persistent: false,
		sharedCheckout: false,
		worktree: true,
		callerSurface: false,
		executionExit: false,
		parentAdmission: "receipt",
	},
};
const spec = normalizeAcceptSpec({ run: "npm test", timeoutSec: 30 });
/** The check's environment source in every case: synthetic, never process.env. */
const SOURCE = Object.freeze({
	PATH: "/usr/bin:/bin",
	LANG: "C.UTF-8",
	PARENT_ONLY: "parent value",
	DECLARED: "declared value",
});
function scratchRoot(): string {
	return SCRATCH;
}

/** B2's own `outcome_unknown` receipt for a stop (the zombie-leader case). */
function unknownStop(): ExecStopReport {
	return {
		request: "unknown",
		termination: "unconfirmed",
		error: new WorkerCommandUncertain(
			"stop not confirmed (outcome_unknown)",
			"stop-1",
			"outcome_unknown",
		),
	};
}

function facts(
	change: (facts: ArtifactFacts) => void = () => {},
): ArtifactFacts {
	const value: ArtifactFacts = {
		worker_id: "w1",
		worker_epoch: "epoch-1",
		commit: { requested: BRANCH, commit_id: COMMIT, tree_id: TREE },
		head: { ref: BRANCH, commit_id: COMMIT, matches_commit: true },
		base: {
			requested: BASE,
			base_id: BASE,
			merge_base_id: BASE,
			is_ancestor: true,
			changed: [{ status: "A", path: "feature.txt" }],
			changed_truncated: false,
			diff_digest: {
				advisory: true,
				git_version: "git version 2.x",
				algorithm: "sha256",
				definition: "d",
				value: "f".repeat(64),
			},
		},
		worktree: { state: "clean", entries: [], truncated: false },
		pin: { kind: "linked", sha256: "a".repeat(64), head_ref: BRANCH },
		provenance: {
			evidence: "owner_git_launch_pin",
			git_version: "git version 2.x",
			replace_objects: "disabled",
			inspected_at: new Date(0).toISOString(),
		},
	};
	change(value);
	return value;
}

interface FakeOptions {
	stop?: ExecStopReport | Error;
	reads?: WorkerArtifactRead[];
	claim?: WorkerRunBinding["claim"] | null;
	binding?: false;
}

/** A port whose reads come from `reads`, in order; records every call. */
function port(options: FakeOptions = {}) {
	const calls: string[] = [];
	const requests: { epoch: string; commit: string; base?: string }[] = [];
	let terminated: string | undefined;
	const clean: WorkerArtifactRead[] = [
		{ kind: "facts", facts: facts() },
		{ kind: "facts", facts: facts() },
	];
	const reads = [...(options.reads ?? clean)];
	const fake: WorkerCheckPort = {
		runBinding() {
			if (options.binding === false) return undefined;
			const binding: WorkerRunBinding = {
				workerId: "w1",
				slot: { name: "s0", path: ROOT, branch: BRANCH, baseSha: BASE },
				help: [],
			};
			const claim =
				options.claim === undefined
					? {
							reportId: "r1",
							decoded: { type: "done" as const, commit: COMMIT },
						}
					: options.claim;
			if (claim) binding.claim = claim;
			if (terminated !== undefined) binding.terminatedEpoch = terminated;
			return binding;
		},
		async stop() {
			calls.push("stop");
			const stop = options.stop ?? {
				request: "sent",
				termination: "confirmed",
			};
			if (stop instanceof Error) throw stop;
			if (stop.termination === "confirmed") terminated = "epoch-1";
			return stop;
		},
		async inspectArtifact(_handle, request) {
			calls.push("inspect");
			requests.push(request);
			const read = reads.shift();
			assert.ok(read, "an inspection the test did not expect");
			return read;
		},
	};
	return { port: fake, calls, requests };
}

/** A JSON object field, asserted to be one. */
function object(value: OutcomeJson | undefined): OutcomeJsonObject {
	assert.ok(isRecord(value), "a JSON object");
	return value;
}

function completed(): RunResult {
	const agent: AgentHandle = {
		id: "run",
		name: "run",
		role: "worker",
		harness: "pi",
		cwd: ROOT,
		startedAt: 0,
		sessionId: "s",
	};
	return {
		handle: agent,
		outcome: "completed",
		exitCode: 0,
		durationMs: 1,
		evidence: { reason: "done", exitCode: 0 },
	};
}

function control(
	calls: string[],
	options: {
		interruption?: "cancelled" | "suppressed";
		recordFails?: boolean;
		/** The window's signal aborts, as the kernel's does once a cancel's termination is confirmed. */
		aborted?: boolean;
	} = {},
) {
	const subjects: OutcomeJsonObject[] = [];
	const window = new AbortController();
	const value: FinalizeControl = {
		async cancellable(work) {
			if (options.aborted) window.abort();
			return work(window.signal);
		},
		interruption: () => options.interruption,
		async recordCheck(subject) {
			calls.push("record");
			if (options.recordFails) throw new Error("disk full");
			subjects.push(subject);
		},
	};
	/** Aborts the window's signal, as a cancel confirmed during the command does. */
	const abort = () => window.abort();
	return { control: value, subjects, abort };
}

function runner(
	calls: string[],
	result: AcceptCommandResult = { kind: "exit", exitCode: 0, output: "ok" },
	seen: AcceptCommandOptions[] = [],
) {
	return async (options: AcceptCommandOptions) => {
		calls.push("run");
		seen.push(options);
		return result;
	};
}

async function check(
	options: FakeOptions & {
		result?: RunResult;
		command?: AcceptCommandResult;
		interruption?: "cancelled" | "suppressed";
		recordFails?: boolean;
	} = {},
) {
	const fake = port(options);
	const made = control(fake.calls, options);
	const seen: AcceptCommandOptions[] = [];
	const command = runner(fake.calls, options.command, seen);
	const outcome = await runWorkerBoundCheck(fake.port, {
		repository: REPOSITORY,
		handle,
		spec,
		result: options.result ?? completed(),
		control: made.control,
		// An aborted command: the window's cancel came while it ran.
		runner: async (given) => {
			if (options.command?.kind === "aborted") made.abort();
			return command(given);
		},
		environment: { source: SOURCE, scratchRoot: scratchRoot() },
	});
	return { ...fake, ...made, outcome, seen };
}

describe("V1 bound check: a verdict bound to what owner Git read", () => {
	it("a clean, matching child commit is checked: stop, inspect, record, run, inspect; accepted and bound", async () => {
		const { outcome, calls, requests, subjects } = await check();
		assert.deepEqual(calls, ["stop", "inspect", "record", "run", "inspect"]);
		assert.equal(outcome.accept.verdict, "accepted");
		assert.equal(outcome.bound, true);
		// The subject is read at the confirmed epoch, for the issued branch and base.
		assert.deepEqual(requests, [
			{ epoch: "epoch-1", commit: BRANCH, base: BASE },
			{ epoch: "epoch-1", commit: BRANCH, base: BASE },
		]);
		const before = object(outcome.subject?.before);
		assert.deepEqual(outcome.subject?.after, before);
		assert.equal(before.commit, COMMIT);
		assert.equal(before.tree, TREE);
		assert.equal(before.base, BASE);
		assert.equal(before.branch, BRANCH);
		assert.equal(before.root, ROOT);
		assert.equal(before.pin, "a".repeat(64));
		// The recorded subject is the one the verdict binds, with the command hash.
		assert.equal(subjects[0]?.commit, COMMIT);
		assert.equal(subjects[0]?.checkHash, acceptCheckHash(spec.run));
		const verdict = outcome.verdict;
		assert.equal(verdict.checkHash, acceptCheckHash(spec.run));
		assert.equal(verdict.exitCode, 0);
		assert.equal(verdict.result, "exit");
		assert.equal(verdict.claimedCommit, COMMIT);
		assert.equal(verdict.reportId, "r1");
		assert.deepEqual(verdict.termination, {
			request: "sent",
			termination: "confirmed",
			stops: 1,
			epoch: "epoch-1",
		});
		assert.equal(
			object(verdict.environment).runner,
			"maestro-parent-accept-runner",
		);
		assert.doesNotMatch(
			JSON.stringify(verdict),
			/npm test/,
			"never the command",
		);
	});

	it("a failing command is a bound rejection", async () => {
		const { outcome } = await check({
			command: { kind: "exit", exitCode: 1, output: "1 failing" },
		});
		assert.equal(outcome.accept.verdict, "rejected");
		assert.equal(outcome.bound, true);
		assert.equal(outcome.verdict.exitCode, 1);
	});

	it("a claim without a commit gives no verdict: the claimed commit is mandatory; nothing is stopped, read or run", async () => {
		const { outcome, calls } = await check({
			claim: { reportId: "r1", decoded: { type: "done" } },
		});
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(
			outcome.accept.reason,
			"the child's result report claims no commit",
		);
		assert.equal(outcome.bound, false);
		assert.equal(outcome.verdict.claimedCommit, null);
		assert.equal(outcome.verdict.check, "not-run");
	});

	it("without a durable subject record (no outcome store) nothing is checked", async () => {
		const fake = port();
		const made = control(fake.calls);
		delete made.control.recordCheck;
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.deepEqual(fake.calls, []);
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(outcome.bound, false);
	});
});

describe("V1 bound check: failed and missing reports", () => {
	it("a failed report is never checked: skipped, nothing stopped, inspected or run", async () => {
		const result = completed();
		result.outcome = "failed";
		result.exitCode = 1;
		result.evidence = {
			reason: "error",
			exitCode: 1,
			errorMessage: "child failed",
		};
		const { outcome, calls } = await check({ result });
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.verdict, "skipped");
		assert.equal(outcome.accept.reason, "provider error");
		assert.equal(outcome.bound, false);
	});

	it("a run with no completion evidence is skipped", async () => {
		const result = completed();
		result.outcome = "failed";
		delete result.evidence;
		const { outcome, calls } = await check({ result });
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.reason, "run failed");
	});

	it("completion without a result report claim gives no verdict", async () => {
		const { outcome, calls } = await check({ claim: null });
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(outcome.accept.reason, "no result report to check");
		assert.equal(outcome.bound, false);
	});

	it("an unreadable run binding gives no verdict", async () => {
		const { outcome, calls } = await check({ binding: false });
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.verdict, "error");
	});
});

describe("V1 bound check: termination before the authoritative read", () => {
	it("a stop that stays unobserved is repeated at most three times in all, then gives no verdict and reads nothing; the report is kept", async () => {
		const { outcome, calls } = await check({ stop: unknownStop() });
		assert.deepEqual(calls, ["stop", "stop", "stop"]);
		assert.equal(TERMINATION_STOPS, 3);
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(outcome.accept.reason, "child termination not confirmed");
		assert.equal(outcome.verdict.reportId, "r1");
		assert.deepEqual(outcome.verdict.termination, {
			request: "unknown",
			termination: "unconfirmed",
			stops: 3,
			error: "stop not confirmed (outcome_unknown)",
		});
	});

	it("an unobserved stop followed by one that confirms is checked", async () => {
		const reports: ExecStopReport[] = [
			unknownStop(),
			{ request: "not-sent", termination: "confirmed" },
		];
		const fake = port();
		const stop = fake.port.stop.bind(fake.port);
		fake.port.stop = async (h) => {
			const next = reports.shift();
			if (next?.termination === "confirmed") return stop(h);
			fake.calls.push("stop");
			assert.ok(next);
			return next;
		};
		const made = control(fake.calls);
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.equal(outcome.accept.verdict, "accepted");
		assert.equal(object(outcome.verdict.termination).stops, 2);
	});

	const unrepeated: [string, ExecStopReport][] = [
		[
			"a sent stop whose receipt was observed but not confirmed",
			{
				request: "sent",
				termination: "unconfirmed",
				error: new WorkerCommandUncertain("stop not confirmed (rejected)", "s"),
			},
		],
		[
			"a stop left unknown for another reason (receipt missing)",
			{
				request: "unknown",
				termination: "unconfirmed",
				error: new WorkerCommandUncertain(
					"stop not confirmed (receipt_missing)",
					"s",
					"receipt_missing",
				),
			},
		],
		[
			"a stop whose error only says outcome_unknown in its text",
			{
				request: "unknown",
				termination: "unconfirmed",
				error: new Error("stop not confirmed (outcome_unknown)"),
			},
		],
	];
	for (const [what, stop] of unrepeated)
		it(`${what} is never repeated: only B2's outcome_unknown receipt is`, async () => {
			const { outcome, calls } = await check({ stop });
			assert.deepEqual(calls, ["stop"]);
			assert.equal(outcome.accept.reason, "child termination not confirmed");
			assert.equal(outcome.bound, false);
		});

	it("a stop never sent is not repeated", async () => {
		const { outcome, calls } = await check({
			stop: {
				request: "not-sent",
				termination: "unconfirmed",
				error: new Error("the worker refused the stop"),
			},
		});
		assert.deepEqual(calls, ["stop"]);
		assert.equal(outcome.accept.reason, "child termination not confirmed");
	});

	it("a stop that rejects is unconfirmed, never a check", async () => {
		const { outcome, calls } = await check({ stop: new Error("socket gone") });
		assert.deepEqual(calls, ["stop"]);
		assert.equal(outcome.accept.reason, "child termination not confirmed");
	});
});

describe("V1 bound check: fail closed before the check runs", () => {
	const refusals: [string, WorkerArtifactRead, RegExp][] = [
		[
			"a pin mismatch",
			{ kind: "refused", code: "artifact_pin_mismatch" },
			/refused \(artifact_pin_mismatch\)/,
		],
		[
			"a missing object",
			{ kind: "refused", code: "artifact_object_missing" },
			/refused \(artifact_object_missing\)/,
		],
		[
			"no saved launch pin",
			{
				kind: "refused",
				code: "artifact_inspection_unavailable",
				detail: "no_saved_launch_pin",
			},
			/artifact_inspection_unavailable: no_saved_launch_pin/,
		],
		[
			"a lost inspect reply",
			{ kind: "unavailable", error: "socket closed before the reply" },
			/before the check unavailable/,
		],
		[
			"a commit on another branch",
			{
				kind: "facts",
				facts: facts((f) => {
					f.head.ref = "refs/heads/maestro-s1/s1";
				}),
			},
			/not on its issued branch/,
		],
		[
			"a pin naming another branch",
			{
				kind: "facts",
				facts: facts((f) => {
					f.pin.head_ref = "refs/heads/maestro-s1/s1";
				}),
			},
			/not on its issued branch/,
		],
		[
			"a HEAD off its branch's commit",
			{
				kind: "facts",
				facts: facts((f) => {
					f.head.matches_commit = false;
				}),
			},
			/HEAD is not its branch's commit/,
		],
		[
			"a base that is not an ancestor",
			{
				kind: "facts",
				facts: facts((f) => {
					f.base!.is_ancestor = false;
				}),
			},
			/issued base is not an ancestor/,
		],
		[
			"another base",
			{
				kind: "facts",
				facts: facts((f) => {
					f.base!.base_id = OTHER;
				}),
			},
			/issued base is not an ancestor/,
		],
		[
			"no base facts",
			{
				kind: "facts",
				facts: facts((f) => {
					delete f.base;
				}),
			},
			/issued base is not an ancestor/,
		],
		[
			"another generation",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worker_epoch = "epoch-2";
				}),
			},
			/another worker or generation/,
		],
		[
			"another worker",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worker_id = "w2";
				}),
			},
			/another worker or generation/,
		],
		[
			"a commit other than the claimed one",
			{
				kind: "facts",
				facts: facts((f) => {
					f.commit.commit_id = OTHER;
					f.head.commit_id = OTHER;
				}),
			},
			/claimed commit is not its branch's commit/,
		],
		[
			"a dirty checkout",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: "??", path: "stray.txt" }],
						truncated: false,
					};
				}),
			},
			/dirty \(1 unexpected entry\)/,
		],
		[
			"a tracked change",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: " M", path: "note" }],
						truncated: false,
					};
				}),
			},
			/dirty/,
		],
		[
			"a conflicted checkout",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "conflicted",
						entries: [{ code: "UU", path: "note" }],
						truncated: false,
					};
				}),
			},
			/conflicted/,
		],
		[
			"a truncated status",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: "??", path: ".piw-worker/" }],
						truncated: true,
					};
				}),
			},
			/truncated/,
		],
		[
			"a runtime directory name in a tracked change",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: " M", path: ".piw-worker/" }],
						truncated: false,
					};
				}),
			},
			/dirty/,
		],
	];
	for (const [what, read, reason] of refusals)
		it(`${what}: no verdict, the command never runs`, async () => {
			const { outcome, calls } = await check({ reads: [read] });
			assert.deepEqual(calls, ["stop", "inspect"]);
			assert.equal(outcome.accept.verdict, "error");
			assert.match(outcome.accept.reason ?? "", reason);
			assert.equal(outcome.bound, false);
			assert.equal(outcome.verdict.check, "not-run");
		});

	it("the worker's staged runtime directories are accounted for by name, never dirt", async () => {
		const runtime = facts((f) => {
			f.worktree = {
				state: "dirty",
				entries: [
					{ code: "??", path: ".piw-worker/" },
					{ code: "??", path: ".piw-agent/" },
				],
				truncated: false,
			};
		});
		const { outcome } = await check({
			reads: [
				{ kind: "facts", facts: runtime },
				{ kind: "facts", facts: runtime },
			],
		});
		assert.equal(outcome.accept.verdict, "accepted");
		assert.deepEqual(object(outcome.subject?.before).runtime, [
			".piw-agent/",
			".piw-worker/",
		]);
	});

	it("a subject that cannot be recorded never runs: the check rejects", async () => {
		const fake = port();
		const made = control(fake.calls, { recordFails: true });
		await assert.rejects(
			runWorkerBoundCheck(fake.port, {
				repository: REPOSITORY,
				handle,
				spec,
				result: completed(),
				control: made.control,
				runner: runner(fake.calls),
				environment: { source: SOURCE, scratchRoot: scratchRoot() },
			}),
			/disk full/,
		);
		assert.deepEqual(fake.calls, ["stop", "inspect", "record"]);
	});
});

describe("V1 bound check: the subject after the check", () => {
	const after: [string, WorkerArtifactRead, RegExp][] = [
		[
			"an untracked file the check left",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: "??", path: "out.log" }],
						truncated: false,
					};
				}),
			},
			/subject changed: the checkout is dirty/,
		],
		[
			"a new commit on the branch",
			{
				kind: "facts",
				facts: facts((f) => {
					f.commit.commit_id = OTHER;
					f.head.commit_id = OTHER;
					f.commit.tree_id = OTHER;
				}),
			},
			/subject changed: the child's claimed commit/,
		],
		[
			"another tree for the same commit name",
			{
				kind: "facts",
				facts: facts((f) => {
					f.commit.tree_id = OTHER;
				}),
			},
			/subject changed during the check \(tree\)/,
		],
		[
			"another pin",
			{
				kind: "facts",
				facts: facts((f) => {
					f.pin.sha256 = "9".repeat(64);
				}),
			},
			/subject changed during the check \(pin\)/,
		],
		[
			"a runtime directory that appeared",
			{
				kind: "facts",
				facts: facts((f) => {
					f.worktree = {
						state: "dirty",
						entries: [{ code: "??", path: ".piw-worker/" }],
						truncated: false,
					};
				}),
			},
			/subject changed during the check \(worktree, runtime\)/,
		],
		[
			"a pin mismatch",
			{ kind: "refused", code: "artifact_pin_mismatch" },
			/subject changed: artifact inspection after the check refused/,
		],
		[
			"a lost inspect reply",
			{ kind: "unavailable", error: "timeout" },
			/after the check unavailable/,
		],
	];
	for (const [what, read, reason] of after)
		it(`${what}: no accepted verdict, whatever the command's exit`, async () => {
			const { outcome, calls } = await check({
				reads: [{ kind: "facts", facts: facts() }, read],
			});
			assert.deepEqual(calls, ["stop", "inspect", "record", "run", "inspect"]);
			assert.equal(outcome.accept.verdict, "error");
			assert.match(outcome.accept.reason ?? "", reason);
			assert.equal(outcome.accept.exitCode, 0, "the exit is kept as evidence");
			assert.equal(outcome.bound, false);
			assert.ok(outcome.subject?.before, "both subjects are kept");
		});
});

describe("V1 bound check: a cancelled check", () => {
	it("is its own outcome: skipped (cancelled), never an error or a verdict, and nothing is read after it", async () => {
		const { outcome, calls } = await check({
			interruption: "cancelled",
			command: { kind: "aborted", output: "" },
		});
		assert.deepEqual(calls, ["stop", "inspect", "record", "run"]);
		assert.equal(outcome.accept.verdict, "skipped");
		assert.equal(outcome.accept.reason, "cancelled");
		assert.equal(outcome.verdict.check, "cancelled");
		assert.equal(outcome.bound, false);
	});

	it("a cancel that wins after the command finished still skips: the kernel decides", async () => {
		const { outcome } = await check({ interruption: "cancelled" });
		assert.equal(outcome.accept.verdict, "skipped");
		assert.equal(outcome.accept.reason, "cancelled");
	});

	it("a parent shutdown during the check is skipped (parent shut down)", async () => {
		const { outcome } = await check({ interruption: "suppressed" });
		assert.equal(outcome.accept.reason, "parent shut down");
	});

	it("a run cancelled before its check never checks", async () => {
		const result = completed();
		result.outcome = "killed";
		result.cancellation = { requestedAt: 1, termination: "confirmed" };
		const { outcome, calls } = await check({ result });
		assert.deepEqual(calls, []);
		assert.equal(outcome.accept.reason, "cancelled");
	});
});

describe("V1 bound check: the command runs in a verified copy of the subject, never the child's checkout", () => {
	it("runs in a fresh copy of the inspected tree in the check's scratch; the copy's recomputed tree is recorded with the subject; the copy is deleted after", async () => {
		const seenFiles: string[][] = [];
		const fake = port();
		const made = control(fake.calls);
		const seen: AcceptCommandOptions[] = [];
		const command = runner(fake.calls, undefined, seen);
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: async (given) => {
				seenFiles.push(readdirSync(given.cwd).sort());
				return command(given);
			},
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.equal(outcome.accept.verdict, "accepted");
		assert.equal(outcome.bound, true);
		const cwd = String(seen[0]?.cwd);
		assert.notEqual(cwd, ROOT, "never the child's checkout");
		assert.equal(cwd.startsWith(join(SCRATCH, "maestro-check-")), true);
		assert.deepEqual(seenFiles, [["feature.txt"]], "the commit's tree only");
		assert.equal(existsSync(cwd), false, "the copy is deleted after");
		const materialized = object(outcome.subject?.materialized);
		assert.equal(materialized.tree, TREE);
		assert.equal(materialized.commit, COMMIT);
		assert.equal(materialized.algorithm, "sha1");
		assert.equal(materialized.files, 1);
		assert.equal(object(materialized.limits).max_entries, 100_000);
		assert.equal(
			object(outcome.verdict.environment).cwd,
			"materialized-subject",
		);
	});

	it("an object corrupted under its old ID: no verdict, the command never runs", async () => {
		// The same commit in another object store, its blob forged in place.
		const bad = makeRepo(join(SCRATCH, "corrupt"));
		assert.equal(bad.commit({ "feature.txt": "feature\n" }), COMMIT);
		bad.corrupt(
			bad.git("rev-parse", `${COMMIT}:feature.txt`),
			"blob",
			"forged\n",
		);
		const fake = port();
		const made = control(fake.calls);
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: () => bad.gitDir,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.deepEqual(fake.calls, ["stop", "inspect", "record"]);
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(outcome.bound, false);
		assert.match(
			String(outcome.accept.reason),
			/^the subject could not be materialized \(object_corrupt: [0-9a-f]{40}\)$/,
		);
		assert.deepEqual(outcome.verdict.materialized, {
			refused: "object_corrupt",
		});
		assert.equal(outcome.verdict.check, "not-run");
		assert.deepEqual(
			readdirSync(SCRATCH).filter((name) => name.startsWith("maestro-check-")),
			[],
			"the scratch is removed",
		);
	});

	it("no object repository: no verdict, the command never runs", async () => {
		const fake = port();
		const made = control(fake.calls);
		const outcome = await runWorkerBoundCheck(fake.port, {
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.deepEqual(fake.calls, ["stop", "inspect", "record"]);
		assert.equal(outcome.accept.verdict, "error");
		assert.match(String(outcome.accept.reason), /repository_unavailable/);
	});

	it("a copy whose tree is not the inspected tree binds nothing", async () => {
		const fake = port();
		const made = control(fake.calls);
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			materialize: async (request) => {
				mkdirSync(request.dest);
				return {
					commit: request.commit,
					tree: OTHER,
					algorithm: "sha1",
					files: 0,
					directories: 0,
					bytes: 0,
					limits: { ...MATERIALIZE_LIMITS },
					elapsedMs: 0,
				};
			},
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.equal(outcome.accept.verdict, "error");
		assert.equal(outcome.bound, false);
		assert.equal(
			outcome.accept.reason,
			"the materialized tree is not the inspected tree",
		);
	});

	it("the copy's caps are the check's: an oversize subject is refused", async () => {
		const fake = port();
		const made = control(fake.calls);
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			materializeLimits: { maxBytes: 16 },
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.deepEqual(fake.calls, ["stop", "inspect", "record"]);
		assert.deepEqual(outcome.verdict.materialized, { refused: "too_large" });
	});

	it("a cancel during the copy wins: skipped (cancelled), nothing runs", async () => {
		const fake = port();
		const made = control(fake.calls, {
			aborted: true,
			interruption: "cancelled",
		});
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls),
			environment: { source: SOURCE, scratchRoot: scratchRoot() },
		});
		assert.deepEqual(fake.calls, ["stop", "inspect", "record"]);
		assert.equal(outcome.accept.verdict, "skipped");
		assert.equal(outcome.accept.reason, "cancelled");
	});
});

describe("V1 bound check: the command's synthetic environment", () => {
	it("carries only allowlisted and declared variables, HOME and TMPDIR in the check's scratch; nothing else of the parent's", async () => {
		const fake = port();
		const made = control(fake.calls);
		const seen: AcceptCommandOptions[] = [];
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec,
			result: completed(),
			control: made.control,
			runner: runner(fake.calls, undefined, seen),
			environment: {
				source: SOURCE,
				declared: ["DECLARED"],
				scratchRoot: scratchRoot(),
			},
		});
		assert.equal(outcome.accept.verdict, "accepted");
		const env = seen[0]?.env;
		assert.ok(env, "the runner is given an explicit environment");
		assert.deepEqual(Object.keys(env).sort(), [
			"DECLARED",
			"HOME",
			"LANG",
			"PATH",
			"TMPDIR",
		]);
		assert.equal("PARENT_ONLY" in env, false, "a parent variable never passes");
		assert.equal(env.PATH === SOURCE.PATH, true, "PATH is allowlisted");
		assert.equal(env.DECLARED === SOURCE.DECLARED, true, "declared passes");
		assert.equal(
			String(env.HOME).startsWith(join(SCRATCH, "maestro-check-")),
			true,
			"HOME is the check's scratch",
		);
		assert.equal(
			String(env.TMPDIR).startsWith(join(SCRATCH, "maestro-check-")),
			true,
			"TMPDIR is the check's scratch",
		);
		assert.equal(existsSync(String(env.HOME)), false, "scratch removed after");
		// Names only in the evidence, never a value.
		const recorded = object(object(outcome.verdict.environment).env);
		assert.equal(recorded.kind, "synthetic");
		assert.deepEqual(recorded.names, [
			...CHECK_ENV_ALLOWLIST,
			"DECLARED",
			"HOME",
			"TMPDIR",
		]);
		assert.equal(
			JSON.stringify(outcome.verdict).includes("declared value"),
			false,
			"no variable value is recorded",
		);
	});

	it("a parent variable does not reach the real command (Maestro's accept runner, sh -c)", async () => {
		const fake = port();
		const made = control(fake.calls);
		const cwd = mkdtempSync(join(SCRATCH, "slot-"));
		const binding = fake.port.runBinding.bind(fake.port);
		fake.port.runBinding = (h) => {
			const value = binding(h);
			if (value) value.slot.path = cwd;
			return value;
		};
		const outcome = await runWorkerBoundCheck(fake.port, {
			repository: REPOSITORY,
			handle,
			spec: normalizeAcceptSpec({
				run: 'test -z "${PARENT_ONLY+set}" && test -n "$DECLARED" && test -d "$HOME" && test -d "$TMPDIR" && test "$HOME" != "$PWD"',
				timeoutSec: 30,
			}),
			result: completed(),
			control: made.control,
			runner: runAcceptCommand,
			environment: {
				source: SOURCE,
				declared: ["DECLARED"],
				scratchRoot: scratchRoot(),
			},
		});
		assert.equal(
			outcome.accept.verdict,
			"accepted",
			"the command saw only its own environment",
		);
		assert.deepEqual(
			readdirSync(SCRATCH).filter((name) => name.startsWith("maestro-check-")),
			[],
			"the scratch is removed",
		);
	});

	for (const name of ["HOME", "TMPDIR", "NOT A NAME"])
		it(`a declared variable that may not pass (${name === "NOT A NAME" ? "not a name" : name}) refuses the check before it runs`, async () => {
			const fake = port();
			const made = control(fake.calls);
			const outcome = await runWorkerBoundCheck(fake.port, {
				repository: REPOSITORY,
				handle,
				spec,
				result: completed(),
				control: made.control,
				runner: runner(fake.calls),
				environment: {
					source: SOURCE,
					declared: [name],
					scratchRoot: scratchRoot(),
				},
			});
			assert.deepEqual(fake.calls, ["stop", "inspect"]);
			assert.equal(outcome.accept.verdict, "error");
			assert.equal(outcome.bound, false);
		});
});

describe("V1 bound check under the real run owner: a cancel during the second inspection", () => {
	const role: Role = {
		name: "worker",
		version: "1",
		description: "worker",
		systemPrompt: "worker",
		allowedTools: [],
	};

	it("wins: the cancel is accepted, the run is cancelled and the verdict is skipped (cancelled), never accepted and bound", async () => {
		const adapter = new FakeHarnessAdapter();
		const session = createRunSession({ adapter, roles: [role], cwd: ROOT });
		const task: Task = {
			id: "race",
			name: "race",
			prompt: "p",
			role: "worker",
			cwd: ROOT,
		};
		const fake = port();
		const inspect = fake.port.inspectArtifact.bind(fake.port);
		let cancelled: ReturnType<typeof session.cancel> | undefined;
		fake.port.inspectArtifact = async (h, request) => {
			const read = await inspect(h, request);
			// The second reading: the operator cancels while it is in flight.
			if (fake.calls.filter((c) => c === "inspect").length === 2)
				cancelled = session.cancel(task.id);
			return read;
		};
		let check: WorkerBoundCheck | undefined;
		const handleOf = await session.spawn(task, {
			role,
			persistent: false,
			candidates: [{ model: "fixture/model", thinking: "off" }],
			async spawnAttempt(options) {
				return {
					adapter,
					handle: await adapter.spawn(options),
					async finalize(result, _task, control) {
						check = await runWorkerBoundCheck(fake.port, {
							repository: REPOSITORY,
							handle,
							spec,
							result,
							// The kernel's own window; only the subject record is a stub.
							control: { ...control, recordCheck: async () => {} },
							runner: runner(fake.calls),
							environment: { source: SOURCE, scratchRoot: scratchRoot() },
						});
						return result;
					},
				};
			},
		});
		const result = session.supervise(handleOf, task);
		adapter.complete(handleOf.id, { reason: "done", exitCode: 0 });
		const settled = await result;
		assert.ok(cancelled, "the cancel was made during the second inspection");
		const report = await cancelled;
		assert.equal(
			report.status,
			"confirmed",
			"the cancel is accepted, not too late",
		);
		assert.equal(settled.outcome, "killed");
		assert.ok(settled.cancellation, "the delivered result is cancelled");
		assert.ok(check);
		assert.equal(check.bound, false);
		assert.equal(check.accept.verdict, "skipped");
		assert.equal(check.accept.reason, "cancelled");
		assert.equal(check.verdict.check, "cancelled");
		assert.equal(committedVerdict(check, settled).verdict, "skipped");
	});

	it("the committed verdict is re-checked against the delivered result: a cancelled run never carries a bound verdict", async () => {
		const { outcome } = await check();
		assert.equal(outcome.bound, true);
		const cancelledRun = completed();
		cancelledRun.outcome = "killed";
		cancelledRun.cancellation = { requestedAt: 1, termination: "confirmed" };
		const verdict = committedVerdict(outcome, cancelledRun);
		assert.equal(verdict.verdict, "skipped");
		assert.equal(verdict.bound, false);
		assert.equal(verdict.reason, "cancelled");
		assert.equal(verdict.exitCode, undefined);
		assert.equal(verdict.checkHash, outcome.verdict.checkHash, "evidence kept");
		// A natural run keeps the check's own verdict.
		assert.equal(committedVerdict(outcome, completed()).verdict, "accepted");
	});
});

describe("the cancel-intent gate: durable before any stop (run owner)", () => {
	const role: Role = {
		name: "worker",
		version: "1",
		description: "worker",
		systemPrompt: "worker",
		allowedTools: [],
	};

	for (const how of ["throws", "rejects"] as const)
		it(`a failed durable write (the hook ${how}) sends no stop and surfaces the failure; a cancel retried once the write succeeds stops the run`, async () => {
			const adapter = new FakeHarnessAdapter();
			const order: string[] = [];
			const kill = adapter.kill.bind(adapter);
			adapter.kill = async (h) => {
				order.push("kill");
				return kill(h);
			};
			let failing = true;
			const session = createRunSession({
				adapter,
				roles: [role],
				cwd: ROOT,
				hooks: {
					persistCancelIntent() {
						order.push("persist");
						if (!failing) return;
						const failure = new Error("manifest write failed");
						if (how === "throws") throw failure;
						return Promise.reject(failure);
					},
				},
			});
			const task: Task = {
				id: "gate",
				name: "gate",
				prompt: "p",
				role: "worker",
				cwd: ROOT,
			};
			const running = await session.spawn(task, {
				role,
				persistent: false,
				candidates: [{ model: "fixture/model", thinking: "off" }],
				async spawnAttempt(options) {
					return { adapter, handle: await adapter.spawn(options) };
				},
			});
			const settled = session.supervise(running, task);
			const first = await session.cancel(task.id);
			assert.equal(first.status, "unconfirmed");
			assert.match(
				first.error ?? "",
				/cancel intent could not be recorded durably, so no stop was sent: manifest write failed/,
			);
			assert.deepEqual(
				order,
				["persist"],
				"no stop without the durable intent",
			);
			assert.equal(await adapter.getState(running), "working", "still live");
			failing = false;
			const second = await session.cancel(task.id);
			assert.equal(second.status, "confirmed");
			assert.deepEqual(order, ["persist", "persist", "kill"]);
			const result = await settled;
			assert.equal(result.outcome, "killed");
			assert.equal(result.cancellation?.termination, "confirmed");
		});
});
