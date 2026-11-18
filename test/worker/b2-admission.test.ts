/**
 * P3-9 against the real B2 fixture (see b2-conformance.test.ts): receipt-backed
 * parent admission and its recovery. The O1 crash cuts run the Maestro side in
 * its own process (`maestro-parent.ts`) and SIGKILL it; the supervisor keeps
 * running, so what pi received on the parent is counted independently.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client, type Receipt } from "@nublai/pi-worker-client";
import { encodeResultClaim } from "../../maestro/adapters/worker/fd-report.ts";
import { MAESTRO_WORKER_PARENT_METHODS } from "../../maestro/adapters/worker/grant-profile.ts";
import {
	readWorkerParent,
	WORKER_OUTCOME_ENVELOPE,
	WorkerParentAdmission,
	workerParentIdentity,
} from "../../maestro/adapters/worker/parent-admission.ts";
import {
	isFiniteNumber,
	isRecord,
} from "../../maestro/core/config/type-guards.ts";
import {
	isOutcomeStoreError,
	type OutcomeJson,
	type OutcomeJsonObject,
	type OutcomeRecovery,
} from "../../maestro/core/outcome-store.ts";
import { AdmissionOutbox } from "../../maestro/runtime/admission-outbox.ts";
import { FileOutcomeStore } from "../../maestro/runtime/file-outcome-store.ts";
import type {
	MaestroCut,
	MaestroEvent,
} from "../fixtures/worker-b2/maestro-parent.ts";
import {
	composeWorkerParent,
	outcomesDir,
	workerTask,
} from "../helpers/worker-admission.ts";
import { B2Fixture, piWorkerCheckout } from "../helpers/worker-b2-fixture.ts";

const MAESTRO = new URL(
	"../fixtures/worker-b2/maestro-parent.ts",
	import.meta.url,
).pathname;

interface ParentPrompt {
	command_id: string;
	message: string;
}

/** The outcome deliveries pi itself received on the parent. */
async function deliveries(fixture: B2Fixture): Promise<ParentPrompt[]> {
	return (await fixture.op<ParentPrompt[]>("parentPrompts")).filter((p) =>
		p.message.startsWith(`[${WORKER_OUTCOME_ENVELOPE}`),
	);
}

function finalStates(recovery: OutcomeRecovery) {
	return recovery.final.map((f) => [f.state, f.evidence ?? null]);
}

async function until(check: () => Promise<boolean> | boolean, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Whether a client call is a prompt to the parent (an outcome delivery). */
let parentWorkerId = "";
function toParent(op: string, options: { path?: { worker_id?: string } }) {
	return (
		op === "sessions.prompt" && options?.path?.worker_id === parentWorkerId
	);
}

/** The client's per-call timeout is read-only by type; the test shortens it. */
function setTimeoutMs(client: Client, ms: number): void {
	Object.defineProperty(client, "timeoutMs", { value: ms, writable: true });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holds the client's first event subscription (the Observer's first snapshot)
 * until `release`, or until the subscription is aborted; other calls run.
 */
function gateFirstWatch(client: Client) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const watch = client.watch.bind(client);
	let first = true;
	client.watch = async (onFrame, options = {}) => {
		if (first) {
			first = false;
			const signal = options.signal;
			await new Promise<void>((resolve) => {
				void gate.then(resolve);
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			if (signal?.aborted) return;
		}
		return watch(onFrame, options);
	};
	return release;
}

/** Waits until the supervisor holds a child's durable report of `kind`. */
async function reported(fixture: B2Fixture, workerId: string, kind: string) {
	await until(
		async () =>
			(
				await fixture.op<{ child_reports?: { kind?: string }[] }>("row", {
					workerId,
				})
			).child_reports?.some((report) => report.kind === kind) === true,
	);
}

/** The retained help outcomes of a store, by their source report. */
function helpOutcomes(recovery: OutcomeRecovery) {
	return recovery.outcomes
		.filter((stored) => stored.outcome.kind === "help")
		.map((stored) => stored.outcome.reportId);
}

/** One Maestro process; resolves its events as they come and its exit. */
function maestro(
	fixture: B2Fixture,
	dir: string,
	mode: "run" | "recover",
	cut?: MaestroCut,
	extra: { checks?: boolean; accept?: string; cancel?: boolean } = {},
) {
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			MAESTRO,
			JSON.stringify({ started: fixture.started, dir, mode, cut, ...extra }),
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: process.env.HOME ?? tmpdir(),
				TMPDIR: tmpdir(),
				LANG: "C",
			},
		},
	);
	const events: MaestroEvent[] = [];
	const waiters: (() => void)[] = [];
	let stderr = "";
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			// SAFETY: maestro-parent.ts writes one MaestroEvent per line.
			events.push(JSON.parse(buffer.slice(0, nl)) as MaestroEvent);
			buffer = buffer.slice(nl + 1);
			for (const wake of waiters.splice(0)) wake();
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
		child.once("exit", (code, signal) => {
			for (const wake of waiters.splice(0)) wake();
			resolve(signal ?? code);
		}),
	);
	let done = false;
	void exited.then(() => {
		done = true;
	});
	return {
		events,
		exited,
		stderr: () => stderr,
		async next<K extends MaestroEvent["event"]>(
			kind: K,
		): Promise<Extract<MaestroEvent, { event: K }>> {
			for (;;) {
				const found = events.find((e) => e.event === kind);
				if (found) {
					// SAFETY: found by its discriminant `event`, which is K.
					return found as Extract<MaestroEvent, { event: K }>;
				}
				const error = events.find((e) => e.event === "error");
				if (error)
					assert.fail(`maestro failed: ${JSON.stringify(error)} ${stderr}`);
				if (done) assert.fail(`maestro exited before ${kind}: ${stderr}`);
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
	};
}

async function withFixture(
	run: (fixture: B2Fixture, dir: string) => Promise<void>,
	options: { evictable?: boolean } = {},
) {
	piWorkerCheckout();
	const fixture = await B2Fixture.start(4, options);
	parentWorkerId = fixture.started.parentWorkerId;
	const dir = mkdtempSync(join(tmpdir(), "maestro-admission-"));
	try {
		await run(fixture, dir);
	} finally {
		await fixture.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

/** One child launched by the run owner while the parent's turn runs. */
async function launched(
	parent: Awaited<ReturnType<typeof composeWorkerParent>>,
	id = "t",
) {
	const task = workerTask(id, parent.session.root);
	const handle = await parent.runs.spawn(task);
	return { task, handle, workerId: parent.workerOf(handle) };
}

const RESULT = encodeResultClaim({
	type: "done",
	summary: "the change is ready",
});

describe("parent admission over real B2: O1 crash cuts", () => {
	/**
	 * Every cut: run a task to delivery and SIGKILL the Maestro process at the
	 * cut, then restart it over the same store. The supervisor never restarts
	 * here, so pi's own prompt count on the parent is the ground truth.
	 */
	const cases: {
		cut: MaestroCut;
		/** Outcome deliveries pi received on the parent, after recovery. */
		sent: number;
		/** The recovered store: final deliveries, held outcomes, interrupted runs. */
		check(recovered: Extract<MaestroEvent, { event: "recovered" }>): void;
	}[] = [
		{
			cut: "before-commit",
			sent: 0,
			check({ recovery }) {
				assert.deepEqual(recovery.outcomes, []);
				assert.deepEqual(recovery.final, []);
				assert.equal(
					recovery.interrupted.length,
					1,
					"the run shows as interrupted",
				);
			},
		},
		{
			cut: "after-commit",
			sent: 1,
			check({ recovery }) {
				assert.deepEqual(finalStates(recovery), [["admitted", "receipt"]]);
				assert.deepEqual(recovery.outcomes, []);
			},
		},
		{
			cut: "after-dispatch",
			sent: 0,
			check({ recovery, attention }) {
				assert.deepEqual(recovery.final, []);
				assert.equal(recovery.outcomes[0]?.delivery.state, "uncertain");
				assert.ok(
					recovery.outcomes[0]?.delivery.request,
					"its request was durable",
				);
				assert.deepEqual(
					attention.map((a) => [a.state, a.needs, a.reason]),
					[["uncertain", "owner", "receipt_missing"]],
				);
			},
		},
		{
			cut: "after-admission",
			sent: 1,
			check({ recovery }) {
				assert.deepEqual(finalStates(recovery), [["admitted", "receipt"]]);
				assert.deepEqual(recovery.outcomes, []);
			},
		},
		{
			cut: "after-ack",
			sent: 1,
			check({ recovery }) {
				assert.deepEqual(finalStates(recovery), [["admitted", "receipt"]]);
			},
		},
		{
			cut: "compaction-before-rename",
			sent: 1,
			check({ recovery }) {
				assert.deepEqual(finalStates(recovery), [["admitted", "receipt"]]);
			},
		},
		{
			cut: "compaction-after-rename",
			sent: 1,
			check({ recovery }) {
				assert.deepEqual(finalStates(recovery), [["admitted", "receipt"]]);
			},
		},
	];
	for (const { cut, sent, check } of cases)
		it(`${cut}: the committed outcome is recovered exactly; nothing is replayed, no second child`, () =>
			withFixture(async (fixture, dir) => {
				const run = maestro(fixture, dir, "run", cut);
				const { workerId } = await run.next("launched");
				await fixture.op("parentIdle");
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await run.next("cut");
				assert.equal(await run.exited, "SIGKILL", run.stderr());
				const before = (await deliveries(fixture)).length;
				const recover = maestro(fixture, dir, "recover");
				const recovered = await recover.next("recovered");
				assert.equal(await recover.exited, 0, recover.stderr());
				check(recovered);
				const after = await deliveries(fixture);
				assert.equal(after.length, sent, "outcome prompts pi received");
				assert.ok(after.length - before <= 1);
				// A delivered prompt names the committed delivery and was sent once.
				if (sent)
					assert.equal(new Set(after.map((p) => p.message)).size, after.length);
				assert.equal(await fixture.op<number>("acquisitions"), 1);
			}));

	it("without a cut, one task delivers once with receipt evidence", () =>
		withFixture(async (fixture, dir) => {
			const run = maestro(fixture, dir, "run");
			const { workerId } = await run.next("launched");
			await fixture.op("parentIdle");
			await fixture.op("report", { workerId, kind: "result", message: RESULT });
			const settled = await run.next("settled");
			assert.equal(await run.exited, 0, run.stderr());
			assert.deepEqual(finalStates(settled.recovery), [
				["admitted", "receipt"],
			]);
			const [prompt] = await deliveries(fixture);
			assert.match(
				prompt!.message,
				/^\[maestro-outcome\/v1 result\] delivery /,
			);
			assert.match(prompt!.message, /the change is ready/);
			// A second process start sends nothing more.
			const recover = maestro(fixture, dir, "recover");
			await recover.next("recovered");
			assert.equal((await deliveries(fixture)).length, 1);
		}));
});

describe("parent admission over real B2: busy, fenced and lost replies", () => {
	it("waits while the parent's turn runs, keeping the outcome; delivers once it is idle", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.needs]),
					[["pending", "busy"]],
				);
				await delay(150);
				assert.equal((await deliveries(fixture)).length, 0);
				await fixture.op("parentIdle");
				await until(() => parent.store.recovery().final.length === 1);
				assert.deepEqual(finalStates(parent.store.recovery()), [
					["admitted", "receipt"],
				]);
				await delay(100);
				assert.equal((await deliveries(fixture)).length, 1);
			} finally {
				await parent.dispose();
			}
		}));

	it("a lost reply on the parent stays uncertain and fences it: never resent; the next outcome waits for the owner's resolution", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const first = await launched(parent, "first");
				const second = await launched(parent, "second");
				await fixture.op("parentIdle");
				await fixture.op("parentLoseNextReply");
				const one = parent.runs.supervise(first.handle, first.task);
				await fixture.op("report", {
					workerId: first.workerId,
					kind: "result",
					message: RESULT,
				});
				await one;
				const [lost] = parent.outbox.attention();
				assert.equal(lost?.state, "uncertain");
				assert.equal(lost?.reason, "outcome_unknown");
				assert.ok((await fixture.row(fixture.started.parentWorkerId)).fence);
				// The second outcome waits behind the fence; nothing clears it.
				const two = parent.runs.supervise(second.handle, second.task);
				await fixture.op("report", {
					workerId: second.workerId,
					kind: "result",
					message: RESULT,
				});
				await two;
				await delay(150);
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.needs]),
					[
						["uncertain", "owner"],
						["blocked", "fenced"],
					],
				);
				assert.equal((await deliveries(fixture)).length, 1);
				assert.ok((await fixture.row(fixture.started.parentWorkerId)).fence);
				// The owner resolves the fence; only the waiting outcome is delivered.
				await fixture.op("parentResolve", { disposition: "abandon" });
				await fixture.op("parentIdle");
				await until(
					() =>
						parent.store
							.recovery()
							.final.some(
								(f) =>
									f.deliveryId === parent.outbox.attention()[1]?.deliveryId,
							) || parent.outbox.attention().length === 1,
				);
				const sent = await deliveries(fixture);
				assert.equal(sent.length, 2);
				assert.notEqual(sent[0]!.command_id, sent[1]!.command_id);
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.reason]),
					[["uncertain", "outcome_unknown"]],
				);
				// Only the owner gives the uncertain one up.
				await parent.outbox.abandon(
					lost!.deliveryId,
					"checked the parent's session",
				);
				assert.deepEqual(parent.outbox.attention(), []);
				assert.equal((await deliveries(fixture)).length, 2);
			} finally {
				await parent.dispose();
			}
		}));

	it("a reply lost in transport is read back by its receipt: admitted, sent once", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				const { client } = parent.composed;
				const call = client.call.bind(client);
				// SAFETY: a pass-through wrapper with the client's own signature.
				client.call = (async (op: string, options: never) => {
					// SAFETY: forwards the caller's own operation and options unchanged.
					const reply = await call(op as never, options);
					if (toParent(op, options))
						throw new Error("socket closed before the reply");
					return reply;
				}) as typeof client.call;
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(finalStates(parent.store.recovery()), [
					["admitted", "receipt"],
				]);
				assert.equal((await deliveries(fixture)).length, 1);
			} finally {
				await parent.dispose();
			}
		}));

	it("a delivered receipt that does not say the input was accepted is never admission", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				const { client } = parent.composed;
				const call = client.call.bind(client);
				// SAFETY: a pass-through wrapper with the client's own signature.
				client.call = (async (op: string, options: never) => {
					// SAFETY: forwards the caller's own operation and options unchanged.
					const reply = await call(op as never, options);
					if (!toParent(op, options)) return reply;
					// SAFETY: a mutation's reply is its receipt.
					const receipt = reply as Receipt;
					return { ...receipt, admission: "queued" };
				}) as typeof client.call;
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.reason]),
					[["uncertain", "receipt_not_admitted: queued"]],
				);
				assert.equal(parent.store.recovery().final.length, 0);
				assert.equal((await deliveries(fixture)).length, 1, "never resent");
			} finally {
				await parent.dispose();
			}
		}));

	it("a receipt that does not match the recorded request is never admission", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				const { client } = parent.composed;
				const call = client.call.bind(client);
				// SAFETY: a pass-through wrapper with the client's own signature.
				client.call = (async (op: string, options: never) => {
					// SAFETY: forwards the caller's own operation and options unchanged.
					const reply = await call(op as never, options);
					if (toParent(op, options)) throw new Error("reply lost");
					// The receipt read returns another request's receipt for this command.
					if (op === "receipts.get") {
						// SAFETY: receipts.get replies with a Receipt object.
						const receipt = reply as Receipt;
						return { ...receipt, request_hash: "0".repeat(64) };
					}
					return reply;
				}) as typeof client.call;
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.reason]),
					[["uncertain", "receipt_mismatch"]],
				);
				assert.equal(parent.store.recovery().final.length, 0);
			} finally {
				await parent.dispose();
			}
		}));
});

describe("parent admission over real B2: a B2 restart", () => {
	it("a delivery admitted before the restart whose reply was lost is read back after it", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				const { client } = parent.composed;
				const call = client.call.bind(client);
				let b2Down = false;
				// SAFETY: a pass-through wrapper with the client's own signature.
				client.call = (async (op: string, options: never) => {
					if (b2Down && op === "receipts.get")
						throw new Error("B2 unreachable");
					// SAFETY: forwards the caller's own operation and options unchanged.
					const reply = await call(op as never, options);
					if (toParent(op, options)) {
						b2Down = true;
						throw new Error("socket closed before the reply");
					}
					return reply;
				}) as typeof client.call;
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.needs]),
					[["uncertain", "owner"]],
				);
				assert.match(
					parent.outbox.attention()[0]!.reason ?? "",
					/receipt_unreadable/,
				);
				assert.match(
					await fixture.op<string>("restart"),
					/^(stopped|cleanup_pending)$/,
				);
				b2Down = false;
				await until(() => parent.store.recovery().final.length === 1);
				assert.deepEqual(finalStates(parent.store.recovery()), [
					["admitted", "receipt"],
				]);
				assert.equal((await deliveries(fixture)).length, 1);
			} finally {
				await parent.dispose();
			}
		}));

	it("a restart between dispatch and reply leaves the delivery unknown, never resent", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir, {
				provider: {},
			});
			try {
				// A short call timeout: pi never answers this prompt.
				setTimeoutMs(parent.composed.client, 500);
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				await fixture.op("parentHangNextPrompt");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.reason]),
					[["uncertain", "receipt_not_settled"]],
				);
				setTimeoutMs(parent.composed.client, 10_000);
				await fixture.op("restart");
				await until(
					() => parent.outbox.attention()[0]?.reason === "outcome_unknown",
				);
				await delay(100);
				assert.equal((await deliveries(fixture)).length, 1);
				assert.equal(parent.outbox.attention()[0]?.state, "uncertain");
			} finally {
				await parent.dispose();
			}
		}));

	it("a pending outcome after a restart that stopped the parent is blocked, never redirected or relaunched", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				const workers = await fixture.op<number>("workers");
				const status = await fixture.op<string>("restart");
				assert.match(status, /^(stopped|cleanup_pending)$/);
				await until(() => parent.outbox.attention()[0]?.state === "blocked");
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.needs, a.reason]),
					[["parent-gone", `parent_stopped: ${status}`]],
				);
				assert.equal(
					await fixture.op<number>("workers"),
					workers,
					"nothing relaunched",
				);
				assert.equal((await deliveries(fixture)).length, 0);
			} finally {
				await parent.dispose();
			}
		}));
});

describe("parent admission over real B2: wrong, rebound and missing parents", () => {
	it("a store for one parent is never opened or delivered for another without explicit adoption", () =>
		withFixture(async (fixture, dir) => {
			const client = new Client({
				socketPath: fixture.started.socketPath,
				grantFile: fixture.started.grantFile,
			});
			const binding = await readWorkerParent(
				client,
				fixture.started.parentWorkerId,
			);
			const store = await FileOutcomeStore.open({
				dir: outcomesDir(dir),
				parent: workerParentIdentity(binding),
			});
			const other = { ...binding, session_id: "another-session" };
			assert.throws(
				() =>
					new AdmissionOutbox({
						store,
						admission: new WorkerParentAdmission({ client, parent: other }),
					}),
				/another parent/,
			);
			await store.close();
			await assert.rejects(
				FileOutcomeStore.open({
					dir: outcomesDir(dir),
					parent: workerParentIdentity(other),
				}),
				(error: Error) => isOutcomeStoreError(error, "parent"),
			);
		}));

	it("a rebound parent session blocks delivery; only an explicit adoption delivers to the new session", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			let adopted: Awaited<ReturnType<typeof composeWorkerParent>> | undefined;
			try {
				// Driven step by step (no background loop): the rebind lands while
				// the outcome waits, never racing a delivery to the old session.
				const { task, handle, workerId } = await launched(parent);
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				const [waiting] = parent.outbox.attention();
				assert.equal(waiting?.needs, "busy");
				await fixture.op("parentIdle");
				await fixture.op("parentNewSession");
				assert.equal(
					await parent.outbox.submit(waiting!.deliveryId),
					"blocked",
				);
				assert.equal(parent.outbox.attention()[0]?.needs, "parent-changed");
				assert.match(
					parent.outbox.attention()[0]?.reason ?? "",
					/^parent_rebound/,
				);
				assert.equal(
					await parent.outbox.submit(waiting!.deliveryId),
					"blocked",
				);
				assert.equal((await deliveries(fixture)).length, 0);
				await parent.dispose();
				// The owner adopts the store for the parent's new session.
				adopted = await composeWorkerParent(fixture.started, dir, {
					store: { adopt: true },
				});
				await adopted.outbox.start();
				await until(() => adopted!.store.recovery().final.length === 1);
				assert.deepEqual(finalStates(adopted.store.recovery()), [
					["admitted", "receipt"],
				]);
				assert.equal((await deliveries(fixture)).length, 1);
			} finally {
				await (adopted ?? parent).dispose().catch(() => {});
			}
		}));

	it("an unreachable B2 keeps the outcome pending without a durable change; it is delivered once B2 is back", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				await fixture.op("unserve");
				const done = parent.runs.supervise(handle, task);
				// The child's report reaches its row in the worker; B2 serves again for the run owner.
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await fixture.op("serve");
				await done;
				await until(() => parent.store.recovery().final.length === 1);
				await fixture.op("unserve");
				const second = await parent.store.commit({
					taskId: "manual",
					attempt: 1,
					kind: "result",
					outcome: "completed",
					text: "later",
				});
				assert.equal(
					await parent.outbox.submit(second.outcome.deliveryId),
					"pending",
				);
				assert.deepEqual(
					parent.outbox.attention().map((a) => [a.state, a.needs]),
					[["pending", "unavailable"]],
				);
				assert.equal(
					parent.store.get(second.outcome.deliveryId)?.delivery.attempts,
					0,
				);
				await fixture.op("serve");
				await fixture.op("parentIdle");
				await until(() => parent.store.recovery().final.length === 2);
				assert.equal((await deliveries(fixture)).length, 2);
			} finally {
				await parent.dispose();
			}
		}));
});

describe("parent admission over real B2: expired and denied receipts", () => {
	it("an expired receipt keeps the delivery uncertain and surfaced, never resent", () =>
		withFixture(
			async (fixture, dir) => {
				const parent = await composeWorkerParent(fixture.started, dir);
				try {
					const { client } = parent.composed;
					const call = client.call.bind(client);
					let lose = true;
					let reads = true;
					// SAFETY: a pass-through wrapper with the client's own signature.
					client.call = (async (op: string, options: never) => {
						if (op === "receipts.get" && !reads)
							throw new Error("B2 unreachable");
						// SAFETY: forwards the caller's own operation and options unchanged.
						const reply = await call(op as never, options);
						if (toParent(op, options) && lose) {
							lose = false;
							reads = false;
							throw new Error("socket closed before the reply");
						}
						return reply;
					}) as typeof client.call;
					await parent.outbox.start();
					const { task, handle, workerId } = await launched(parent);
					await fixture.op("parentIdle");
					const done = parent.runs.supervise(handle, task);
					await fixture.op("report", {
						workerId,
						kind: "result",
						message: RESULT,
					});
					await done;
					assert.equal(parent.outbox.attention()[0]?.state, "uncertain");
					// The parent's turn ends (its execution no longer pins the receipt),
					// and retention evicts the delivery's receipt before it is read back.
					await fixture.op("parentIdle");
					const expired = await fixture.op<string[]>("evictReceipts");
					assert.ok(expired.includes(parent.outbox.attention()[0]!.commandId!));
					reads = true;
					await until(
						() => parent.outbox.attention()[0]?.reason === "receipt_expired",
					);
					await delay(100);
					assert.equal(parent.outbox.attention()[0]?.state, "uncertain");
					assert.equal((await deliveries(fixture)).length, 1);
				} finally {
					await parent.dispose();
				}
			},
			{ evictable: true },
		));

	it("a receipt the grant may not read stays uncertain: the grant is never widened", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				const [final] = parent.store.recovery().final;
				assert.equal(final?.state, "admitted");
				await parent.dispose();
				// Another store owner whose grant is scoped to a foreign worker only.
				const { workerId: foreign } = await fixture.op<{ workerId: string }>(
					"foreign",
				);
				const grantFile = await fixture.op<string>("grantFor", {
					workerId: foreign,
					profile: MAESTRO_WORKER_PARENT_METHODS,
				});
				const narrow = new Client({
					socketPath: fixture.started.socketPath,
					grantFile,
				});
				const binding = parent.binding;
				const admission = new WorkerParentAdmission({
					client: narrow,
					parent: binding,
				});
				// The admitted delivery's command, read back with the narrow grant.
				const reopened = await FileOutcomeStore.open({
					dir: outcomesDir(dir),
					parent: workerParentIdentity(binding),
				});
				try {
					const pending = await reopened.commit({
						taskId: "denied",
						attempt: 1,
						kind: "result",
						outcome: "completed",
						text: "x",
					});
					const sent = await deliveries(fixture);
					await reopened.dispatch(pending.outcome.deliveryId, {
						commandId: sent[0]!.command_id,
						request: {
							operation: "sessions.prompt",
							worker_id: binding.worker_id,
							request_hash: "0".repeat(64),
						},
					});
					const attempt = await admission.reconcile(
						reopened.get(pending.outcome.deliveryId)!.delivery,
					);
					assert.equal(attempt.outcome, "unknown");
					assert.ok(attempt.outcome === "unknown" && attempt.final);
					assert.equal(
						attempt.outcome === "unknown" ? attempt.reason : "",
						"receipt_scope_denied",
					);
				} finally {
					await reopened.close();
				}
			} finally {
				await parent.dispose().catch(() => {});
			}
		}));
});

describe("parent admission over real B2: help is not completion", () => {
	it("a help request is its own delivery, saved with the Observer's state; the run continues to its one result", () =>
		withFixture(async (fixture, dir) => {
			const parent = await composeWorkerParent(fixture.started, dir);
			try {
				await parent.outbox.start();
				const { task, handle, workerId } = await launched(parent);
				await fixture.op("parentIdle");
				const done = parent.runs.supervise(handle, task);
				await fixture.op("report", {
					workerId,
					kind: "help",
					message: "which file?",
				});
				await until(async () => (await deliveries(fixture)).length === 1);
				const [help] = await deliveries(fixture);
				assert.match(help!.message, /^\[maestro-outcome\/v1 help\]/);
				assert.match(help!.message, /which file\?/);
				// The help request did not end the run.
				assert.ok(parent.runs.getHandle(task.id));
				// It was saved in the same record as the Observer's state.
				const saved = parent.store.observerState("pi-worker/observer");
				assert.ok(saved);
				// The parent answers; the child then reports its result.
				await fixture.op("parentIdle");
				// The answer goes to the live child as its own input (B2 refuses resume).
				await parent.composed.provider.prompt(parent.execOf(handle), {
					id: "answer-1",
					text: "src/a.ts",
				});
				const prompts = await fixture.op<{ message: string }[]>("prompts", {
					workerId,
				});
				assert.equal(prompts.at(-1)?.message, "src/a.ts");
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: RESULT,
				});
				await done;
				await until(() => parent.store.recovery().final.length === 2);
				const sent = await deliveries(fixture);
				assert.deepEqual(
					sent.map((p) => p.message.split("]")[0]),
					[
						`[${WORKER_OUTCOME_ENVELOPE} help`,
						`[${WORKER_OUTCOME_ENVELOPE} result`,
					],
				);
			} finally {
				await parent.dispose();
			}
		}));

	it("after a restart the Observer resumes from the saved state: a help request is neither lost nor delivered twice", () =>
		withFixture(async (fixture, dir) => {
			const first = await composeWorkerParent(fixture.started, dir);
			let workerId: string;
			try {
				await first.outbox.start();
				({ workerId } = await launched(first));
				await fixture.op("report", {
					workerId,
					kind: "help",
					message: "which file?",
				});
				await until(() => first.outbox.attention().length === 1);
				assert.equal(first.outbox.attention()[0]?.kind, "help");
			} finally {
				await first.dispose();
			}
			// A second help request while no Maestro process runs.
			await fixture.op("report", {
				workerId,
				kind: "help",
				message: "and which test?",
			});
			await fixture.op("parentIdle");
			const second = await composeWorkerParent(fixture.started, dir);
			try {
				await second.outbox.start();
				// A restarted parent resumes observation without a new launch.
				second.composed.provider.resumeObservation();
				await until(async () => (await deliveries(fixture)).length >= 1);
				// Delivered prompts start a parent turn; the next waits for it to end.
				await fixture.op("parentIdle");
				await until(async () => (await deliveries(fixture)).length >= 2);
				await delay(200);
				const sent = await deliveries(fixture);
				assert.equal(sent.length, 2, "each help request delivered once");
				assert.match(sent[0]!.message, /which file\?/);
				assert.match(sent[1]!.message, /and which test\?/);
			} finally {
				await second.dispose();
			}
		}));

	it("help reported before the Observer's first snapshot is retained with that snapshot's state, then delivered once after a restart", () =>
		withFixture(async (fixture, dir) => {
			const first = await composeWorkerParent(fixture.started, dir);
			const release = gateFirstWatch(first.composed.client);
			let workerId: string;
			let reportId: string | undefined;
			try {
				await first.outbox.start();
				// The child reports before the Observer has its first snapshot.
				({ workerId } = await launched(first));
				await fixture.op("report", {
					workerId,
					kind: "help",
					message: "which file?",
				});
				await reported(fixture, workerId, "help");
				assert.equal(
					first.store.observerState("pi-worker/observer"),
					undefined,
				);
				release();
				await until(
					() => first.store.observerState("pi-worker/observer") !== undefined,
				);
				// SAFETY: the provider Observer's saved state (client ObserverState).
				const saved = first.store.observerState("pi-worker/observer") as {
					workers: Record<string, { reports: string[] }>;
				};
				reportId = saved.workers[workerId]?.reports[0];
				assert.ok(reportId, "the first snapshot counts the report as seen");
				// The record that saved it as seen also retained its outcome.
				assert.deepEqual(helpOutcomes(first.store.recovery()), [reportId]);
			} finally {
				release();
				await first.dispose();
			}
			await fixture.op("parentIdle");
			const second = await composeWorkerParent(fixture.started, dir);
			try {
				await second.outbox.start();
				second.composed.provider.resumeObservation();
				await until(async () => (await deliveries(fixture)).length >= 1);
				await until(() => second.store.recovery().final.length === 1);
				await delay(200);
				const sent = await deliveries(fixture);
				assert.equal(sent.length, 1, "the help request delivered once");
				assert.match(sent[0]!.message, /^\[maestro-outcome\/v1 help\]/);
				assert.match(sent[0]!.message, /which file\?/);
				assert.deepEqual(finalStates(second.store.recovery()), [
					["admitted", "receipt"],
				]);
				assert.deepEqual(helpOutcomes(second.store.recovery()), []);
			} finally {
				await second.dispose();
			}
		}));

	it("a restart with an owned child but no saved Observer state retains its help from the cold snapshot: delivered once", () =>
		withFixture(async (fixture, dir) => {
			const first = await composeWorkerParent(fixture.started, dir);
			// The first process never gets a snapshot, so it saves no baseline.
			gateFirstWatch(first.composed.client);
			let workerId: string;
			try {
				await first.outbox.start();
				({ workerId } = await launched(first));
				await fixture.op("report", {
					workerId,
					kind: "help",
					message: "which file?",
				});
				await reported(fixture, workerId, "help");
			} finally {
				await first.dispose();
			}
			await fixture.op("parentIdle");
			const second = await composeWorkerParent(fixture.started, dir);
			try {
				assert.equal(
					second.store.observerState("pi-worker/observer"),
					undefined,
				);
				await second.outbox.start();
				second.composed.provider.resumeObservation();
				await until(async () => (await deliveries(fixture)).length >= 1);
				await until(() => second.store.recovery().final.length === 1);
				await delay(200);
				const sent = await deliveries(fixture);
				assert.equal(sent.length, 1, "the help request delivered once");
				assert.match(sent[0]!.message, /which file\?/);
			} finally {
				await second.dispose();
			}
		}));
});

describe("P3-10 interrupted-run hand-off over real B2 (Maestro SIGKILLed, then restarted)", () => {
	/** A JSON object field, asserted to be one. */
	const object = (value: OutcomeJson | undefined): OutcomeJsonObject => {
		assert.ok(isRecord(value), "a JSON object");
		return value;
	};

	it("a check interrupted after its subject was recorded is handed off against that subject, once; never re-run", () =>
		withFixture(async (fixture, dir) => {
			const marks = mkdtempSync(join(tmpdir(), "maestro-handoff-marks-"));
			try {
				const mark = join(marks, "ran");
				const run = maestro(fixture, dir, "run", "during-check", {
					checks: true,
					accept: `: > '${mark}'`,
				});
				const { workerId } = await run.next("launched");
				const sha = await fixture.op<string>("commit", {
					workerId,
					file: "feature.txt",
					text: "feature\n",
				});
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: encodeResultClaim({ type: "done", commit: sha }),
				});
				await run.next("cut");
				assert.equal(await run.exited, "SIGKILL", run.stderr());
				const recover = maestro(fixture, dir, "recover", undefined, {
					checks: true,
				});
				const recovered = await recover.next("recovered");
				assert.equal(await recover.exited, 0, recover.stderr());
				assert.deepEqual(
					recovered.recovery.interrupted,
					[],
					"the run is closed",
				);
				assert.equal(recovered.handed?.length, 1);
				const handed = recovered.handed![0]!.outcome;
				assert.equal(handed.outcome, "interrupted");
				assert.equal(handed.textSource, "host");
				assert.equal(handed.reportId, "interrupted-run");
				const verdict = object(handed.verdict);
				assert.equal(verdict.verdict, "error");
				assert.equal(verdict.reason, "check interrupted");
				assert.match(String(verdict.checkHash), /^sha256:/);
				// The saved subject, never a fresh read: the commit the check began on.
				assert.equal(object(object(handed.subject).before).commit, sha);
				const facts = object(object(handed.facts).handoff);
				assert.ok(
					Array.isArray(facts.commands) &&
						facts.commands.some(
							(c) =>
								object(c).purpose === "stop" &&
								object(c).outcome === "observed",
						),
					"the bound check's stop evidence is kept",
				);
				assert.equal(object(facts.child).status, "stopped");
				assert.equal(object(object(facts.parent).state).fenced, false);
				assert.equal(existsSync(mark), false, "the check never re-ran");
				// A second restart commits nothing again.
				const again = maestro(fixture, dir, "recover", undefined, {
					checks: true,
				});
				const second = await again.next("recovered");
				assert.equal(await again.exited, 0, again.stderr());
				assert.deepEqual(second.handed, []);
				assert.equal(
					second.recovery.outcomes.filter((o) => o.outcome.taskId === "o1")
						.length,
					1,
				);
				assert.equal(await fixture.op<number>("acquisitions"), 1);
			} finally {
				rmSync(marks, { recursive: true, force: true });
			}
		}));

	it("a cancel interrupted before its stop was sent is handed off with its durable intent and the pending stop; nothing is re-sent", () =>
		withFixture(async (fixture, dir) => {
			const run = maestro(fixture, dir, "run", "before-stop", {
				checks: true,
				cancel: true,
			});
			const { workerId } = await run.next("launched");
			await run.next("cut");
			assert.equal(await run.exited, "SIGKILL", run.stderr());
			const recover = maestro(fixture, dir, "recover", undefined, {
				checks: true,
			});
			const recovered = await recover.next("recovered");
			assert.equal(await recover.exited, 0, recover.stderr());
			assert.equal(recovered.handed?.length, 1);
			const handed = recovered.handed![0]!.outcome;
			assert.equal(handed.outcome, "interrupted");
			assert.equal(handed.verdict, undefined, "no check began");
			const cancellation = object(handed.cancellation);
			assert.ok(isFiniteNumber(cancellation.requestedAt), "its durable intent");
			// The child was never stopped: a cancel intent is not termination.
			assert.equal(cancellation.termination, "unconfirmed");
			const facts = object(object(handed.facts).handoff);
			const stops = (
				Array.isArray(facts.commands) ? facts.commands : []
			).filter((c) => object(c).purpose === "stop");
			assert.deepEqual(
				stops.map((c) => object(c).outcome),
				["pending"],
				"the stop recorded before its transport, never sent again",
			);
			assert.equal(object(facts.child).status, "ready");
			assert.equal((await fixture.row(workerId)).status, "ready");
			assert.equal(await fixture.op<number>("acquisitions"), 1);
		}));
});
