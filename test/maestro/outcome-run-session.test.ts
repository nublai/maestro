import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import type {
	OutcomeDelivery,
	OutcomeRecovery,
	OutcomeStore,
} from "../../maestro/core/outcome-store.ts";
import type { Role, RunResult, Task } from "../../maestro/core/types.ts";
import {
	createRunSession,
	type DeliveryDecision,
	type FinalizeControl,
	type PreparedRun,
} from "../../maestro/engine.ts";
import { FileOutcomeStore } from "../../maestro/runtime/file-outcome-store.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { Crash, DurableFs } from "../helpers/durable-fs.ts";
import { clock, sequence } from "../helpers/outcome-store-scenario.ts";

const DIR = "/state/outcomes";
const role: Role = {
	name: "worker",
	version: "1",
	description: "writer",
	systemPrompt: "role prompt",
	allowedTools: ["read"],
};

function task(id = "logical"): Task {
	return {
		id,
		name: "writer",
		prompt: "do the work",
		role: "worker",
		cwd: "/source",
	};
}

function openStore(fs: DurableFs, prefix: string) {
	return FileOutcomeStore.open({
		dir: DIR,
		parent: "parent",
		fs,
		lock: fs.lock,
		newId: sequence(prefix),
		now: clock(),
	});
}

/** What a restarted owner would recover if the process died right now. */
async function recovered(fs: DurableFs): Promise<OutcomeRecovery> {
	const store = await openStore(fs.crashImage(), "recovered");
	return store.recovery();
}

interface FixtureOptions {
	store?: OutcomeStore;
	onSettled?: (result: RunResult) => Promise<void | DeliveryDecision>;
	finalize?: (result: RunResult, control: FinalizeControl) => Promise<void>;
	beforeSpawn?: () => Promise<void>;
}

async function fixture(options: FixtureOptions = {}) {
	const fs = new DurableFs();
	const store = options.store ?? (await openStore(fs, "k"));
	const adapter = new FakeHarnessAdapter();
	const provider = new FakeSurfaceProvider();
	const closes: string[] = [];
	const settled: RunResult[] = [];
	let finalized = 0;
	let surfaces = 0;
	const prepared: PreparedRun = {
		role,
		persistent: false,
		candidates: [{ model: "provider/first", thinking: "low" }],
		async spawnAttempt(spawn, _index, cancelled) {
			await options.beforeSpawn?.();
			const handle = await adapter.spawn({
				...spawn,
				acquisitionSignal: cancelled,
			});
			const surface = `surface-${++surfaces}`;
			return {
				handle,
				adapter,
				closeTemporarySurface: async () => {
					closes.push(surface);
				},
				async finalize(result, _task, control) {
					finalized++;
					await options.finalize?.(result, control);
					return result;
				},
			};
		},
	};
	const session = createRunSession({
		adapter,
		surfaceProvider: provider,
		roles: [role],
		cwd: "/parent",
		sessionIdPrefix: "parent",
		outcomeStore: store,
		operations: { prepare: async () => prepared },
		hooks: {
			async onSettled(result) {
				settled.push(result);
				return options.onSettled?.(result);
			},
		},
	});
	return {
		fs,
		store,
		adapter,
		session,
		closes,
		settled,
		finalized: () => finalized,
	};
}

async function run(f: Awaited<ReturnType<typeof fixture>>, t = task()) {
	const handle = await f.session.spawn(t);
	const result = f.session.supervise(handle, t);
	f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
	return { handle, result };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A store whose every call reaches `real`, except the overridden ones. */
function delegate(
	real: OutcomeStore,
	overrides: Partial<OutcomeStore>,
): OutcomeStore {
	return {
		parent: real.parent,
		owner: real.owner,
		recordAttempt: (attempt) => real.recordAttempt(attempt),
		recordCheck: (check) => real.recordCheck(check),
		commit: (draft) => real.commit(draft),
		commitBatch: (batch) => real.commitBatch(batch),
		dispatch: (id) => real.dispatch(id),
		settle: (id, settlement) => real.settle(id, settlement),
		closeRun: (taskId, reason, owner) => real.closeRun(taskId, reason, owner),
		get: (id) => real.get(id),
		observerState: (key) => real.observerState(key),
		recovery: () => real.recovery(),
		compact: () => real.compact(),
		close: () => real.close(),
		...overrides,
	};
}

describe("RunSession with an outcome store", () => {
	it("records the attempt before acquisition", async () => {
		let atAcquisition: OutcomeRecovery | undefined;
		const f = await fixture({
			beforeSpawn: async () => {
				atAcquisition = await recovered(f.fs);
			},
		});
		await (await run(f)).result;
		assert.deepEqual(
			atAcquisition!.interrupted.map((r) => [r.taskId, r.attempts.length]),
			[["logical", 1]],
		);
		assert.equal(
			atAcquisition!.interrupted[0]!.attempts[0]!.model,
			"provider/first",
		);
	});

	it("an attempt the store cannot record launches nothing", async () => {
		const f = await fixture();
		f.fs.fault = (op) => (op.op === "write" ? new Error("ENOSPC") : undefined);
		await assert.rejects(
			f.session.spawn(task()),
			/could not launch.*The outcome store could not record this run: Outcome journal write failed: ENOSPC/s,
		);
		assert.equal(f.adapter.spawned().length, 0);
	});

	it("commits the outcome before delivery and marks it dispatching durably before the send", async () => {
		let atSend: OutcomeRecovery | undefined;
		let liveAtSend: OutcomeDelivery | undefined;
		const f = await fixture({
			onSettled: async () => {
				atSend = await recovered(f.fs);
				liveAtSend = f.store.recovery().outcomes[0]?.delivery;
			},
		});
		const { result } = await run(f);
		assert.equal((await result).outcome, "completed");
		// Persist-before-send: a crash at the send recovers the outcome as uncertain.
		assert.equal(atSend!.outcomes.length, 1);
		const [stored] = atSend!.outcomes;
		assert.equal(stored!.delivery.state, "uncertain");
		assert.equal(stored!.outcome.taskId, "logical");
		assert.equal(stored!.outcome.kind, "result");
		assert.equal(stored!.outcome.attempt, 1);
		assert.equal(liveAtSend!.state, "dispatching");
		assert.deepEqual(
			f.store.recovery().final.map(({ state, evidence }) => [state, evidence]),
			[["admitted", "process-local"]],
		);
		assert.deepEqual(f.store.recovery().outcomes, []);
		assert.deepEqual(f.store.recovery().interrupted, []);
		assert.equal(f.closes.length, 1, "released after delivery as before");
	});

	it("a failed commit keeps the run owned, undelivered and its surface; the next supervise retries only the commit", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		f.fs.fault = (op) => (op.op === "write" ? new Error("ENOSPC") : undefined);
		const first = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await assert.rejects(
			first,
			/outcome was not delivered and the run stays owned/,
		);
		assert.equal(f.settled.length, 0);
		assert.equal(f.closes.length, 0);
		assert.equal(f.session.getHandle(t.id), handle, "not retired");
		assert.equal((await f.session.cancel(t.id)).status, "already-terminal");
		f.fs.fault = undefined;
		const second = await f.session.supervise(handle, t);
		assert.equal(second.outcome, "completed");
		assert.equal(f.finalized(), 1, "finalization and checks never rerun");
		assert.equal(f.settled.length, 1);
		assert.equal(f.session.getHandle(t.id), undefined);
		assert.equal(f.store.recovery().final[0]!.state, "admitted");
	});

	it("a failed dispatch mark sends nothing and keeps the outcome pending", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		let writes = 0;
		f.fs.fault = (op) =>
			op.op === "write" && ++writes === 2 ? new Error("EIO") : undefined;
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await assert.rejects(
			wait,
			/could not be marked for delivery, so it was not sent/,
		);
		assert.equal(f.settled.length, 0);
		assert.equal(f.closes.length, 0, "surfaces retained");
		assert.equal(f.store.recovery().outcomes[0]!.delivery.state, "pending");
	});

	it("a rejected send leaves the outcome uncertain, never pending or resent", async () => {
		const f = await fixture({
			onSettled: async () => {
				throw new Error("parent API gone");
			},
		});
		const { result } = await run(f);
		await assert.rejects(result, /parent API gone/);
		const [stored] = f.store.recovery().outcomes;
		assert.equal(stored!.delivery.state, "uncertain");
		assert.equal(stored!.delivery.reason, "parent API gone");
		assert.equal(
			f.closes.length,
			0,
			"a rejected send retains surfaces as before",
		);
		assert.equal(
			f.session.getHandle("logical"),
			undefined,
			"retired as before",
		);
	});

	it("host suppression withdraws the outcome", async () => {
		const f = await fixture({ onSettled: async () => "suppressed" });
		await (await run(f)).result;
		assert.equal(f.store.recovery().final[0]!.state, "suppressed");
	});

	it("a help request commits as help, not as the run's result", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		f.adapter.ping(handle.id, "which file?");
		await wait;
		const settled = f.store.recovery().final;
		assert.equal(settled.length, 1);
		const journal = f.fs.contents(`${DIR}/journal.jsonl`)!.toString("utf8");
		assert.match(journal, /"kind":"help"/);
	});

	it("a suppressed run commits nothing and closes its recorded attempt", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		f.session.suppress(t.id);
		assert.equal((await wait).outcome, "killed");
		assert.equal(f.settled.length, 0);
		await tick();
		const recovery = f.store.recovery();
		assert.deepEqual(recovery.outcomes, []);
		assert.deepEqual(recovery.final, []);
		assert.deepEqual(recovery.interrupted, []);
	});

	it("records a check's subject before the check runs", async () => {
		let beforeCheck: OutcomeRecovery | undefined;
		const f = await fixture({
			finalize: async (_result, control) => {
				assert.ok(control.recordCheck, "present with a store");
				await control.recordCheck({ checkHash: "sha256:c", headSha: "abc" });
				beforeCheck = await recovered(f.fs);
			},
		});
		await (await run(f)).result;
		assert.deepEqual(beforeCheck!.interrupted[0]!.checks[0]!.subject, {
			checkHash: "sha256:c",
			headSha: "abc",
		});
	});

	it("records a resumed attempt before acquisition and resumes nothing when it cannot", async () => {
		const f = await fixture();
		let atResume: OutcomeRecovery | undefined;
		const resumeAdapter = new FakeHarnessAdapter();
		const resumable = createRunSession({
			adapter: resumeAdapter,
			roles: [role],
			cwd: "/parent",
			outcomeStore: f.store,
			operations: {
				prepare: () => assert.fail("no spawn"),
				resume: async (options) => {
					atResume = await recovered(f.fs);
					return {
						handle: await resumeAdapter.resume(options),
						adapter: resumeAdapter,
					};
				},
			},
		});
		const t = task("resumed");
		const handle = await resumable.resume({
			task: t,
			name: "writer",
			sessionId: "s.jsonl",
		});
		assert.deepEqual(
			atResume!.interrupted.map((r) => [r.taskId, r.attempts.length]),
			[["resumed", 1]],
		);
		const wait = resumable.supervise(handle, t);
		resumeAdapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await wait;
		assert.equal(f.store.recovery().final.length, 1);
		f.fs.fault = (op) => (op.op === "write" ? new Error("ENOSPC") : undefined);
		await assert.rejects(
			resumable.resume({
				task: task("again"),
				name: "writer",
				sessionId: "s.jsonl",
			}),
			/outcome store could not record this run/,
		);
		assert.equal(resumeAdapter.spawned().length, 1, "nothing resumed");
	});

	it("a run suppressed while its outcome commits is withdrawn, not sent", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		const wait = f.session.supervise(handle, t);
		let fsyncs = 0;
		f.fs.hook = (op, phase) => {
			// The commit's fsync: the attempt record's was the first.
			if (op.op === "fsync" && phase === "after" && ++fsyncs === 1)
				f.session.suppress(t.id);
		};
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await wait;
		assert.equal(f.settled.length, 0);
		assert.deepEqual(
			f.store.recovery().final.map((entry) => entry.state),
			["suppressed"],
		);
	});

	it("a check-start the store cannot record stops the check, even when the store recovers at once", async () => {
		let checked = false;
		const f = await fixture({
			finalize: async (_result, control) => {
				let writes = 0;
				// Only the check-start write fails; the store stays usable after it.
				f.fs.fault = (op) =>
					op.op === "write" && ++writes === 1 ? new Error("ENOSPC") : undefined;
				await control.recordCheck!({ checkHash: "sha256:c" });
				checked = true;
			},
		});
		const { result } = await run(f);
		await assert.rejects(
			result,
			/could not record the check's subject, so the check did not run: .*ENOSPC/,
		);
		assert.equal(checked, false, "the check never ran");
		assert.equal(f.settled.length, 0, "nothing delivered");
		const recovery = await recovered(f.fs);
		assert.deepEqual(recovery.outcomes, []);
		assert.deepEqual(recovery.final, []);
		assert.deepEqual(
			recovery.interrupted.map((run) => [run.taskId, run.attempts.length]),
			[["logical", 1]],
			"the run stays visible as interrupted",
		);
	});

	it("a finalizer that fails after its check started keeps the interrupted check for recovery", async () => {
		const f = await fixture({
			finalize: async (_result, control) => {
				await control.recordCheck!({ checkHash: "sha256:c", headSha: "abc" });
				throw new Error("finalizer broke");
			},
		});
		const { result } = await run(f);
		await assert.rejects(result, /finalizer broke/);
		assert.equal(
			f.session.getHandle("logical"),
			undefined,
			"retired as before",
		);
		await tick();
		const recovery = await recovered(f.fs);
		assert.deepEqual(recovery.outcomes, []);
		assert.deepEqual(
			recovery.interrupted.map((run) => run.checks.map((c) => c.subject)),
			[[{ checkHash: "sha256:c", headSha: "abc" }]],
			"verification is incomplete, not closed",
		);
	});

	it("suppression after a failed commit still saves the finalized outcome, withdrawn", async () => {
		const f = await fixture();
		const t = task();
		const handle = await f.session.spawn(t);
		f.fs.fault = (op) => (op.op === "write" ? new Error("ENOSPC") : undefined);
		const first = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await assert.rejects(first, /run stays owned/);
		f.fs.fault = undefined;
		// Pi shutdown suppresses every owned run.
		f.session.suppress(t.id);
		await tick();
		assert.equal(f.settled.length, 0, "nothing delivered");
		assert.equal(f.session.getHandle(t.id), undefined);
		const recovery = await recovered(f.fs);
		assert.deepEqual(recovery.interrupted, []);
		assert.deepEqual(
			recovery.final.map((entry) => entry.state),
			["suppressed"],
		);
		const journal = f.fs.contents(`${DIR}/journal.jsonl`)!.toString("utf8");
		assert.match(
			journal,
			/"outcome":"completed"/,
			"the result itself is saved",
		);
		assert.match(journal, /run suppressed before delivery/);
	});

	it("suppression after a failed commit whose retry also fails keeps the run's recovery evidence", async () => {
		const fs = new DurableFs();
		const real = await openStore(fs, "k");
		// Commits keep failing; every other write (a close included) succeeds.
		const failing = delegate(real, {
			commit: async () => {
				throw new Error("ENOSPC");
			},
		});
		const f = await fixture({ store: failing });
		const t = task();
		const handle = await f.session.spawn(t);
		const first = f.session.supervise(handle, t);
		f.adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await assert.rejects(first, /run stays owned/);
		f.session.suppress(t.id);
		await tick();
		const recovery = await recovered(fs);
		assert.deepEqual(recovery.final, []);
		assert.deepEqual(
			recovery.interrupted.map((run) => [run.taskId, run.attempts.length]),
			[["logical", 1]],
			"the attempt is not closed",
		);
	});

	it("a finalizer that fails before any check still keeps its run for recovery", async () => {
		const f = await fixture({
			finalize: async () => {
				throw new Error("finalizer broke");
			},
		});
		const { result } = await run(f);
		await assert.rejects(result, /finalizer broke/);
		await tick();
		const recovery = await recovered(f.fs);
		assert.deepEqual(
			recovery.interrupted.map((run) => [run.taskId, run.attempts.length]),
			[["logical", 1]],
		);
	});

	it("a run suppressed while its finalized result waits to commit saves it withdrawn", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finalizing!: () => void;
		const started = new Promise<void>((resolve) => {
			finalizing = resolve;
		});
		const f = await fixture({
			finalize: async () => {
				finalizing();
				await gate;
			},
		});
		const { result } = await run(f);
		await started;
		f.session.suppress("logical");
		release();
		assert.equal((await result).outcome, "completed");
		assert.equal(f.settled.length, 0);
		await tick();
		const recovery = await recovered(f.fs);
		assert.deepEqual(recovery.interrupted, []);
		assert.deepEqual(
			recovery.final.map((entry) => entry.state),
			["suppressed"],
		);
	});

	it("a run suppressed while its dispatch mark is written is withdrawn, not sent", async () => {
		const fs = new DurableFs();
		const real = await openStore(fs, "k");
		let marked!: () => void;
		const marking = new Promise<void>((resolve) => {
			marked = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Every call reaches the real store; only dispatch waits after its mark.
		const gated = delegate(real, {
			async dispatch(id) {
				const delivery = await real.dispatch(id);
				marked();
				await gate;
				return delivery;
			},
		});
		const f = await fixture({ store: gated });
		const { result } = await run(f);
		await marking;
		f.session.suppress("logical");
		release();
		await result;
		assert.equal(f.settled.length, 0, "the send hook never ran");
		const [entry] = real.recovery().final;
		assert.equal(entry!.state, "suppressed");
		const reopened = await openStore(fs.crashImage(), "r");
		assert.deepEqual(
			reopened.recovery().final.map((e) => e.state),
			["suppressed"],
			"withdrawn durably",
		);
	});

	it("without a store there is no check recording and delivery is unchanged", async () => {
		const adapter = new FakeHarnessAdapter();
		let control: FinalizeControl | undefined;
		const settled: RunResult[] = [];
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			operations: {
				prepare: async () => ({
					role,
					persistent: false,
					candidates: [],
					spawnAttempt: async (spawn) => ({
						handle: await adapter.spawn(spawn),
						adapter,
						finalize: async (result, _task, value) => {
							control = value;
							return result;
						},
					}),
				}),
			},
			hooks: {
				onSettled: (result) => {
					settled.push(result);
				},
			},
		});
		const t = task();
		const handle = await session.spawn(t);
		const wait = session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		assert.equal((await wait).outcome, "completed");
		assert.equal(control!.recordCheck, undefined);
		assert.equal(settled.length, 1);
	});
});

describe("RunSession outcome store crash cuts", () => {
	type Recovered =
		| "none"
		| "interrupted"
		| "pending"
		| "uncertain"
		| "admitted";

	async function lifecycle(hook?: DurableFs["hook"]) {
		let sentWhileDurable: boolean | undefined;
		const f = await fixture({
			onSettled: async () => {
				const atSend = await recovered(f.fs);
				sentWhileDurable =
					atSend.outcomes.length === 1 &&
					atSend.outcomes[0]!.delivery.state === "uncertain";
			},
		});
		const base = f.fs.ops.length;
		f.fs.hook =
			hook && ((op, phase) => hook({ ...op, index: op.index - base }, phase));
		try {
			await (await run(f)).result;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
		await tick();
		return { f, base, sentWhileDurable };
	}

	function classify(recovery: OutcomeRecovery): Recovered {
		const outcomes = recovery.outcomes.length + recovery.final.length;
		assert.ok(outcomes <= 1, "never a second outcome");
		if (recovery.final[0]) {
			assert.equal(recovery.final[0].state, "admitted");
			return "admitted";
		}
		const stored = recovery.outcomes[0];
		if (stored) {
			assert.ok(["pending", "uncertain"].includes(stored.delivery.state));
			return stored.delivery.state === "pending" ? "pending" : "uncertain";
		}
		return recovery.interrupted.length ? "interrupted" : "none";
	}

	it("a crash at any store operation recovers one committed outcome, and a sent one is never pending", async () => {
		const total =
			(await lifecycle()).f.fs.ops.length - (await lifecycle()).base;
		// A write and an fsync each for the attempt, commit, dispatch and settle.
		assert.equal(total, 8);
		const seen = new Set<Recovered>();
		for (let index = 0; index < total; index++)
			for (const phase of ["before", "after"] as const) {
				const { f, sentWhileDurable } = await lifecycle((op, at) => {
					if (op.index === index && at === phase) throw new Crash(op.op);
				});
				const label = `${phase} #${index}`;
				const state = classify(
					(await openStore(f.fs.crashImage(), "r")).recovery(),
				);
				seen.add(state);
				// Persist-before-send: anything sent was durably dispatching first.
				if (f.settled.length) {
					assert.equal(sentWhileDurable, true, label);
					assert.ok(
						["uncertain", "admitted"].includes(state),
						`${label}: ${state}`,
					);
				}
				// Persist-before-retire: a retired, delivered run has a durable outcome.
				if (state === "none" || state === "interrupted")
					assert.equal(
						f.settled.length,
						0,
						`${label}: delivered without a record`,
					);
			}
		assert.deepEqual([...seen].sort(), [
			"admitted",
			"interrupted",
			"none",
			"pending",
			"uncertain",
		]);
	});

	it("reversion: a store that skips the dispatch mark or the commit is caught at the send", async () => {
		for (const revert of ["dispatch", "commit"] as const) {
			const fs = new DurableFs();
			const real = await openStore(fs, "k");
			const reverted: OutcomeStore = Object.create(real);
			if (revert === "dispatch")
				reverted.dispatch = async (id) => ({
					...real.recovery().outcomes.find((o) => o.outcome.deliveryId === id)!
						.delivery,
					state: "dispatching",
				});
			else
				reverted.commit = async (draft) => ({
					outcome: {
						...draft,
						deliveryId: "never-written",
						dedupeKey: "x",
						parent: "parent",
						owner: "o",
						textDigest: "",
						textTruncated: false,
						committedAt: 0,
					},
					delivery: { state: "pending", attempts: 0, at: 0 },
				});
			reverted.settle = async () => ({ state: "admitted", attempts: 1, at: 0 });
			let atSend: OutcomeRecovery | undefined;
			const f = await fixture({
				store: reverted,
				onSettled: async () => {
					atSend = await recovered(fs);
				},
			});
			await (await run(f)).result.catch(() => {});
			const state = atSend
				? (atSend.outcomes[0]?.delivery.state ?? "missing")
				: "never sent";
			// The assertion the real store passes ("uncertain") fails here.
			assert.notEqual(state, "uncertain", revert);
		}
	});
});
