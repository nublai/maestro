import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatWorktreeInventory,
	listContainedWorktrees,
	removeContainedWorktree,
} from "../maestro/core/worktree-cleanup.ts";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";

describe("explicit worktree cleanup", () => {
	it("lists contained cross-session orphans and retains local-only history", async () => {
		const f = cleanupFixture();
		const [row] = await listContainedWorktrees(f.input);
		assert.equal(row.classification, "eligible");
		assert.equal(row.sourceRepo, "/repo");
		assert.deepEqual(row.manifest, []);
		assert.match(formatWorktreeInventory([row]), /manifest: absent/);
		const inventory = formatWorktreeInventory([
			{ ...row, path: "/managed/inside", branch: "inside" },
			{
				...row,
				path: "/managed/outside",
				branch: "outside",
				contained: false,
				classification: "out-of-scope",
			},
		]);
		assert.ok(
			inventory.indexOf("outside —") < inventory.indexOf("inside —"),
			"in-scope rows stay at the end of large inventories",
		);
		assert.deepEqual(f.calls, []);
	});

	it("fails closed for out-of-scope and prefix-collision repositories", async () => {
		const f = cleanupFixture();
		f.operations.resolveSource = () => "/repo-other";
		assert.equal(
			(await listContainedWorktrees(f.input))[0].classification,
			"out-of-scope",
		);
		assert.equal(
			(await removeContainedWorktree({ ...f.input, preserve: true })).status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});

	it("canonicalizes cwd and source paths before containment", async () => {
		const f = cleanupFixture();
		f.operations.realpath = (path) => (path === "/alias" ? "/repo" : path);
		assert.equal(
			(await listContainedWorktrees({ ...f.input, cwd: "/alias" }))[0]
				.classification,
			"eligible",
		);
		assert.equal(
			(await listContainedWorktrees({ ...f.input, cwd: "/repo/subfolder" }))[0]
				.classification,
			"out-of-scope",
		);
	});

	it("blocks symlink aliases without turning the target into a managed candidate", async () => {
		const f = cleanupFixture();
		f.operations.realpath = (path) =>
			path === "/managed/repo/task" ? "/unmanaged/task" : path;
		const [row] = await listContainedWorktrees(f.input);
		assert.equal(row.path, "/managed/repo/task");
		assert.equal(row.classification, "unknown");
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: row.path })).status,
			"blocked",
		);
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: "/unmanaged/task" }))
				.status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});

	it("preserve never bypasses conflicts or submodule blockers", async () => {
		for (const patch of [
			{ conflicts: 1 },
			{ submodules: true },
			{ branch: "" },
		]) {
			const f = cleanupFixture();
			Object.assign(f.state, { dirtyFiles: 1 }, patch);
			assert.equal(
				(await removeContainedWorktree({ ...f.input, preserve: true })).status,
				"blocked",
			);
			assert.deepEqual(f.calls, []);
		}
	});

	it("uses Herdr for an open workspace and merges the reachable manifest", async () => {
		const f = cleanupFixture();
		f.operations.listWorktrees = () => [
			{
				path: "/managed/repo/task",
				branch: "task",
				isLinkedWorktree: true,
				workspaceId: "w1",
			},
		];
		f.operations.readManifests = () => [
			{
				file: "/manifest.json",
				value: {
					branch: "task",
					path: "/managed/repo/task",
					state: "ready_for_review",
					baseSha: "base",
				},
			},
		];
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "removed");
		assert.equal(result.entry?.manifest[0].value.baseSha, "base");
		assert.deepEqual(f.calls, ["herdr:w1", "manifest:removed"]);
		assert.match(result.message, /Branch task and its commits retained/);
	});

	it("uses Git for an orphan, then prunes only after absence is verified", async () => {
		const f = cleanupFixture();
		assert.equal((await removeContainedWorktree(f.input)).status, "removed");
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
		assert.equal("deleteBranch" in f.operations, false);
	});

	it("reprobes eligibility immediately before removal", async () => {
		const f = cleanupFixture();
		let count = 0;
		f.operations.holders = async () => ({
			blockers: ++count === 1 ? [] : ["Live child restarted"],
			warnings: [],
		});
		assert.equal((await removeContainedWorktree(f.input)).status, "blocked");
		assert.deepEqual(f.calls, []);
	});

	it("requires explicit preservation and reports its SHA", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 2;
		f.state.untrackedFiles = 1;
		assert.equal((await removeContainedWorktree(f.input)).status, "blocked");
		const result = await removeContainedWorktree({
			...f.input,
			preserve: true,
		});
		assert.equal(result.status, "removed");
		assert.equal(result.preservationSha, "wip-sha");
		assert.deepEqual(f.calls, [
			"preserve",
			"git:/repo:/managed/repo/task",
			"prune:/repo",
		]);
	});

	it("preservation failure aborts removal with state retained", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 1;
		f.operations.preserve = () => {
			throw new Error("commit hook rejected");
		};
		const result = await removeContainedWorktree({
			...f.input,
			preserve: true,
		});
		assert.equal(result.status, "failed");
		assert.match(result.message, /commit hook rejected/);
		assert.equal(f.state.dirtyFiles, 1);
		assert.deepEqual(f.calls, []);
	});

	it("rechecks dirty state after preservation", async () => {
		const f = cleanupFixture();
		f.state.dirtyFiles = 1;
		f.operations.preserve = () => "sha-but-still-dirty";
		assert.equal(
			(await removeContainedWorktree({ ...f.input, preserve: true })).status,
			"blocked",
		);
		assert.deepEqual(f.calls, []);
	});

	it("refuses ambiguous names and unknown targets", async () => {
		const f = cleanupFixture();
		assert.equal(
			(await removeContainedWorktree({ ...f.input, target: "absent" })).status,
			"blocked",
		);
		f.operations.scan = () => ["/managed/repo/task", "/managed/other/task"];
		assert.match((await removeContainedWorktree(f.input)).message, /Ambiguous/);
		assert.deepEqual(f.calls, []);
	});

	it("ignores removed manifests when the branch is relaunched at the same path", async () => {
		const f = cleanupFixture();
		f.operations.readManifests = () => [
			{
				file: "/old.json",
				value: {
					path: "/managed/repo/task",
					branch: "previous",
					workspaceId: "old",
					state: "removed",
				},
			},
		];
		assert.equal(
			(await listContainedWorktrees(f.input))[0].classification,
			"eligible",
		);
		assert.equal((await removeContainedWorktree(f.input)).status, "removed");
		assert.deepEqual(f.calls, ["git:/repo:/managed/repo/task", "prune:/repo"]);
	});

	it("discloses ignored files in inventory and removal without blocking", async () => {
		const f = cleanupFixture();
		f.state.ignoredFiles = 2;
		const rows = await listContainedWorktrees(f.input);
		assert.equal(rows[0].classification, "eligible");
		assert.match(formatWorktreeInventory(rows), /2 ignored/);
		assert.match(
			(await removeContainedWorktree(f.input)).message,
			/Deleted 2 ignored files/,
		);
	});

	it("reports ignored exclusions and preservation SHA after later refusal or failure", async () => {
		for (const kind of ["preserve", "reinspect", "remove"]) {
			const f = cleanupFixture();
			f.state.dirtyFiles = 1;
			f.state.ignoredFiles = 2;
			if (kind === "preserve")
				f.operations.preserve = () => {
					throw new Error("hook rejected");
				};
			if (kind === "reinspect") {
				const preserve = f.operations.preserve;
				f.operations.preserve = (entry) => {
					const sha = preserve(entry);
					f.state.locked = true;
					return sha;
				};
			}
			if (kind === "remove")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.notEqual(result.status, "removed");
			assert.match(
				result.message,
				/2 ignored files are not captured by preservation/,
			);
			if (kind !== "preserve") assert.match(result.message, /wip-sha/);
		}
	});

	it("reports manifest write failure as removed with warning", async () => {
		const f = cleanupFixture();
		f.operations.readManifests = () => [
			{
				file: "/manifest",
				value: { path: "/managed/repo/task", branch: "task" },
			},
		];
		f.operations.writeManifest = () => {
			throw new Error("permission denied");
		};
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "removed");
		assert.match(result.message, /Warning: Manifest.*permission denied/);
	});

	it("reports inspection failure instead of claiming an existing branch is missing", async () => {
		const f = cleanupFixture();
		f.operations.inspectGit = () => {
			throw new Error("Git timed out");
		};
		const result = await removeContainedWorktree(f.input);
		assert.equal(result.status, "blocked");
		assert.match(result.message, /Git timed out/);
		assert.doesNotMatch(result.message, /Target not found/);
	});

	it("already removed is a no-op with retained manifest evidence", async () => {
		const f = cleanupFixture();
		f.operations.scan = () => [];
		f.operations.exists = () => false;
		f.operations.readManifests = () => [
			{
				file: "/manifest",
				value: { path: "/managed/repo/task", branch: "task", state: "removed" },
			},
		];
		assert.equal(
			(await removeContainedWorktree(f.input)).status,
			"already-removed",
		);
		assert.deepEqual(f.calls, []);
	});
});
