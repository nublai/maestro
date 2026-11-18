import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net, { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	OUTCOME_ENVELOPE_LIMIT,
	OUTCOME_TEXT_LIMIT,
	isOutcomeStoreError,
	outcomeDigest,
} from "../../maestro/core/outcome-store.ts";
import {
	FileOutcomeStore,
	OUTCOME_LOCK_FILE,
	openFileOutcomeStore,
	terminalOutcomeStoreDir,
} from "../../maestro/runtime/file-outcome-store.ts";
import { networkFilesystemName } from "../../maestro/runtime/outcome-store-lock.ts";
import { runParentAcceptCheck } from "../../maestro/runtime/accept-recheck.ts";
import type { JsonObject } from "../../maestro/core/config/type-guards.ts";
import { Crash, DurableFs } from "../helpers/durable-fs.ts";
import {
	SCENARIO,
	SCENARIO_PARENT,
	draft,
	openScenarioStore,
	runScenario,
	view,
	type ScenarioView,
} from "../helpers/outcome-store-scenario.ts";

const DIR = "/state/outcomes";
function open(
	fs: DurableFs,
	prefix = "a",
	extra: Parameters<typeof openScenarioStore>[3] = {},
) {
	return openScenarioStore(DIR, fs, prefix, extra);
}

function journalLines(fs: DurableFs): string[] {
	return (fs.contents(`${DIR}/journal.jsonl`) ?? Buffer.alloc(0))
		.toString("utf8")
		.split("\n")
		.filter(Boolean);
}

async function rejectsWith(
	promise: Promise<unknown>,
	code: Parameters<typeof isOutcomeStoreError>[1],
	pattern?: RegExp,
) {
	await assert.rejects(promise, (error: Error) => {
		assert.ok(isOutcomeStoreError(error, code), `${code}: ${error.message}`);
		if (pattern) assert.match(error.message, pattern);
		return true;
	});
}

describe("FileOutcomeStore journal", () => {
	it("commits one record per outcome and walks pending -> dispatching -> admitted", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		const before = journalLines(fs).length;
		const stored = await store.commit(
			draft("t", "result", "done", { facts: { model: "m" } }),
		);
		assert.equal(journalLines(fs).length, before + 1);
		assert.equal(stored.delivery.state, "pending");
		assert.equal(stored.outcome.parent, SCENARIO_PARENT);
		assert.equal(stored.outcome.textDigest, outcomeDigest("done"));
		const dispatch = await store.dispatch(stored.outcome.deliveryId);
		assert.equal(dispatch.state, "dispatching");
		assert.equal(dispatch.attempts, 1);
		assert.ok(dispatch.commandId);
		await store.settle(stored.outcome.deliveryId, {
			state: "admitted",
			evidence: "process-local",
		});
		assert.equal(store.get(stored.outcome.deliveryId), undefined);
		assert.deepEqual(store.recovery().final, [
			{
				deliveryId: stored.outcome.deliveryId,
				state: "admitted",
				evidence: "process-local",
				at: store.recovery().final[0]!.at,
			},
		]);
	});

	it("refuses invalid transitions, admissions without evidence and unknown deliveries", async () => {
		const store = await open(new DurableFs());
		const { outcome } = await store.commit(draft("t", "result", "x"));
		await rejectsWith(
			store.settle(outcome.deliveryId, { state: "admitted" }),
			"transition",
		);
		await store.dispatch(outcome.deliveryId);
		await rejectsWith(store.dispatch(outcome.deliveryId), "transition");
		await rejectsWith(
			store.settle(outcome.deliveryId, { state: "admitted" }),
			"invalid",
		);
		await store.settle(outcome.deliveryId, { state: "uncertain" });
		// Uncertain delivery is never dispatched again.
		await rejectsWith(store.dispatch(outcome.deliveryId), "transition");
		await store.settle(outcome.deliveryId, { state: "suppressed" });
		await rejectsWith(
			store.dispatch(outcome.deliveryId),
			"transition",
			/already suppressed/,
		);
		await rejectsWith(store.dispatch("nope"), "unknown");
	});

	it("a blocked delivery retries with a new command ID", async () => {
		const store = await open(new DurableFs());
		const { outcome } = await store.commit(draft("t", "result", "x"));
		const first = await store.dispatch(outcome.deliveryId);
		await store.settle(outcome.deliveryId, {
			state: "blocked",
			reason: "refused: no effect",
		});
		const second = await store.dispatch(outcome.deliveryId);
		assert.equal(second.attempts, 2);
		assert.notEqual(second.commandId, first.commandId);
	});

	it("deduplicates by parent, task, generation, attempt, kind and report", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		const first = await store.commit(draft("t", "result", "same"));
		const lines = journalLines(fs).length;
		const again = await store.commit(draft("t", "result", "same"));
		assert.equal(again.outcome.deliveryId, first.outcome.deliveryId);
		assert.equal(journalLines(fs).length, lines, "no second record");
		await rejectsWith(
			store.commit(draft("t", "result", "different")),
			"conflict",
		);
		await rejectsWith(
			store.commit(
				draft("t", "result", "same", { deliveryId: "another-identity" }),
			),
			"conflict",
		);
		// A help request never takes the terminal-result slot.
		const help = await store.commit(draft("t", "help", "same"));
		assert.notEqual(help.outcome.deliveryId, first.outcome.deliveryId);
		const otherGeneration = await store.commit(
			draft("t", "result", "same", { generation: "g-2" }),
		);
		assert.notEqual(
			otherGeneration.outcome.deliveryId,
			first.outcome.deliveryId,
		);
		await rejectsWith(
			store.commit(
				draft("u", "result", "x", { deliveryId: first.outcome.deliveryId }),
			),
			"conflict",
		);
		await store.dispatch(first.outcome.deliveryId);
		await store.settle(first.outcome.deliveryId, {
			state: "admitted",
			evidence: "process-local",
		});
		await rejectsWith(
			store.commit(draft("t", "result", "same")),
			"conflict",
			/already delivered/,
		);
	});

	it("deduplicates only identical content: a different verdict, subject or envelope conflicts", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		const accepted = draft("t", "result", "same summary", {
			// A generation keeps the dedupe key across owners (a reopen).
			generation: "g-1",
			verdict: { verdict: "accepted", checkHash: "sha256:c" },
			subject: { headSha: "aaa", branch: "agents/t" },
			envelope: '{"report":"A"}',
			cancellation: { requestedAt: 5, error: undefined },
		});
		const first = await store.commit(accepted);
		for (const [field, change] of [
			["verdict", { verdict: { verdict: "rejected", checkHash: "sha256:c" } }],
			["subject", { subject: { headSha: "bbb", branch: "agents/t" } }],
			["envelope, envelopeDigest", { envelope: '{"report":"B"}' }],
			["cancellation", { cancellation: { requestedAt: 6 } }],
			["facts", { facts: { model: "m" } }],
			["exitCode", { exitCode: 3 }],
			["runId", { runId: "another-run" }],
		] as const)
			await rejectsWith(
				store.commit({ ...accepted, ...change }),
				"conflict",
				new RegExp(`\\(${first.outcome.deliveryId}; ${field} differ\\)`),
			);
		const lines = journalLines(fs).length;
		// The same content, keys in another order, is the same outcome.
		const again = await store.commit({
			...accepted,
			verdict: { checkHash: "sha256:c", verdict: "accepted" },
			subject: { branch: "agents/t", headSha: "aaa" },
		});
		assert.equal(again.outcome.deliveryId, first.outcome.deliveryId);
		assert.equal(journalLines(fs).length, lines, "no second record");
		// Read back from disk, the original still deduplicates identical content.
		await store.close();
		const reopened = await open(fs, "b");
		const replayed = await reopened.commit(accepted);
		assert.equal(replayed.outcome.deliveryId, first.outcome.deliveryId);
		await reopened.close();
	});

	it("bounds outcome text and keeps the digest of the full text", async () => {
		const store = await open(new DurableFs());
		const text = "x".repeat(OUTCOME_TEXT_LIMIT + 10);
		const { outcome } = await store.commit(draft("t", "result", text));
		assert.equal(outcome.text.length, OUTCOME_TEXT_LIMIT);
		assert.equal(outcome.textTruncated, true);
		assert.equal(outcome.textDigest, outcomeDigest(text));
	});

	it("keeps an exact envelope with its digest, within its bound", async () => {
		const store = await open(new DurableFs());
		const envelope = '{"report":"exact"}';
		const { outcome } = await store.commit(
			draft("t", "result", "x", { envelope }),
		);
		assert.equal(outcome.envelope, envelope);
		assert.equal(outcome.envelopeDigest, outcomeDigest(envelope));
		await rejectsWith(
			store.commit(
				draft("u", "result", "x", {
					envelope: "e".repeat(OUTCOME_ENVELOPE_LIMIT + 1),
				}),
			),
			"limit",
		);
	});

	it("validates before any write and refuses an oversized record", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		const lines = journalLines(fs).length;
		const cyclic: JsonObject = {};
		cyclic.self = cyclic;
		for (const bad of [
			draft("t", "result", "x", { attempt: 0 }),
			draft("", "result", "x"),
			draft("t", "result", "x", { facts: cyclic }),
			draft("t", "result", "x", {
				// SAFETY: deliberately invalid input for the public boundary check.
				facts: { when: new Date(0) } as never,
			}),
			draft("t", "result", "x", { facts: { n: Number.NaN } }),
		])
			await rejectsWith(store.commit(bad), "invalid");
		await rejectsWith(
			store.commit(
				draft("t", "result", "x", { facts: { big: "y".repeat(2 << 20) } }),
			),
			"limit",
		);
		assert.equal(journalLines(fs).length, lines);
		await store.commit(draft("t", "result", "fine"));
	});

	it("saves an observer state atomically with its outcomes", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		await rejectsWith(
			store.commitBatch({
				outcomes: [
					draft("ok", "result", "x"),
					draft("bad", "result", "x", { attempt: -1 }),
				],
				observer: { key: "observer", state: { cursor: "c-9" } },
			}),
			"invalid",
		);
		assert.equal(store.observerState("observer"), undefined);
		assert.equal(store.recovery().outcomes.length, 0);
		const lines = journalLines(fs).length;
		await store.commitBatch({
			outcomes: [draft("ok", "result", "x"), draft("two", "help", "y")],
			observer: { key: "observer", state: { cursor: "c-9" } },
		});
		assert.equal(journalLines(fs).length, lines + 1, "one record");
		const reopened = await open(fs.crashImage(), "b");
		assert.deepEqual(reopened.observerState("observer"), { cursor: "c-9" });
		assert.equal(reopened.recovery().outcomes.length, 2);
	});

	it("recovers dispatching as uncertain, keeps interrupted runs and never resends", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		await store.recordAttempt({ taskId: "lost", attempt: 1 });
		await store.recordCheck({
			taskId: "lost",
			attempt: 1,
			subject: { headSha: "abc" },
		});
		const { outcome } = await store.commit(draft("sent", "result", "x"));
		await store.dispatch(outcome.deliveryId);
		const reopened = await open(fs.crashImage(), "b");
		const recovery = reopened.recovery();
		assert.equal(recovery.outcomes[0]!.delivery.state, "uncertain");
		assert.match(
			recovery.outcomes[0]!.delivery.reason!,
			/dispatch interrupted/,
		);
		await rejectsWith(reopened.dispatch(outcome.deliveryId), "transition");
		assert.deepEqual(
			recovery.interrupted.map((run) => [
				run.taskId,
				run.attempts.length,
				run.checks.length,
			]),
			[["lost", 1, 1]],
		);
		const previous = recovery.interrupted[0]!.owner;
		assert.notEqual(previous, reopened.owner);
		await reopened.closeRun("lost", "owner reviewed", previous);
		assert.deepEqual(reopened.recovery().interrupted, []);
	});

	it("belongs to one parent unless another explicitly adopts it", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		await store.commit(draft("t", "result", "x"));
		await store.close();
		await rejectsWith(
			openScenarioStore(DIR, fs, "b", { parent: "someone-else" }),
			"parent",
		);
		// The refused open released its lock.
		const adopted = await openScenarioStore(DIR, fs, "c", {
			parent: "someone-else",
			adopt: true,
		});
		assert.equal(adopted.recovery().parent, "someone-else");
		assert.equal(adopted.recovery().outcomes.length, 1);
	});

	it("cuts a torn tail but refuses damage before it, sequence gaps and other versions", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		await store.commit(draft("t", "result", "x"));
		await store.close();
		const path = `${DIR}/journal.jsonl`;
		const good = fs.contents(path)!.toString("utf8");
		const rewrite = (text: string) => {
			const fd = fs.openSync(path, "w");
			fs.writeSync(fd, Buffer.from(text), 0, Buffer.byteLength(text));
			fs.closeSync(fd);
		};
		rewrite(`${good}{"v":1,"seq":9,"sum":"ab`);
		const torn = await open(fs, "b");
		assert.equal(torn.recovery().outcomes.length, 1);
		await torn.commit(draft("u", "result", "after the cut"));
		await torn.close();
		const both = await open(fs, "c");
		assert.equal(both.recovery().outcomes.length, 2);
		await both.close();

		const lines = good.split("\n").filter(Boolean);
		const damaged = [...lines];
		damaged[0] = damaged[0]!.replace(SCENARIO_PARENT, "parent-sessioN");
		rewrite(`${damaged.join("\n")}\n`);
		await rejectsWith(open(fs, "d"), "corrupt", /damaged/);

		// A changed seq no longer matches its checksum: the final line is torn.
		rewrite(
			`${[lines[0], lines[1]!.replace('"seq":2', '"seq":3')].join("\n")}\n`,
		);
		const cut = await open(fs, "e");
		assert.equal(cut.recovery().outcomes.length, 0);
		await cut.close();

		// A checksummed record whose sequence skips one is refused, never reordered.
		const rec = lines[1]!.slice(lines[1]!.indexOf('"rec":') + 6, -1);
		const sum = createHash("sha256").update(`3:${rec}`).digest("hex");
		rewrite(`${lines[0]}\n{"v":1,"seq":3,"sum":"${sum}","rec":${rec}}\n`);
		await rejectsWith(open(fs, "g"), "corrupt", /sequence jumps from 1 to 3/);

		rewrite(`${lines[0]!.replace('{"v":1,', '{"v":2,')}\n${lines[1]}\n`);
		await rejectsWith(open(fs, "f"), "version");
	});

	it("rolls back a failed write and stops after a failed fsync", async () => {
		const fs = new DurableFs();
		const store = await open(fs);
		fs.fault = (op) =>
			op.op === "write"
				? Object.assign(new Error("no space"), { code: "ENOSPC" })
				: undefined;
		await rejectsWith(
			store.commit(draft("t", "result", "x")),
			"io",
			/no space/,
		);
		fs.fault = undefined;
		const { outcome } = await store.commit(draft("t", "result", "x"));
		fs.fault = (op) => (op.op === "fsync" ? new Error("EIO") : undefined);
		await rejectsWith(store.dispatch(outcome.deliveryId), "io", /fsync/);
		fs.fault = undefined;
		await rejectsWith(store.dispatch(outcome.deliveryId), "broken");
		const reopened = await open(fs.crashImage(), "b");
		assert.equal(reopened.recovery().outcomes[0]!.delivery.state, "pending");
	});

	it("compacts into an atomic snapshot and replays only what follows it", async () => {
		const fs = new DurableFs();
		const store = await open(fs, "a", { compactAfter: 4, retainFinal: 2 });
		for (const task of ["1", "2", "3", "4", "5"]) {
			const { outcome } = await store.commit(draft(task, "result", task));
			await store.dispatch(outcome.deliveryId);
			await store.settle(outcome.deliveryId, {
				state: "admitted",
				evidence: "process-local",
			});
		}
		await store.commit(draft("6", "result", "pending"));
		assert.ok(fs.contents(`${DIR}/snapshot.json`), "auto-compacted");
		assert.ok(journalLines(fs).length < 4);
		const before = view(store);
		assert.equal(before.final.length, 2, "final identities are bounded");
		const reopened = await open(fs.crashImage(), "b");
		assert.deepEqual(view(reopened), before);
		assert.deepEqual(
			fs.list(DIR).filter((path) => path.endsWith(".tmp")),
			[],
		);
	});

	it("refuses a second writer and stops a writer whose lock was taken, compaction included", async () => {
		const fs = new DurableFs();
		const store = await open(fs, "a");
		await rejectsWith(open(fs, "b"), "locked", /one writer per store/);
		await store.commit(draft("t", "result", "x"));
		fs.lock.steal(DIR);
		const lines = journalLines(fs).length;
		await rejectsWith(store.compact(), "locked");
		await rejectsWith(store.commit(draft("u", "result", "x")), "broken");
		await rejectsWith(store.compact(), "broken");
		assert.equal(journalLines(fs).length, lines, "nothing written");
		assert.equal(fs.contents(`${DIR}/snapshot.json`), undefined);
		await store.close();
		const fresh = await open(new DurableFs(), "d");
		await fresh.close();
		await rejectsWith(fresh.commit(draft("t", "result", "x")), "closed");
	});
});

describe("FileOutcomeStore crash cuts", () => {
	/** A view as a restarted owner sees it: dispatching is already uncertain. */
	function recovered(views: ScenarioView[], index: number) {
		return views[Math.min(Math.max(index, 0), views.length - 1)];
	}

	interface Matrix {
		cuts: number;
		ops: number;
		/** Cuts whose recovered view is neither the acknowledged prefix nor the in-flight step. */
		lost: string[];
		outcomes: {
			interrupted: number;
			inFlightDurable: number;
			inFlightLost: number;
		};
	}

	/**
	 * Crashes the shared workload before and after every filesystem operation
	 * and reopens the crash image (only fsynced bytes and names). This is the
	 * fsync proof: `fsyncIsNoop` reverts the fsyncs it names, and the cuts must
	 * then lose acknowledged records.
	 */
	async function cutMatrix(
		fsyncIsNoop: DurableFs["fsyncIsNoop"] = false,
	): Promise<Matrix> {
		const views = await runScenario(await open(new DurableFs()));
		const total = new DurableFs();
		await runScenario(await open(total));
		const matrix: Matrix = {
			cuts: 0,
			ops: total.ops.length,
			lost: [],
			outcomes: { interrupted: 0, inFlightDurable: 0, inFlightLost: 0 },
		};
		for (let index = 0; index < total.ops.length; index++)
			for (const phase of ["before", "after"] as const) {
				const fs = new DurableFs();
				fs.fsyncIsNoop = fsyncIsNoop;
				fs.hook = (op, at) => {
					if (op.index === index && at === phase) throw new Crash(op.op);
				};
				let acked = -1;
				try {
					const store = await open(fs);
					acked = 0;
					await runScenario(store, (step) => {
						acked = step;
					});
				} catch (error) {
					if (!(error instanceof Crash) && !isOutcomeStoreError(error))
						throw error;
				}
				matrix.cuts++;
				const label = `${phase} ${total.ops[index]!.op} #${index} (acked ${acked})`;
				const image = fs.crashImage();
				const reopened = await open(image, "r").catch((error: Error) =>
					assert.fail(`${label}: reopen failed: ${error.message}`),
				);
				const actual = JSON.stringify(view(reopened));
				const options = [acked, acked + 1].map((step) =>
					JSON.stringify(recovered(views, step)),
				);
				if (acked < SCENARIO.length) {
					matrix.outcomes.interrupted++;
					if (options[0] !== options[1] && actual === options[1])
						matrix.outcomes.inFlightDurable++;
					else if (options[0] !== options[1]) matrix.outcomes.inFlightLost++;
				}
				if (!options.includes(actual)) matrix.lost.push(`${label}: ${actual}`);
				// The recovered journal accepts new writes and replays them.
				await reopened.commit(draft("after", "result", "post-crash"));
				await reopened.close();
				const again = await open(image, "s");
				assert.equal(
					again.recovery().outcomes.filter((o) => o.outcome.taskId === "after")
						.length,
					1,
					label,
				);
				await again.close();
			}
		return matrix;
	}

	it("recovers exactly the acknowledged prefix (or the in-flight step) at every operation", async () => {
		const matrix = await cutMatrix();
		assert.ok(matrix.ops > 50, "the workload covers many operations");
		assert.deepEqual(matrix.lost, []);
		assert.equal(matrix.cuts, matrix.ops * 2);
		// Both sides of each fsync were cut: some in-flight writes survived, some not.
		const outcomes = JSON.stringify(matrix.outcomes);
		assert.ok(matrix.outcomes.interrupted > matrix.ops, outcomes);
		assert.ok(matrix.outcomes.inFlightDurable > 0, outcomes);
		assert.ok(matrix.outcomes.inFlightLost > 0, outcomes);
	});

	it("reversion: without fsync the same cuts lose acknowledged records", async () => {
		const matrix = await cutMatrix(true);
		assert.ok(
			matrix.lost.length > matrix.cuts / 2,
			`${matrix.lost.length} of ${matrix.cuts}`,
		);
	});

	it("reversion: without the parent directory fsync a new store's directory is lost", async () => {
		// Only the fsync of the store directory's parent is removed.
		const matrix = await cutMatrix((path) => path === "/state");
		assert.ok(matrix.lost.length > 0, "a cut loses the whole new directory");
		assert.ok(
			matrix.lost.every((cut) => cut.includes('"outcomes":[]')),
			matrix.lost[0],
		);
	});

	it("covers every scenario step", () => {
		assert.ok(SCENARIO.length >= 15);
	});
});

describe("FileOutcomeStore on disk", () => {
	it("creates a private directory and owner-only files, and places terminal stores under herdr-agents", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-store-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const dir = terminalOutcomeStoreDir(root, "parent session id");
		assert.equal(
			dir.startsWith(join(root, "herdr-agents", "outcome-store")),
			true,
		);
		assert.doesNotMatch(dir, /parent session id/);
		const store = await openFileOutcomeStore({ dir, parent: "p" });
		await store.commit(draft("t", "result", "x"));
		await store.compact();
		if (process.platform !== "win32") {
			assert.equal(statSync(dir).mode & 0o777, 0o700);
			for (const name of ["journal.jsonl", "snapshot.json", OUTCOME_LOCK_FILE])
				assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
		}
		await assert.rejects(
			FileOutcomeStore.open({ dir, parent: "p" }),
			/another writer/,
		);
		await store.close();
		const reopened = await FileOutcomeStore.open({ dir, parent: "p" });
		assert.equal(reopened.recovery().outcomes.length, 1);
		await reopened.close();
	});

	/** A lock socket whose holder is gone: linked into place, then closed. */
	async function staleSocket(dir: string): Promise<void> {
		const server = createServer();
		const bound = join(dir, "bound.sock");
		await new Promise<void>((resolve) => server.listen(bound, resolve));
		linkSync(bound, join(dir, OUTCOME_LOCK_FILE));
		await new Promise((resolve) => server.close(resolve));
	}

	it("takes over a lock socket that refuses connections, and leaves anything else alone", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-outcome-lock-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		await staleSocket(dir);
		const recovered = await FileOutcomeStore.open({ dir, parent: "p" });
		assert.ok(lstatSync(join(dir, OUTCOME_LOCK_FILE)).isSocket());
		await recovered.commit(draft("t", "result", "x"));
		await recovered.close();
		assert.equal(existsSync(join(dir, OUTCOME_LOCK_FILE)), false, "released");
		// Only a socket can prove its holder gone: a file (an older lock) stays.
		writeFileSync(join(dir, OUTCOME_LOCK_FILE), '{"pid":1}');
		await assert.rejects(
			FileOutcomeStore.open({ dir, parent: "p" }),
			(error: Error) =>
				isOutcomeStoreError(error, "locked") &&
				/not a lock socket/.test(error.message),
		);
		assert.equal(
			readFileSync(join(dir, OUTCOME_LOCK_FILE), "utf8"),
			'{"pid":1}',
		);
		assert.deepEqual(
			readdirSync(dir).filter((name) => name.startsWith(OUTCOME_LOCK_FILE)),
			[OUTCOME_LOCK_FILE],
			"the refused open left no socket behind",
		);
	});

	it("a live lock published while a stale one is being recovered is put back, not taken", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-outcome-lock-"));
		const live = createServer((socket) => socket.destroy());
		t.after(async () => {
			await new Promise((resolve) => live.close(resolve));
			rmSync(dir, { recursive: true, force: true });
		});
		await new Promise<void>((resolve) =>
			live.listen(join(dir, "live.sock"), resolve),
		);
		await staleSocket(dir);
		const lock = join(dir, OUTCOME_LOCK_FILE);
		const connect = net.connect;
		let swapped = false;
		// SAFETY: the wrapper forwards every argument to the original connect.
		net.connect = ((...args: Parameters<typeof net.connect>) => {
			const socket = connect(...args);
			if (!swapped && args[0] === lock) {
				// The stale lock was probed (refused); another opener now publishes
				// its live lock before this one moves the stale one aside.
				swapped = true;
				unlinkSync(lock);
				linkSync(join(dir, "live.sock"), lock);
			}
			return socket;
		}) as typeof net.connect;
		syncBuiltinESMExports();
		try {
			await rejectsWith(
				FileOutcomeStore.open({ dir, parent: "p" }),
				"locked",
				/one writer per store/,
			);
		} finally {
			net.connect = connect;
			syncBuiltinESMExports();
		}
		assert.equal(swapped, true);
		assert.equal(
			lstatSync(lock).ino,
			lstatSync(join(dir, "live.sock")).ino,
			"the live holder keeps its lock",
		);
		assert.deepEqual(
			readdirSync(dir)
				.filter((name) => name.startsWith(OUTCOME_LOCK_FILE))
				.sort(),
			[OUTCOME_LOCK_FILE],
		);
	});

	it("a writer whose lock socket was removed or replaced stops, compaction included", async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-outcome-lock-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		for (const loss of ["removed", "replaced"] as const) {
			const store = await FileOutcomeStore.open({ dir, parent: "p" });
			await store.commit(draft(loss, "result", "x"));
			unlinkSync(join(dir, OUTCOME_LOCK_FILE));
			if (loss === "replaced") await staleSocket(dir);
			const journal = readFileSync(join(dir, "journal.jsonl"));
			await rejectsWith(store.compact(), "locked");
			await rejectsWith(store.commit(draft("u", "result", "x")), "broken");
			assert.deepEqual(readFileSync(join(dir, "journal.jsonl")), journal);
			await store.close();
			// The stopped writer's release leaves another holder's name alone.
			assert.equal(
				existsSync(join(dir, OUTCOME_LOCK_FILE)),
				loss === "replaced",
				loss,
			);
		}
	});

	it("a store path too long for a socket locks through a private short alias", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-lock-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const dir = join(root, "d".repeat(60), "e".repeat(60));
		const store = await FileOutcomeStore.open({ dir, parent: "p" });
		assert.ok(lstatSync(join(dir, OUTCOME_LOCK_FILE)).isSocket());
		await assert.rejects(
			FileOutcomeStore.open({ dir, parent: "p" }),
			/one writer per store/,
		);
		await store.close();
		const again = await FileOutcomeStore.open({ dir, parent: "p" });
		await again.close();
		assert.deepEqual(
			readdirSync(tmpdir()).filter((name) => name.startsWith("maestro-lock-")),
			[],
			"no alias is left behind",
		);
		// A temporary directory too long for an alias falls back to /tmp.
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = dir;
		try {
			const viaTmp = await FileOutcomeStore.open({ dir, parent: "p" });
			await viaTmp.close();
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
		}
	});

	it("names the network filesystems a lock socket cannot vouch for", () => {
		assert.equal(networkFilesystemName(0x6969), "NFS");
		assert.equal(networkFilesystemName(0xff534d42), "CIFS");
		assert.equal(networkFilesystemName(0xfe534d42), "SMB2");
		// sshfs, rclone, GlusterFS and virtiofs all report FUSE.
		assert.equal(networkFilesystemName(0x65735546), "FUSE");
		assert.equal(networkFilesystemName(0x7461636f), "OCFS2");
		assert.equal(networkFilesystemName(0x6b414653), "kAFS");
		assert.equal(networkFilesystemName(0x564c), "NCP");
		assert.equal(networkFilesystemName(0xef53), undefined, "ext4 is local");
		assert.equal(networkFilesystemName(0x58465342), undefined, "XFS is local");
	});
});

describe("parent accept re-check with an outcome store", () => {
	it("records the subject, including the worktree HEAD, before the check command runs", async () => {
		const order: string[] = [];
		const subjects: JsonObject[] = [];
		const outcome = await runParentAcceptCheck({
			spec: { run: "npm test", maxRetries: 0, timeoutSec: 5, paths: [] },
			result: {
				handle: {
					id: "h",
					name: "n",
					role: "",
					harness: "pi",
					cwd: "/w",
					startedAt: 0,
					sessionId: "s",
				},
				outcome: "completed",
				exitCode: 0,
				durationMs: 1,
			},
			evidence: { reason: "done", exitCode: 0 },
			exitCode: 0,
			cwd: "/w",
			worktree: {
				path: "/w",
				workspaceId: "ws",
				paneId: "pane",
				branch: "agents/leaf",
				baseRef: "main",
				baseSha: "base",
				manifestFile: "/m.json",
				headSha: "head",
				commitsAhead: 1,
				clean: true,
				conflicted: false,
				changedFiles: [],
				untrackedFiles: [],
			},
			control: {
				cancellable: (work) => work(new AbortController().signal),
				interruption: () => undefined,
				recordCheck: async (subject) => {
					order.push("record");
					subjects.push(subject);
				},
			},
			runner: async () => {
				order.push("run");
				return { kind: "exit", exitCode: 0, output: "" };
			},
		});
		assert.equal(outcome.verdict, "accepted");
		assert.deepEqual(order, ["record", "run"]);
		assert.deepEqual(subjects[0], {
			checkHash: outcome.checkHash,
			cwd: "/w",
			branch: "agents/leaf",
			baseSha: "base",
			headSha: "head",
		});
	});
});
