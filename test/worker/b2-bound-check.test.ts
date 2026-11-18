/**
 * P3-10 against the real B2 fixture (see b2-conformance.test.ts): the V1
 * bound check of an actual child commit through `artifacts.inspect`, compared
 * with the owner's own Git, and the failure and cancellation hand-offs. The
 * run owner is the shared RunSession over the worker provider, composed with
 * `WorkerRunChecks`, the parent's OutcomeStore and its admission outbox.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { encodeResultClaim } from "../../maestro/adapters/worker/fd-report.ts";
import { WORKER_OUTCOME_ENVELOPE } from "../../maestro/adapters/worker/parent-admission.ts";
import { isRecord } from "../../maestro/core/config/type-guards.ts";
import type {
	OutcomeJson,
	OutcomeJsonObject,
	StoredOutcome,
} from "../../maestro/core/outcome-store.ts";
import type { AcceptRequest } from "../../maestro/core/accept.ts";
import {
	composeWorkerParent,
	workerTask,
} from "../helpers/worker-admission.ts";
import { B2Fixture, piWorkerCheckout } from "../helpers/worker-b2-fixture.ts";

type Parent = Awaited<ReturnType<typeof composeWorkerParent>>;

/** A JSON object field, asserted to be one. */
function object(value: OutcomeJson | undefined): OutcomeJsonObject {
	assert.ok(isRecord(value), "a JSON object");
	return value;
}

/** Owner Git with a synthetic environment, never the user's configuration. */
function ownerGit(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: cwd,
			LANG: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	}).trim();
}

async function until(check: () => Promise<boolean> | boolean, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Tasks a case launched: cleanup suppresses each, so no supervision outlives it. */
const launchedTasks: string[] = [];

/**
 * An owner's cancel, repeated as an owner may while B2 has not observed the
 * child's end (its stop `outcome_unknown` under load), at most three times.
 */
async function cancelConfirmed(parent: Parent, taskId: string) {
	let report = await parent.runs.cancel(taskId);
	for (let n = 1; n < 3 && report.status === "unconfirmed"; n++) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		report = await parent.runs.cancel(taskId);
	}
	return report;
}

async function withParent(
	run: (f: {
		fixture: B2Fixture;
		parent: Parent;
		scratch: string;
	}) => Promise<void>,
	options: { slots?: number; channel?: boolean } = {},
) {
	piWorkerCheckout();
	const fixture = await B2Fixture.start(options.slots ?? 4, {
		channel: options.channel,
	});
	const dir = mkdtempSync(join(tmpdir(), "maestro-bound-"));
	const scratch = mkdtempSync(join(tmpdir(), "maestro-bound-marks-"));
	let parent: Parent | undefined;
	try {
		parent = await composeWorkerParent(fixture.started, dir, { checks: {} });
		await parent.outbox.start();
		await run({ fixture, parent, scratch });
	} finally {
		for (const id of launchedTasks.splice(0)) parent?.runs.suppress(id);
		await parent?.dispose();
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** One child launched and supervised by the run owner. */
async function launched(parent: Parent, id: string, accept?: AcceptRequest) {
	const task = workerTask(id, parent.session.root, accept);
	launchedTasks.push(task.id);
	const handle = await parent.runs.spawn(task);
	const workerId = parent.workerOf(handle);
	const result = parent.runs.supervise(handle, task);
	// Observed even when a case ends before it settles.
	result.catch(() => {});
	return { task, handle, workerId, result };
}

function report(
	fixture: B2Fixture,
	workerId: string,
	claim: Parameters<typeof encodeResultClaim>[0],
) {
	return fixture.op<{ report_id: string }>("report", {
		workerId,
		kind: "result",
		message: encodeResultClaim(claim),
	});
}

/** The B2 identity of the child's result report: its `children.report` command ID. */
async function resultReport(fixture: B2Fixture, workerId: string) {
	const claim = (await fixture.row(workerId)).child_reports?.find(
		(c) => c.kind === "result",
	);
	assert.ok(claim, "a durable result report");
	return claim.command_id;
}

/** The committed outcome of `taskId` (retained, or final with its record). */
function outcomeOf(parent: Parent, taskId: string): StoredOutcome {
	const found = parent.store
		.recovery()
		.outcomes.find((stored) => stored.outcome.taskId === taskId);
	assert.ok(found, `an outcome for ${taskId}`);
	return found;
}

/** A marker file an accept command writes: it ran exactly when it exists. */
function marked(scratch: string, name: string) {
	const path = join(scratch, name);
	return { path, run: `: > '${path}'`, ran: () => existsSync(path) };
}

describe("V1 bound check over real B2: an actual child commit", () => {
	it("accepted and bound to the commit and tree owner Git reads; the store keeps the command hash, exit, environment, termination and both subjects", () =>
		withParent(async ({ fixture, parent }) => {
			const run = launched(parent, "v1", {
				run: "test -f feature.txt && grep -q feature feature.txt",
			});
			const { workerId, result } = await run;
			// This owner's own live run is never handed off as interrupted.
			assert.equal(parent.store.recovery().interrupted.length, 1);
			assert.deepEqual(
				await parent.checks?.handOffInterrupted(parent.store),
				[],
			);
			const sha = await fixture.op<string>("commit", {
				workerId,
				file: "feature.txt",
				text: "feature\n",
			});
			await report(fixture, workerId, {
				type: "done",
				summary: "feature committed",
				commit: sha,
			});
			assert.equal((await result).outcome, "completed");
			const stored = outcomeOf(parent, "v1");
			const verdict = object(stored.outcome.verdict);
			assert.equal(verdict.verdict, "accepted");
			assert.equal(verdict.bound, true);
			assert.equal(verdict.exitCode, 0);
			assert.equal(verdict.result, "exit");
			assert.match(String(verdict.checkHash), /^sha256:[0-9a-f]{64}$/);
			assert.equal(verdict.claimedCommit, sha);
			const row = await fixture.row(workerId);
			const termination = object(verdict.termination);
			assert.equal(termination.termination, "confirmed");
			assert.equal(termination.epoch, row.worker_epoch);
			// A stop B2 did not observe under load is repeated (at most three).
			assert.ok(
				termination.stops === 1
					? termination.request === "sent"
					: Number(termination.stops) <= 3,
			);
			assert.equal(row.status, "stopped", "terminated before the check");
			assert.equal(
				object(verdict.environment).runner,
				"maestro-parent-accept-runner",
			);
			// The owner's own Git agrees: commit, tree, base, ancestry, branch.
			const slot = row.cwd;
			const before = object(object(stored.outcome.subject).before);
			const after = object(object(stored.outcome.subject).after);
			assert.deepEqual(after, before);
			assert.equal(before.commit, sha);
			assert.equal(before.tree, ownerGit(slot, "rev-parse", `${sha}^{tree}`));
			assert.equal(before.base, fixture.started.baseSha);
			assert.equal(
				ownerGit(slot, "rev-parse", `${sha}^`),
				fixture.started.baseSha,
			);
			assert.equal(before.branch, "refs/heads/maestro-s0/s0");
			assert.equal(
				ownerGit(slot, "rev-parse", "refs/heads/maestro-s0/s0"),
				sha,
			);
			assert.equal(before.root, slot);
			assert.match(String(before.pin), /^[0-9a-f]{64}$/);
			assert.equal(before.worktree, "clean");
			assert.equal(before.replace_objects, "disabled");
			// The outcome names the child's report; the hand-off its facts.
			assert.equal(
				stored.outcome.reportId,
				await resultReport(fixture, workerId),
			);
			const handoff = object(object(stored.outcome.facts).handoff);
			assert.equal(object(handoff.parent).may_take_input, true);
			assert.equal(object(object(handoff.parent).state).fenced, false);
			assert.equal(object(handoff.child).status, "stopped");
			// Verification is complete: the run is closed, not interrupted.
			assert.deepEqual(parent.store.recovery().interrupted, []);
			// Delivered once the parent is idle, with the verdict in its envelope.
			await fixture.op("parentIdle");
			await until(async () =>
				(await fixture.op<{ message: string }[]>("parentPrompts")).some((p) =>
					p.message.startsWith(`[${WORKER_OUTCOME_ENVELOPE}`),
				),
			);
			const prompts = await fixture.op<{ message: string }[]>("parentPrompts");
			const delivered = prompts.find((p) =>
				p.message.startsWith(`[${WORKER_OUTCOME_ENVELOPE}`),
			);
			assert.match(delivered?.message ?? "", /"verdict":"accepted"/);
		}));

	it("a failing check is a bound rejection of that commit", () =>
		withParent(async ({ fixture, parent }) => {
			const { workerId, result } = await launched(parent, "rej", {
				run: "test -f missing.txt",
			});
			const sha = await fixture.op<string>("commit", {
				workerId,
				file: "feature.txt",
				text: "feature\n",
			});
			await report(fixture, workerId, { type: "done", commit: sha });
			await result;
			const verdict = object(outcomeOf(parent, "rej").outcome.verdict);
			assert.equal(verdict.verdict, "rejected");
			assert.equal(verdict.bound, true);
			assert.equal(verdict.exitCode, 1);
		}));

	it("over a sandboxed parent's channel: launch, interrupt, inspect and the bound check all run through it", () =>
		withParent(
			async ({ fixture, parent }) => {
				const spawned = launched(parent, "ch", { run: "test -f feature.txt" });
				// The create's hash is the one the channel recorded (its normalized body).
				await assert.doesNotReject(spawned, "the channel's create is observed");
				const { handle, workerId, result } = await spawned;
				// The P2-8 channel now serves executions.interrupt (the flipped gap).
				await parent.runs.interrupt("ch");
				const exec = parent.execOf(handle);
				const commands = parent.composed.provider.manifest(exec)?.commands;
				assert.deepEqual(
					commands?.map((c) => [c.purpose, c.outcome]),
					[
						["create", "observed"],
						["initial-prompt", "observed"],
						["interrupt", "observed"],
					],
					"the create's hash is the one the channel recorded",
				);
				const sha = await fixture.op<string>("commit", {
					workerId,
					file: "feature.txt",
					text: "feature\n",
				});
				await report(fixture, workerId, { type: "done", commit: sha });
				await result;
				const stored = outcomeOf(parent, "ch");
				assert.equal(object(stored.outcome.verdict).verdict, "accepted");
				assert.equal(object(object(stored.outcome.subject).before).commit, sha);
			},
			{ channel: true },
		));
});

describe("V1 bound check over real B2: no accepted verdict unless the subject binds", () => {
	it("a check that leaves a file behind changed the tree between before and after", () =>
		withParent(async ({ fixture, parent }) => {
			const { workerId, result } = await launched(parent, "stray", {
				run: "printf x > stray.txt",
			});
			const sha = await fixture.op<string>("commit", {
				workerId,
				file: "feature.txt",
				text: "feature\n",
			});
			await report(fixture, workerId, { type: "done", commit: sha });
			await result;
			const stored = outcomeOf(parent, "stray");
			const verdict = object(stored.outcome.verdict);
			assert.equal(verdict.verdict, "error");
			assert.equal(verdict.bound, false);
			assert.match(
				String(verdict.reason),
				/^subject changed: the checkout is dirty/,
			);
			assert.equal(
				verdict.exitCode,
				0,
				"the exit is evidence, not the verdict",
			);
			assert.equal(
				object(object(stored.outcome.subject).before).worktree,
				"clean",
			);
			assert.equal(
				object(object(stored.outcome.subject).after).worktree,
				"dirty",
			);
		}));

	it("a check that changes a tracked file is no accepted verdict", () =>
		withParent(async ({ fixture, parent }) => {
			const { workerId, result } = await launched(parent, "tracked", {
				run: "printf changed > note",
			});
			await report(fixture, workerId, { type: "done" });
			await result;
			const verdict = object(outcomeOf(parent, "tracked").outcome.verdict);
			assert.equal(verdict.verdict, "error");
			assert.match(String(verdict.reason), /subject changed/);
		}));

	it("a pin mismatch (the slot's HEAD retargeted after launch) is refused before the check runs", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "pin");
			const { workerId, result } = await launched(parent, "pin", {
				run: mark.run,
			});
			await fixture.op("setSlotHead", {
				slot: "s0",
				ref: "refs/heads/maestro-s1/s1",
			});
			await report(fixture, workerId, { type: "done" });
			await result;
			const verdict = object(outcomeOf(parent, "pin").outcome.verdict);
			assert.equal(verdict.verdict, "error");
			assert.match(String(verdict.reason), /refused \(artifact_pin_mismatch\)/);
			assert.equal(verdict.check, "not-run");
			assert.equal(mark.ran(), false, "the command never ran");
		}));

	it("a commit missing from the shared object store is refused before the check runs", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "missing");
			const { workerId, result } = await launched(parent, "missing", {
				run: mark.run,
			});
			const sha = await fixture.op<string>("commit", {
				workerId,
				file: "feature.txt",
				text: "feature\n",
			});
			await fixture.op("removeObject", { sha });
			await report(fixture, workerId, { type: "done", commit: sha });
			await result;
			const verdict = object(outcomeOf(parent, "missing").outcome.verdict);
			assert.equal(verdict.verdict, "error");
			assert.match(String(verdict.reason), /artifact_object_missing/);
			assert.equal(mark.ran(), false);
		}));

	it("a lost inspect reply binds nothing: no verdict, the command never runs", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "lost");
			const { client } = parent.composed;
			const call = client.call.bind(client);
			let inspections = 0;
			// SAFETY: a pass-through wrapper with the client's own signature.
			client.call = (async (op: string, options: never) => {
				// SAFETY: forwards the caller's own operation and options unchanged.
				const reply = await call(op as never, options);
				if (op === "artifacts.inspect") {
					inspections++;
					throw new Error("socket closed before the reply");
				}
				return reply;
			}) as typeof client.call;
			const { workerId, result } = await launched(parent, "lost", {
				run: mark.run,
			});
			await report(fixture, workerId, { type: "done" });
			await result;
			const verdict = object(outcomeOf(parent, "lost").outcome.verdict);
			assert.equal(verdict.verdict, "error");
			assert.match(String(verdict.reason), /before the check unavailable/);
			assert.equal(inspections, 1, "a read is never retried here");
			assert.equal(mark.ran(), false);
		}));

	it("a dirty checkout at report time is refused before the check runs", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "dirty");
			const { workerId, result } = await launched(parent, "dirty", {
				run: mark.run,
			});
			await fixture.op("write", { workerId, file: "stray.txt", text: "x" });
			await report(fixture, workerId, { type: "done" });
			await result;
			const verdict = object(outcomeOf(parent, "dirty").outcome.verdict);
			assert.match(String(verdict.reason), /dirty \(1 unexpected entry\)/);
			assert.equal(mark.ran(), false);
		}));

	it("a claimed commit other than the branch's is refused: a claim is never the subject", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "claim");
			const { workerId, result } = await launched(parent, "claim", {
				run: mark.run,
			});
			await fixture.op<string>("commit", {
				workerId,
				file: "feature.txt",
				text: "feature\n",
			});
			await report(fixture, workerId, {
				type: "done",
				commit: fixture.started.baseSha,
			});
			await result;
			const verdict = object(outcomeOf(parent, "claim").outcome.verdict);
			assert.match(String(verdict.reason), /claimed commit is not/);
			assert.equal(mark.ran(), false);
		}));
});

describe("V1 bound check over real B2: failure and cancel hand-offs", () => {
	it("a failed report is never checked; its hand-off keeps the report and the parent's state", () =>
		withParent(async ({ fixture, parent, scratch }) => {
			const mark = marked(scratch, "failed");
			const { workerId, result } = await launched(parent, "failed", {
				run: mark.run,
			});
			await report(fixture, workerId, {
				type: "error",
				errorMessage: "could not finish",
			});
			const report_id = await resultReport(fixture, workerId);
			assert.equal((await result).outcome, "failed");
			const stored = outcomeOf(parent, "failed");
			const verdict = object(stored.outcome.verdict);
			assert.equal(verdict.verdict, "skipped");
			assert.equal(verdict.reason, "provider error");
			assert.equal(mark.ran(), false);
			const handoff = object(object(stored.outcome.facts).handoff);
			assert.equal(object(handoff.reports).result, report_id);
			assert.equal(stored.outcome.reportId, report_id);
		}));

	it("a missing report: the child's end fences its parent (4a); the hand-off names the fence and asks for the owner, never a made-up result", () =>
		withParent(async ({ fixture, parent }) => {
			const { workerId, result } = await launched(parent, "gone", {
				run: "true",
			});
			await fixture.op("exit", { workerId });
			assert.equal((await result).outcome, "failed");
			const stored = outcomeOf(parent, "gone");
			assert.equal(object(stored.outcome.verdict).verdict, "skipped");
			assert.equal(stored.outcome.reportId, undefined);
			const handoff = object(object(stored.outcome.facts).handoff);
			assert.equal(object(handoff.reports).result, null);
			const parentFacts = object(handoff.parent);
			assert.equal(object(parentFacts.state).fenced, true);
			assert.equal(parentFacts.needs, "owner-reconciliation");
			assert.equal(parentFacts.may_take_input, false);
			const fence = (await fixture.row(fixture.started.parentWorkerId)).fence;
			assert.equal(
				object(parentFacts.state).fence_command_id,
				fence?.command_id,
			);
			// The outcome is kept for the owner, never cleared or redirected.
			await until(() =>
				parent.outbox
					.attention()
					.some((item) => item.deliveryId === stored.outcome.deliveryId),
			);
		}));

	it("a cancelled check is its own outcome: skipped (cancelled), the run killed with confirmed termination", () =>
		withParent(async ({ fixture, parent }) => {
			const { task, workerId, result } = await launched(parent, "cx", {
				run: "sleep 30",
			});
			await report(fixture, workerId, { type: "done" });
			// The subject is durable once the check started.
			await until(() =>
				parent.store
					.recovery()
					.interrupted.some(
						(run) => run.taskId === task.id && run.checks.length,
					),
			);
			const cancelled = await cancelConfirmed(parent, task.id);
			assert.equal(cancelled.status, "confirmed");
			const settled = await result;
			assert.equal(settled.outcome, "killed");
			assert.equal(settled.cancellation?.termination, "confirmed");
			const stored = outcomeOf(parent, "cx");
			const verdict = object(stored.outcome.verdict);
			assert.equal(verdict.verdict, "skipped");
			assert.equal(verdict.reason, "cancelled");
			assert.equal(verdict.check, "cancelled");
			assert.ok(
				object(stored.outcome.subject).before,
				"the subject it ran against",
			);
			assert.equal(
				object(stored.outcome.cancellation).termination,
				"confirmed",
			);
		}));

	it("a cancel before any report: intent durable before the stop, stop evidence kept, the 4a fence named; no child result is made up", () =>
		withParent(async ({ fixture, parent }) => {
			const { task, handle, result } = await launched(parent, "cancel");
			const report = await cancelConfirmed(parent, task.id);
			assert.equal(report.status, "confirmed");
			const settled = await result;
			assert.equal(settled.outcome, "killed");
			const stored = outcomeOf(parent, "cancel");
			assert.equal(stored.outcome.reportId, undefined);
			assert.equal(stored.outcome.textSource, undefined);
			assert.equal(
				object(stored.outcome.cancellation).termination,
				"confirmed",
			);
			const handoff = object(object(stored.outcome.facts).handoff);
			const intent = Number(object(handoff.cancel).requested_at);
			const manifest = parent.composed.provider.manifest(parent.execOf(handle));
			const stop = manifest?.commands.find((c) => c.purpose === "stop");
			assert.ok(stop && intent <= stop.recorded_at, "intent before the stop");
			assert.ok(
				Array.isArray(handoff.commands) &&
					handoff.commands.some(
						(c) =>
							isRecord(c) &&
							c.purpose === "stop" &&
							c.command_id === stop.command_id,
					),
			);
			assert.equal(object(handoff.child).status, "stopped");
			// A confirmed child stop and a parent that may take input are separate facts.
			assert.equal(object(handoff.parent).needs, "owner-reconciliation");
			assert.ok((await fixture.row(fixture.started.parentWorkerId)).fence);
		}));
});

describe("V1 bound check over real B2: per-run failures", () => {
	it("one child's missing report and another's unconfirmed stop never affect a sibling's bound verdict", () =>
		withParent(
			async ({ fixture, parent }) => {
				const accept = { run: "test -f feature.txt" };
				const a = await launched(parent, "a", accept);
				const b = await launched(parent, "b", accept);
				const c = await launched(parent, "c", accept);
				// b's stop is never observed: its termination stays unconfirmed.
				await fixture.op("blockStop", { workerId: b.workerId });
				const shaB = await fixture.op<string>("commit", {
					workerId: b.workerId,
					file: "feature.txt",
					text: "b\n",
				});
				await report(fixture, b.workerId, {
					type: "done",
					summary: "b is ready",
					commit: shaB,
				});
				// a ends without any report.
				await fixture.op("exit", { workerId: a.workerId });
				const shaC = await fixture.op<string>("commit", {
					workerId: c.workerId,
					file: "feature.txt",
					text: "c\n",
				});
				await report(fixture, c.workerId, { type: "done", commit: shaC });
				await Promise.all([a.result, b.result, c.result]);
				// c: its own bound verdict, on its own commit.
				const storedC = outcomeOf(parent, "c");
				assert.equal(object(storedC.outcome.verdict).verdict, "accepted");
				assert.equal(
					object(object(storedC.outcome.subject).before).commit,
					shaC,
				);
				// a: its own failure, no verdict.
				assert.equal(
					object(outcomeOf(parent, "a").outcome.verdict).verdict,
					"skipped",
				);
				// b: the report is kept, no verdict, the worker still owned.
				const storedB = outcomeOf(parent, "b");
				const verdictB = object(storedB.outcome.verdict);
				assert.equal(verdictB.verdict, "error");
				assert.equal(verdictB.reason, "child termination not confirmed");
				assert.equal(
					storedB.outcome.reportId,
					await resultReport(fixture, b.workerId),
				);
				assert.match(storedB.outcome.text, /b is ready/);
				assert.equal(object(verdictB.termination).termination, "unconfirmed");
				assert.deepEqual(
					await parent.composed.provider.reconcile(parent.execOf(b.handle)),
					{ kind: "live" },
				);
			},
			{ slots: 3 },
		));
});

describe("interrupted-run hand-off over real B2: a lost close", () => {
	it("a hand-off whose close of the earlier owner's run was lost is committed once when it is retried", async () => {
		piWorkerCheckout();
		const fixture = await B2Fixture.start(1);
		const dir = mkdtempSync(join(tmpdir(), "maestro-bound-"));
		const parents: Parent[] = [];
		try {
			// The earlier owner recorded an attempt and stopped: an open run.
			const earlier = await composeWorkerParent(fixture.started, dir, {
				checks: {},
			});
			parents.push(earlier);
			await earlier.store.recordAttempt({ taskId: "lost", attempt: 1 });
			await earlier.dispose();
			parents.pop();
			let fail = true;
			const later = await composeWorkerParent(fixture.started, dir, {
				checks: {},
				wrapStore: (real) => ({
					parent: real.parent,
					owner: real.owner,
					recordAttempt: (attempt) => real.recordAttempt(attempt),
					recordCheck: (check) => real.recordCheck(check),
					commit: (draft) => real.commit(draft),
					commitBatch: (batch) => real.commitBatch(batch),
					dispatch: (id, dispatch) => real.dispatch(id, dispatch),
					settle: (id, settlement) => real.settle(id, settlement),
					async closeRun(taskId, reason, owner) {
						if (fail) {
							fail = false;
							throw new Error("EIO: the close was lost");
						}
						return real.closeRun(taskId, reason, owner);
					},
					get: (id) => real.get(id),
					observerState: (key) => real.observerState(key),
					recovery: () => real.recovery(),
					compact: () => real.compact(),
					close: () => real.close(),
				}),
			});
			parents.push(later);
			const checks = later.checks;
			assert.ok(checks);
			await assert.rejects(
				checks.handOffInterrupted(later.store),
				/the close was lost/,
			);
			// The parent's state changed meanwhile: the retry reads other facts,
			// yet hands off the outcome already committed, never a second one.
			await fixture.op("parentStop");
			const handed = await checks.handOffInterrupted(later.store);
			assert.equal(handed.length, 1);
			assert.equal(handed[0]?.outcome.outcome, "interrupted");
			const recovery = later.store.recovery();
			assert.deepEqual(recovery.interrupted, []);
			assert.equal(
				recovery.outcomes.filter((o) => o.outcome.taskId === "lost").length,
				1,
				"committed once",
			);
		} finally {
			for (const parent of parents) await parent.dispose();
			await fixture.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
