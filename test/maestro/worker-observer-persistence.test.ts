/**
 * P3-9 unit cases: the provider Observer's persistence over the outcome store.
 * A batch's state and the owned help requests it counts as surfaced are saved
 * in one record, the cold seed included. The real-B2 cases (a delayed first
 * snapshot, a restart without a saved state) are in
 * test/worker/b2-admission.test.ts.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	Client,
	type components,
	type ObserverBatch,
	type ObserverState,
} from "@nublai/pi-worker-client";
import { WorkerLaunchStore } from "../../maestro/adapters/worker/launch-store.ts";
import {
	WORKER_OBSERVER_STATE_KEY,
	workerObserverPersistence,
} from "../../maestro/adapters/worker/parent-admission.ts";
import { FileOutcomeStore } from "../../maestro/runtime/file-outcome-store.ts";

type Worker = components["schemas"]["Worker"];
type ChildClaim = components["schemas"]["ChildClaim"];

const OWNED = "worker-owned";
const FOREIGN = "worker-foreign";

function claim(command_id: string, kind: ChildClaim["kind"]): ChildClaim {
	return {
		command_id,
		kind,
		message: `${kind} ${command_id}`,
		claim_not_verified: true,
	};
}

/** A worker row as the Observer retains it: only its reports are read. */
function row(worker_id: string, reports: ChildClaim[]): Worker {
	// SAFETY: persistence reads a row's `child_reports` only.
	return { worker_id, child_reports: reports } as Worker;
}

/** The state a snapshot of `rows` leaves: every listed report counts as surfaced. */
function stateOf(rows: Record<string, string[]>): ObserverState {
	const workers: ObserverState["workers"] = {};
	for (const [id, reports] of Object.entries(rows))
		workers[id] = {
			worker_epoch: "e",
			session_id: "s",
			binding_revision: 1,
			settle_count: 0,
			interactions: [],
			settlements: [],
			reports,
		};
	return { version: 1, cursor: { transport_epoch: "t", seq: 1 }, workers };
}

async function fixture(
	run: (setup: Awaited<ReturnType<typeof open>>) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "maestro-observer-persistence-"));
	const setup = await open(dir);
	try {
		await run(setup);
	} finally {
		await setup.store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function open(dir: string) {
	const store = await FileOutcomeStore.open({
		dir: join(dir, "outcomes"),
		parent: "parent",
	});
	const launches = new WorkerLaunchStore(join(dir, "launches"));
	launches.create({
		launch_id: "0190c0de-0000-7000-8000-000000000001",
		run_id: "run-1",
		name: "t",
		task_id: "task-1",
		generation_id: "gen-1",
		parent_worker_id: "parent",
		slot: { name: "s1", path: dir, branch: "b", base_sha: "0".repeat(40) },
		model: { provider: "p", model: "m", thinking: "off" },
		state: "acquired",
		worker_id: OWNED,
	});
	// No socket: a report missing from the rows cannot be read either.
	const client = new Client({
		socketPath: join(dir, "absent.sock"),
		grantFile: join(dir, "absent-grant"),
		timeoutMs: 1_000,
	});
	const committed: string[] = [];
	const persistence = workerObserverPersistence({
		store,
		launches,
		client,
		envelope: (draft) => `[test ${draft.kind}] ${draft.text}`,
		committed: (outcomes) =>
			committed.push(...outcomes.map((o) => o.outcome.reportId ?? "")),
	});
	return { store, persistence, committed };
}

function help(store: FileOutcomeStore) {
	return store
		.recovery()
		.outcomes.filter((stored) => stored.outcome.kind === "help")
		.map((stored) => [stored.outcome.reportId, stored.outcome.text]);
}

describe("worker Observer persistence: the cold seed", () => {
	it("retains the owned help a cold seed counts as surfaced, in the record that saves the state", () =>
		fixture(async ({ store, persistence, committed }) => {
			const rows = new Map([
				[OWNED, row(OWNED, [claim("h-1", "help"), claim("r-1", "result")])],
				[FOREIGN, row(FOREIGN, [claim("h-foreign", "help")])],
			]);
			const batch: ObserverBatch = {
				notices: [],
				state: stateOf({ [OWNED]: ["h-1", "r-1"], [FOREIGN]: ["h-foreign"] }),
				seeded: true,
			};
			await persistence.persist(batch, (id) => rows.get(id));
			// Only the owned help: never a result report, never a foreign worker's.
			assert.deepEqual(help(store), [["h-1", "help h-1"]]);
			assert.deepEqual(committed, ["h-1"]);
			assert.deepEqual(
				store.observerState(WORKER_OBSERVER_STATE_KEY),
				JSON.parse(JSON.stringify(batch.state)),
			);
		}));

	it("does not retain a seed's reports from a later (not seeded) batch: those surface as notices", () =>
		fixture(async ({ store, persistence }) => {
			const rows = new Map([[OWNED, row(OWNED, [claim("h-1", "help")])]]);
			await persistence.persist(
				{ notices: [], state: stateOf({ [OWNED]: ["h-1"] }) },
				(id) => rows.get(id),
			);
			assert.deepEqual(help(store), []);
		}));

	it("a seeded owned report that cannot be read is not saved as seen", () =>
		fixture(async ({ store, persistence }) => {
			await assert.rejects(
				persistence.persist(
					{ notices: [], state: stateOf({ [OWNED]: ["h-1"] }), seeded: true },
					() => undefined,
				),
			);
			assert.equal(store.observerState(WORKER_OBSERVER_STATE_KEY), undefined);
			assert.deepEqual(help(store), []);
		}));
});
