import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";
import {
	listContainedWorktrees,
	removeContainedWorktree,
} from "../maestro/core/worktree-cleanup.ts";
import {
	rememberOpenedPrimaryWorkspace,
	clearOpenedPrimaryWorkspaceClaims,
} from "../maestro/core/opened-primary-workspace.ts";

test("generic cleanup leaves undecidable manifest identity blocked and ignores vanished manifests", async () => {
	for (const code of ["ENOENT", "EACCES"]) {
		const f = cleanupFixture();
		f.operations.readManifests = () => [
			{ file: "/fixture-manifest.json", value: { path: "/manifest-alias" } },
		];
		f.operations.realpath = (path) => {
			if (path === "/manifest-alias")
				throw Object.assign(new Error("fixture identity refusal"), { code });
			return path;
		};
		const entries = await listContainedWorktrees(f.input);
		assert.equal(entries.length, 1);
		if (code === "EACCES")
			assert.match(entries[0].blockers.join(" "), /fixture identity refusal/);
	}
});

test("generic cleanup does not attribute a primary workspace from a claim whose checkout disappeared", async (t) => {
	t.after(clearOpenedPrimaryWorkspaceClaims);
	clearOpenedPrimaryWorkspaceClaims();
	rememberOpenedPrimaryWorkspace({
		workspaceId: "workspace",
		repoKey: "repo",
		terminalId: "terminal",
		checkoutPath: "/gone",
	});
	const f = cleanupFixture();
	f.operations.realpath = (path) => {
		if (path === "/gone") throw new Error("fixture checkout gone");
		return path;
	};
	const result = await removeContainedWorktree(f.input);
	assert.equal(result.status, "removed");
});
