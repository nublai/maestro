/**
 * P3-9 unit cases: the AdmissionOutbox over a FileOutcomeStore on the
 * simulated-durability filesystem, with a scripted parent admission. The
 * real-B2 cases are in test/worker/b2-admission.test.ts.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import {
	isOutcomeStoreError,
	type OutcomeDelivery,
	type OutcomeDraft,
	type OutcomeStore,
	type StoredOutcome,
} from "../../maestro/core/outcome-store.ts";
import type {
	AdmissionAttempt,
	ParentAdmission,
	ParentReadiness,
} from "../../maestro/core/parent-admission.ts";
import type { Role, RunResult, Task } from "../../maestro/core/types.ts";
import { AdmissionOutbox } from "../../maestro/runtime/admission-outbox.ts";
import type { FileOutcomeStore } from "../../maestro/runtime/file-outcome-store.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";
import { DurableFs } from "../helpers/durable-fs.ts";
import {
	SCENARIO_PARENT,
	draft,
	openScenarioStore,
} from "../helpers/outcome-store-scenario.ts";

const DIR = "/state/outcomes";

interface Sent {
	commandId: string;
	deliveryId: string;
	message: string;
	/** What a restarted owner would recover at the moment of sending. */
	durable?: OutcomeDelivery;
}

/** A scripted parent: readiness, the next send outcomes and receipt reads. */
class ScriptedParent implements ParentAdmission {
	parent = SCENARIO_PARENT;
	wait: Extract<ParentReadiness, { ready: false }> | undefined;
	readonly sends: Sent[] = [];
	readonly reads: string[] = [];
	/** Sends and receipt reads, in order. */
	readonly log: string[] = [];
	readonly outcomes: AdmissionAttempt[] = [];
	readonly receipts = new Map<string, AdmissionAttempt>();
	/** Captures the durable state at each send (the fsync-before-send check). */
	fs?: DurableFs;
	#serial = 0;

	envelope(draft: OutcomeDraft & { deliveryId: string }): string {
		return `[test ${draft.kind}] ${draft.deliveryId}\n${draft.text}`;
	}

	retryable(reason: string): boolean {
		return !reason.startsWith("permanent");
	}

	async prepare(stored: StoredOutcome): Promise<ParentReadiness> {
		if (this.wait) return this.wait;
		const commandId = `cmd-${++this.#serial}`;
		return {
			ready: true,
			prepared: {
				commandId,
				request: { operation: "test.prompt", request_hash: `h-${commandId}` },
				send: async () => {
					const sent: Sent = {
						commandId,
						deliveryId: stored.outcome.deliveryId,
						message: stored.outcome.envelope ?? stored.outcome.text,
					};
					if (this.fs) {
						const image = await openScenarioStore(
							DIR,
							this.fs.crashImage(),
							"image",
						);
						sent.durable = image.get(stored.outcome.deliveryId)?.delivery;
						await image.close();
					}
					this.sends.push(sent);
					this.log.push(`send ${stored.outcome.deliveryId}`);
					return (
						this.outcomes.shift() ?? {
							outcome: "admitted",
							receipt: { command_id: commandId, admission: "accepted" },
						}
					);
				},
			},
		};
	}

	async reconcile(delivery: OutcomeDelivery): Promise<AdmissionAttempt> {
		this.reads.push(delivery.commandId!);
		this.log.push(`read ${delivery.commandId}`);
		return (
			this.receipts.get(delivery.commandId!) ?? {
				outcome: "unknown",
				reason: "receipt_missing",
				final: true,
			}
		);
	}
}

async function setup(prefix = "a") {
	const fs = new DurableFs();
	const store = await openScenarioStore(DIR, fs, prefix);
	const parent = new ScriptedParent();
	parent.fs = fs;
	const outbox = new AdmissionOutbox({ store, admission: parent, pollMs: 5 });
	return { fs, store, parent, outbox };
}

async function reopen(fs: DurableFs, parent: ScriptedParent, prefix: string) {
	const store = await openScenarioStore(DIR, fs.crashImage(), prefix);
	parent.fs = undefined;
	return {
		store,
		outbox: new AdmissionOutbox({ store, admission: parent, pollMs: 5 }),
	};
}

function finalOf(store: OutcomeStore, deliveryId: string) {
	return store.recovery().final.find((f) => f.deliveryId === deliveryId);
}

async function commit(store: FileOutcomeStore, text = "done", taskId = "t") {
	return store.commit(draft(taskId, "result", text));
}

describe("AdmissionOutbox: receipt-backed parent admission", () => {
	it("records the attempt durably before sending, then the admitting receipt", async () => {
		const { store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		assert.equal(await outbox.submit(outcome.deliveryId), "admitted");
		assert.equal(parent.sends.length, 1);
		const [sent] = parent.sends;
		// A crash at the send recovers the attempt as uncertain, with its identity.
		assert.equal(sent!.durable?.state, "uncertain");
		assert.equal(sent!.durable?.commandId, sent!.commandId);
		assert.deepEqual(sent!.durable?.request, {
			operation: "test.prompt",
			request_hash: `h-${sent!.commandId}`,
		});
		assert.deepEqual(finalOf(store, outcome.deliveryId), {
			deliveryId: outcome.deliveryId,
			state: "admitted",
			evidence: "receipt",
			at: finalOf(store, outcome.deliveryId)!.at,
		});
		assert.deepEqual(outbox.attention(), []);
	});

	it("waits while the parent is busy without writing, then delivers once", async () => {
		const { fs, store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		parent.wait = { ready: false, wait: "busy", reason: "parent_busy" };
		const before = fs.contents(`${DIR}/journal.jsonl`)!.length;
		assert.equal(await outbox.submit(outcome.deliveryId), "pending");
		assert.equal(fs.contents(`${DIR}/journal.jsonl`)!.length, before);
		assert.deepEqual(
			outbox.attention().map((a) => [a.state, a.needs, a.reason]),
			[["pending", "busy", "parent_busy"]],
		);
		await outbox.start();
		await delay(30);
		assert.equal(parent.sends.length, 0);
		parent.wait = undefined;
		outbox.wake();
		await until(() => parent.sends.length === 1);
		await until(() => finalOf(store, outcome.deliveryId)?.state === "admitted");
		await delay(30);
		assert.equal(parent.sends.length, 1, "delivered once");
		await outbox.close();
	});

	it("a fenced or gone parent blocks the outcome durably; it is retried only after the cause clears", async () => {
		const { fs, store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		parent.wait = {
			ready: false,
			wait: "fenced",
			reason: "parent_fenced: uncertain command x",
		};
		assert.equal(await outbox.submit(outcome.deliveryId), "blocked");
		// A restart shows why it waits.
		const image = await openScenarioStore(DIR, fs.crashImage(), "img");
		assert.equal(image.get(outcome.deliveryId)?.delivery.state, "blocked");
		assert.match(
			image.get(outcome.deliveryId)?.delivery.reason ?? "",
			/fenced/,
		);
		await image.close();
		assert.equal(await outbox.submit(outcome.deliveryId), "blocked");
		assert.equal(parent.sends.length, 0);
		parent.wait = undefined;
		assert.equal(await outbox.submit(outcome.deliveryId), "admitted");
		assert.equal(parent.sends.length, 1);
	});

	it("a proven refusal retries under a new command ID; a permanent one waits for the owner", async () => {
		const { store, parent, outbox } = await setup();
		const first = await commit(store, "one", "t1");
		parent.outcomes.push({
			outcome: "refused",
			reason: "worker_busy",
			retry: true,
		});
		assert.equal(await outbox.submit(first.outcome.deliveryId), "blocked");
		assert.equal(await outbox.submit(first.outcome.deliveryId), "admitted");
		assert.equal(parent.sends.length, 2);
		assert.notEqual(parent.sends[0]!.commandId, parent.sends[1]!.commandId);
		const second = await commit(store, "two", "t2");
		parent.outcomes.push({
			outcome: "refused",
			reason: "permanent_refusal",
			retry: false,
		});
		assert.equal(await outbox.submit(second.outcome.deliveryId), "blocked");
		assert.equal(await outbox.submit(second.outcome.deliveryId), "blocked");
		assert.equal(parent.sends.length, 3, "never sent again");
		assert.deepEqual(
			outbox.attention().map((a) => [a.state, a.needs]),
			[["blocked", "owner"]],
		);
	});

	it("an unknown outcome is uncertain and never sent again; a receipt read may still prove it", async () => {
		const { store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		parent.outcomes.push({
			outcome: "unknown",
			reason: "receipt_not_settled",
			final: false,
		});
		assert.equal(await outbox.submit(outcome.deliveryId), "uncertain");
		const commandId = parent.sends[0]!.commandId;
		parent.receipts.set(commandId, {
			outcome: "unknown",
			reason: "receipt_not_settled",
			final: false,
		});
		assert.equal(await outbox.submit(outcome.deliveryId), "uncertain");
		parent.receipts.set(commandId, {
			outcome: "admitted",
			receipt: { command_id: commandId },
		});
		assert.equal(await outbox.submit(outcome.deliveryId), "admitted");
		assert.equal(parent.sends.length, 1);
		assert.deepEqual(parent.reads, [commandId, commandId]);
	});

	it("a final unknown is read once, surfaced for the owner, and abandoned only by the owner", async () => {
		const { store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		parent.outcomes.push({
			outcome: "unknown",
			reason: "outcome_unknown",
			final: true,
		});
		assert.equal(await outbox.submit(outcome.deliveryId), "uncertain");
		assert.equal(await outbox.submit(outcome.deliveryId), "uncertain");
		assert.deepEqual(parent.reads, [], "a final unknown is not re-read");
		assert.equal(await outbox.reconcile(outcome.deliveryId), "uncertain");
		assert.equal(parent.reads.length, 1, "the owner's explicit read");
		assert.deepEqual(
			outbox.attention().map((a) => [a.state, a.needs, a.reason]),
			[["uncertain", "owner", "receipt_missing"]],
		);
		await outbox.abandon(outcome.deliveryId, "the owner checked the parent");
		assert.equal(finalOf(store, outcome.deliveryId)?.state, "suppressed");
		assert.equal(parent.sends.length, 1);
	});

	it("serializes concurrent submissions: one send for one outcome", async () => {
		const { store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		const states = await Promise.all([
			outbox.submit(outcome.deliveryId),
			outbox.submit(outcome.deliveryId),
			outbox.submit(outcome.deliveryId),
		]);
		assert.deepEqual(states, ["admitted", "admitted", "admitted"]);
		assert.equal(parent.sends.length, 1);
	});

	it("refuses an admission to another parent than its store's", async () => {
		const { store, parent } = await setup();
		parent.parent = "another-parent";
		assert.throws(
			() => new AdmissionOutbox({ store, admission: parent }),
			/another parent.*adopt the store explicitly/,
		);
	});

	it("delivers oldest first", async () => {
		const { store, parent, outbox } = await setup();
		const first = await commit(store, "one", "t1");
		const second = await commit(store, "two", "t2");
		await outbox.start();
		await until(() => parent.sends.length === 2);
		assert.deepEqual(
			parent.sends.map((s) => s.deliveryId),
			[first.outcome.deliveryId, second.outcome.deliveryId],
		);
		await outbox.close();
	});
});

describe("AdmissionOutbox: recovery after a restart", () => {
	it("a dispatch cut before its reply is read back by receipt: admitted, never resent", async () => {
		const { fs, store, parent } = await setup();
		const { outcome } = await commit(store);
		const prepared = await parent.prepare(store.get(outcome.deliveryId)!);
		assert.ok(prepared.ready);
		await store.dispatch(outcome.deliveryId, {
			commandId: prepared.prepared.commandId,
			request: prepared.prepared.request,
		});
		// The worker admitted it; the process died before the local ack.
		parent.receipts.set(prepared.prepared.commandId, {
			outcome: "admitted",
			receipt: { command_id: prepared.prepared.commandId },
		});
		const restarted = await reopen(fs, parent, "b");
		assert.equal(
			restarted.store.get(outcome.deliveryId)?.delivery.state,
			"uncertain",
		);
		await restarted.outbox.start();
		assert.equal(
			finalOf(restarted.store, outcome.deliveryId)?.state,
			"admitted",
		);
		assert.equal(parent.sends.length, 0, "never resent");
		await restarted.outbox.close();
	});

	it("a dispatch cut before any transport stays uncertain (absence is not proof) and is surfaced", async () => {
		const { fs, store, parent } = await setup();
		const { outcome } = await commit(store);
		await store.dispatch(outcome.deliveryId, {
			commandId: "cut",
			request: { operation: "test.prompt" },
		});
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		await delay(30);
		assert.equal(parent.sends.length, 0);
		assert.deepEqual(parent.reads, ["cut"]);
		assert.deepEqual(
			restarted.outbox.attention().map((a) => [a.state, a.needs, a.reason]),
			[["uncertain", "owner", "receipt_missing"]],
		);
		await restarted.outbox.close();
	});

	it("a refused receipt proves no effect: the outcome is blocked, then sent under a new command", async () => {
		const { fs, store, parent } = await setup();
		const { outcome } = await commit(store);
		await store.dispatch(outcome.deliveryId, {
			commandId: "refused",
			request: { operation: "test.prompt" },
		});
		parent.receipts.set("refused", {
			outcome: "refused",
			reason: "worker_busy",
			retry: true,
			receipt: { command_id: "refused", state: "rejected" },
		});
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		await until(
			() => finalOf(restarted.store, outcome.deliveryId)?.state === "admitted",
		);
		assert.equal(parent.sends.length, 1);
		assert.notEqual(parent.sends[0]!.commandId, "refused");
		await restarted.outbox.close();
	});

	it("reads every uncertain attempt back before sending anything new", async () => {
		const { fs, store, parent } = await setup();
		const older = await commit(store, "older", "t1");
		const newer = await commit(store, "newer", "t2");
		await store.dispatch(newer.outcome.deliveryId, {
			commandId: "cut",
			request: { operation: "test.prompt" },
		});
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		assert.deepEqual(parent.log, [
			"read cut",
			`send ${older.outcome.deliveryId}`,
		]);
		await restarted.outbox.close();
	});

	it("a refusal a receipt does not prove leaves the delivery uncertain", async () => {
		const { fs, store, parent } = await setup();
		const { outcome } = await commit(store);
		await store.dispatch(outcome.deliveryId, {
			commandId: "unproven",
			request: { operation: "test.prompt" },
		});
		parent.receipts.set("unproven", {
			outcome: "refused",
			reason: "worker_busy",
			retry: true,
		});
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		await delay(30);
		assert.equal(
			restarted.store.get(outcome.deliveryId)?.delivery.state,
			"uncertain",
		);
		assert.equal(parent.sends.length, 0);
		await restarted.outbox.close();
	});

	it("an admitted outcome is final across a restart: nothing is sent", async () => {
		const { fs, store, parent, outbox } = await setup();
		const { outcome } = await commit(store);
		await outbox.submit(outcome.deliveryId);
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		await delay(20);
		assert.equal(parent.sends.length, 1);
		assert.equal(
			finalOf(restarted.store, outcome.deliveryId)?.state,
			"admitted",
		);
		await restarted.outbox.close();
	});

	it("a pending outcome committed before a crash is delivered once after it", async () => {
		const { fs, store, parent } = await setup();
		const { outcome } = await commit(store);
		const restarted = await reopen(fs, parent, "b");
		await restarted.outbox.start();
		assert.equal(
			finalOf(restarted.store, outcome.deliveryId)?.state,
			"admitted",
		);
		assert.equal(parent.sends.length, 1);
		await restarted.outbox.close();
	});
});

describe("OutcomeStore: receipt-backed transitions", () => {
	it("an uncertain delivery becomes blocked only with its refused receipt", async () => {
		const { store } = await setup();
		const { outcome } = await commit(store);
		await store.dispatch(outcome.deliveryId, { commandId: "c1" });
		await store.settle(outcome.deliveryId, { state: "uncertain" });
		await assert.rejects(
			store.settle(outcome.deliveryId, { state: "blocked", reason: "x" }),
			(error: Error) => isOutcomeStoreError(error, "invalid"),
		);
		await assert.rejects(store.dispatch(outcome.deliveryId), (error: Error) =>
			isOutcomeStoreError(error, "transition"),
		);
		await store.settle(outcome.deliveryId, {
			state: "blocked",
			reason: "worker_busy",
			receipt: { command_id: "c1", state: "rejected" },
		});
		// A new attempt never reuses the earlier command ID.
		await assert.rejects(
			store.dispatch(outcome.deliveryId, { commandId: "c1" }),
			(error: Error) => isOutcomeStoreError(error, "invalid"),
		);
		const next = await store.dispatch(outcome.deliveryId, { commandId: "c2" });
		assert.equal(next.attempts, 2);
	});

	it("keeps the request with its settlement and records the receipt", async () => {
		const { store } = await setup();
		const { outcome } = await commit(store);
		await store.dispatch(outcome.deliveryId, {
			commandId: "c1",
			request: { operation: "test.prompt", request_hash: "h" },
		});
		const settled = await store.settle(outcome.deliveryId, {
			state: "uncertain",
			reason: "outcome_unknown",
			receipt: { command_id: "c1", state: "outcome_unknown" },
		});
		assert.deepEqual(settled.request, {
			operation: "test.prompt",
			request_hash: "h",
		});
		assert.deepEqual(settled.receipt, {
			command_id: "c1",
			state: "outcome_unknown",
		});
	});
});

describe("RunSession with a parent admission", () => {
	const role: Role = {
		name: "worker",
		version: "1",
		description: "writer",
		systemPrompt: "role prompt",
		allowedTools: ["read"],
	};
	const task = (): Task => ({
		id: "logical",
		name: "writer",
		prompt: "do the work",
		role: "worker",
		cwd: "/source",
	});

	it("commits the envelope with its delivery ID and hands delivery to the outbox, not onSettled", async () => {
		const { store, parent, outbox } = await setup();
		const adapter = new FakeHarnessAdapter();
		const settled: RunResult[] = [];
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			outcomeStore: store,
			parentAdmission: outbox,
			hooks: {
				describeOutcome: () => ({ text: "the change is ready" }),
				async onSettled(result) {
					// The outbox already took it: the host only presents.
					assert.equal(parent.sends.length, 1);
					settled.push(result);
				},
			},
		});
		const t = task();
		const handle = await session.spawn(t);
		const waiting = session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await waiting;
		assert.equal(settled.length, 1);
		const [sent] = parent.sends;
		const final = finalOf(store, sent!.deliveryId);
		assert.equal(final?.state, "admitted");
		assert.equal(final?.evidence, "receipt");
		assert.equal(
			sent!.message,
			`[test result] ${sent!.deliveryId}\nthe change is ready`,
		);
	});

	it("a parent that cannot take it keeps the outcome in the outbox; the run still retires", async () => {
		const { store, parent, outbox } = await setup();
		parent.wait = { ready: false, wait: "busy", reason: "parent_busy" };
		const adapter = new FakeHarnessAdapter();
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/parent",
			outcomeStore: store,
			parentAdmission: outbox,
		});
		const t = task();
		const handle = await session.spawn(t);
		const waiting = session.supervise(handle, t);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		await waiting;
		assert.equal(session.getHandle("logical"), undefined);
		assert.deepEqual(
			outbox.attention().map((a) => [a.state, a.needs]),
			[["pending", "busy"]],
		);
		assert.equal(store.recovery().interrupted.length, 0);
	});

	it("needs an outcome store", () => {
		assert.throws(
			() =>
				createRunSession({
					adapter: new FakeHarnessAdapter(),
					roles: [role],
					cwd: "/parent",
					parentAdmission: {
						envelope: () => "",
						submit: async () => "pending",
					},
				}),
			/needs an outcome store/,
		);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) assert.fail("condition not reached");
		await delay(5);
	}
}
