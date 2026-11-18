/**
 * P3-7: owner-prepared worker slots and the acquisition manifests. The owner
 * makes locked linked worktrees of the parent's own repository at
 * `PARENT/.piw-slots/<name>`; Maestro checks them with plain reads, claims one
 * durably, refuses an exhausted or mismatched pool, and never runs Git
 * administrative writes (owner Git here is the test's own setup).
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	UUIDV7,
	uuidv7,
	WorkerLaunchStore,
} from "../../maestro/adapters/worker/launch-store.ts";
import {
	parseSlotManifest,
	type WorkerSlot,
	WorkerSlotPool,
	WorkerSlotRefusal,
} from "../../maestro/adapters/worker/slots.ts";

function ownerTopology(count = 2) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "maestro-slots-")));
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: base,
		LANG: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
	const repo = join(base, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Owner");
	git(repo, "config", "user.email", "owner@example.invalid");
	writeFileSync(join(repo, "note"), "base\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	const baseSha = git(repo, "rev-parse", "HEAD");
	const root = join(base, "parent");
	git(repo, "worktree", "add", "-qb", "job/parent", root, "HEAD");
	mkdirSync(join(root, ".piw-slots"));
	const slots: WorkerSlot[] = [];
	for (let i = 0; i < count; i++) {
		const path = join(root, ".piw-slots", `s${i}`);
		git(repo, "worktree", "add", "-qb", `maestro/s${i}`, path, baseSha);
		git(repo, "worktree", "lock", path);
		slots.push({ name: `s${i}`, branch: `refs/heads/maestro/s${i}`, baseSha });
	}
	const claims = join(base, "state", "slots");
	return {
		base,
		repo,
		root,
		baseSha,
		slots,
		git,
		pool: () => new WorkerSlotPool({ root, slots, claimsDir: claims }),
		dispose: () => rmSync(base, { recursive: true, force: true }),
	};
}

async function using(
	run: (t: ReturnType<typeof ownerTopology>) => void | Promise<void>,
	count?: number,
) {
	const topology = ownerTopology(count);
	try {
		await run(topology);
	} finally {
		topology.dispose();
	}
}

const refusal = (code: string, text: RegExp) => (error: Error) =>
	error instanceof WorkerSlotRefusal &&
	error.code === code &&
	text.test(error.message);

describe("owner-prepared worker slots", () => {
	it("claims free slots durably in manifest order and refuses an exhausted pool before acquisition", () =>
		using((t) => {
			const pool = t.pool();
			const a = pool.claim(uuidv7());
			const b = pool.claim(uuidv7());
			assert.deepEqual([a.name, b.name], ["s0", "s1"]);
			assert.equal(a.path, join(t.root, ".piw-slots", "s0"));
			assert.throws(
				() => pool.claim(uuidv7()),
				refusal(
					"slots_exhausted",
					/2 prepared, all claimed.*refused before acquisition/,
				),
			);
			// The claims are durable: a new pool over the same directory sees them.
			assert.equal(t.pool().holder("s0"), a.launchId);
			assert.equal(
				statSync(join(t.base, "state", "slots")).mode & 0o777,
				0o700,
			);
			assert.equal(
				statSync(join(t.base, "state", "slots", "s0.claim")).mode & 0o777,
				0o600,
			);
		}));

	it("prefers the slot named by the requested branch and checks a requested base", () =>
		using((t) => {
			const pool = t.pool();
			assert.equal(pool.claim(uuidv7(), { branch: "s1" }).name, "s1");
			assert.equal(
				pool.claim(uuidv7(), { branch: "s1" }).name,
				"s0",
				"taken: the first free one",
			);
			const other = ownerTopology();
			try {
				assert.throws(
					() => other.pool().claim(uuidv7(), { base: "0".repeat(40) }),
					refusal("slot_mismatch", /not the requested/),
				);
				assert.equal(
					other.pool().claim(uuidv7(), { base: other.baseSha }).name,
					"s0",
				);
				assert.equal(other.pool().holder("s1"), undefined);
			} finally {
				other.dispose();
			}
		}));

	it("a release frees only the claim of the same launch", () =>
		using((t) => {
			const pool = t.pool();
			const claimed = pool.claim(uuidv7());
			pool.release(claimed.name, uuidv7());
			assert.equal(pool.holder(claimed.name), claimed.launchId);
			pool.release(claimed.name, claimed.launchId);
			assert.equal(pool.holder(claimed.name), undefined);
		}, 1));

	const mismatches: [
		string,
		(t: ReturnType<typeof ownerTopology>) => void,
		RegExp,
	][] = [
		[
			"unlocked",
			(t) =>
				t.git(t.repo, "worktree", "unlock", join(t.root, ".piw-slots", "s0")),
			/not locked/,
		],
		[
			"moved off its base",
			(t) => {
				const slot = join(t.root, ".piw-slots", "s0");
				writeFileSync(join(slot, "note"), "changed\n");
				t.git(slot, "commit", "-qam", "agent work");
			},
			/not at its base/,
		],
		[
			"on another branch",
			(t) =>
				t.git(
					join(t.root, ".piw-slots", "s0"),
					"checkout",
					"-q",
					"-b",
					"other",
				),
			/not on refs\/heads\/maestro\/s0/,
		],
		[
			"a symlink",
			(t) => {
				const slot = join(t.root, ".piw-slots", "s0");
				const moved = join(t.base, "elsewhere");
				execFileSync("mv", [slot, moved]);
				symlinkSync(moved, slot);
			},
			/not a real directory/,
		],
		[
			"a repository of its own",
			(t) => {
				const slot = join(t.root, ".piw-slots", "s0");
				rmSync(slot, { recursive: true, force: true });
				mkdirSync(slot);
				t.git(slot, "init", "-q");
			},
			/not a linked worktree/,
		],
		[
			"a worktree of another repository",
			(t) => {
				const slot = join(t.root, ".piw-slots", "s0");
				const other = join(t.base, "other");
				mkdirSync(other);
				t.git(other, "init", "-q", "-b", "main");
				t.git(
					other,
					"-c",
					"user.name=o",
					"-c",
					"user.email=o@example.invalid",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					"o",
				);
				t.git(t.repo, "worktree", "remove", "--force", "--force", slot);
				t.git(other, "worktree", "add", "-qb", "maestro/s0", slot, "HEAD");
				t.git(other, "worktree", "lock", slot);
			},
			/repository is not the parent's/,
		],
		[
			"missing",
			(t) =>
				rmSync(join(t.root, ".piw-slots"), { recursive: true, force: true }),
			/\.piw-slots is missing/,
		],
	];
	for (const [what, tamper, text] of mismatches)
		it(`a slot ${what} is refused, not skipped, and nothing is claimed`, () =>
			using((t) => {
				tamper(t);
				const pool = t.pool();
				assert.throws(
					() => pool.claim(uuidv7()),
					refusal("slot_mismatch", text),
				);
				assert.equal(pool.holder("s0"), undefined);
				assert.equal(pool.holder("s1"), undefined);
			}));

	it("the manifest is strict: unique names and branches, namespaced refs, full commit IDs", () => {
		const ok = {
			version: 1,
			kind: "maestro-worker-slots",
			slots: [
				{ name: "a", branch: "refs/heads/ns/a", baseSha: "a".repeat(40) },
			],
		};
		assert.equal(parseSlotManifest(JSON.stringify(ok)).slots.length, 1);
		const bad = (slots: WorkerSlot[]) => () =>
			parseSlotManifest(JSON.stringify({ ...ok, slots }));
		assert.throws(
			bad([
				{ name: "../x", branch: "refs/heads/ns/a", baseSha: "a".repeat(40) },
			]),
			/one path component/,
		);
		assert.throws(
			bad([{ name: "a", branch: "refs/heads/a", baseSha: "a".repeat(40) }]),
			/namespace/,
		);
		assert.throws(
			bad([{ name: "a", branch: "refs/heads/ns/a", baseSha: "abc" }]),
			/full commit/,
		);
		assert.throws(
			bad([
				{ name: "a", branch: "refs/heads/ns/a", baseSha: "a".repeat(40) },
				{ name: "b", branch: "refs/heads/ns/a", baseSha: "a".repeat(40) },
			]),
			/unique/,
		);
		assert.throws(
			() => parseSlotManifest(JSON.stringify({ ...ok, version: 2 })),
			/version 1/,
		);
	});

	it("claims are kept outside every slot", () =>
		using((t) => {
			assert.throws(
				() =>
					new WorkerSlotPool({
						root: t.root,
						slots: t.slots,
						claimsDir: join(t.root, ".piw-slots", "s0", "claims"),
					}),
				/outside every slot/,
			);
		}));
});

describe("worker acquisition manifests", () => {
	it("records each command durably with a UUIDv7 ID before its outcome, once per ID", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-launches-"));
		try {
			const store = new WorkerLaunchStore(join(dir, "launches"));
			const launchId = uuidv7();
			store.create({
				launch_id: launchId,
				run_id: "run",
				name: "w",
				task_id: "task",
				generation_id: "gen",
				parent_worker_id: "parent",
				slot: {
					name: "s0",
					path: "/p/.piw-slots/s0",
					branch: "refs/heads/m/s0",
					base_sha: "a".repeat(40),
				},
				model: { provider: "p", model: "m", thinking: "off" },
				state: "claimed",
			});
			const id = uuidv7();
			assert.match(id, UUIDV7);
			assert.throws(
				() =>
					store.record(launchId, {
						command_id: "not-a-uuid",
						operation: "workers.create",
						purpose: "create",
						request_hash: "h",
					}),
				/UUIDv7/,
			);
			store.record(launchId, {
				command_id: id,
				operation: "workers.create",
				purpose: "create",
				request_hash: "h",
			});
			// Durable before transport: a fresh reader sees it pending.
			assert.equal(
				new WorkerLaunchStore(join(dir, "launches")).read(launchId)?.commands[0]
					?.outcome,
				"pending",
			);
			assert.throws(
				() =>
					store.record(launchId, {
						command_id: id,
						operation: "sessions.prompt",
						purpose: "prompt",
						request_hash: "h2",
					}),
				/used once/,
			);
			store.settle(launchId, id, "unknown", "receipt_missing");
			store.settle(launchId, id, "observed");
			assert.throws(
				() => store.settle(launchId, id, "no_effect"),
				/already observed/,
			);
			assert.equal(store.read(launchId)?.commands[0]?.reason, undefined);
			assert.throws(() => store.discard(launchId), /acquired nothing/);
			assert.deepEqual(readdirSync(join(dir, "launches")), [
				`${launchId}.json`,
			]);
			assert.equal(
				statSync(join(dir, "launches", `${launchId}.json`)).mode & 0o777,
				0o600,
			);
			assert.doesNotMatch(
				readFileSync(join(dir, "launches", `${launchId}.json`), "utf8"),
				/token|Bearer/,
			);
			store.update(launchId, (m) => {
				m.state = "not_acquired";
			});
			store.discard(launchId);
			assert.deepEqual(store.list(), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("UUIDv7 IDs carry their millisecond and version", () => {
		const at = Date.UTC(2026, 10, 18);
		const id = uuidv7(at);
		assert.match(id, UUIDV7);
		assert.equal(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16), at);
		assert.notEqual(uuidv7(at), id);
	});
});
