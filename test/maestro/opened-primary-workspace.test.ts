import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clearOpenedPrimaryWorkspaceClaims,
	openedPrimaryWorkspaceClaims,
	rememberOpenedPrimaryWorkspace,
	type PrimaryWorkspaceClaim,
} from "../../maestro/core/opened-primary-workspace.ts";
import { removeContainedWorktree } from "../../maestro/core/worktree-cleanup.ts";
import { cleanupFixture } from "../worktree-cleanup-fixture.ts";

const claim: PrimaryWorkspaceClaim = {
	workspaceId: "w1",
	repoKey: "/repo/.git",
	terminalId: "term-1",
	checkoutPath: "/repo",
};

const note =
	"w1 appears to have been opened by worktree creation; if you haven't used it, close it with herdr workspace close w1";

describe("explicit removal reports a live claim only", () => {
	it("includes the suggestion and forgets the claim without closing", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			rememberOpenedPrimaryWorkspace(claim);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = (source, claims) => {
				assert.equal(source, "/repo");
				assert.deepEqual(claims, [claim]);
				return {
					note,
					repoKey: claim.repoKey,
					releasedClaims: [
						{
							workspaceId: claim.workspaceId,
							repoKey: claim.repoKey,
							terminalId: claim.terminalId,
						},
					],
				};
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed");
			assert.ok(result.message.includes(note), result.message);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), []);
			assert.deepEqual(fixture.calls, [
				"git:/repo:/managed/repo/task",
				"prune:/repo",
			]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("skips the report when this process holds no claim for the removed repository", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			const other = { ...claim, checkoutPath: "/other" };
			rememberOpenedPrimaryWorkspace(other);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = () => {
				throw new Error("must not be called");
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed", result.message);
			assert.doesNotMatch(result.message, /worktree creation|report failed/);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), [other]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});

	it("reports nothing after a restart, when this process recorded no claim", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		const fixture = cleanupFixture();
		fixture.operations.reportOpenedPrimaryWorkspace = () => {
			throw new Error("must not be called");
		};
		const result = await removeContainedWorktree(fixture.input);
		assert.equal(result.status, "removed", result.message);
		assert.doesNotMatch(result.message, /worktree creation/);
	});

	it("reports a failed primary lookup as a warning after the checkout is gone", async () => {
		clearOpenedPrimaryWorkspaceClaims();
		try {
			rememberOpenedPrimaryWorkspace(claim);
			const fixture = cleanupFixture();
			fixture.operations.reportOpenedPrimaryWorkspace = () => {
				throw new Error("herdr unavailable");
			};
			const result = await removeContainedWorktree(fixture.input);
			assert.equal(result.status, "removed");
			assert.match(
				result.message,
				/Primary workspace report failed: herdr unavailable/,
			);
			assert.deepEqual(openedPrimaryWorkspaceClaims(), [claim]);
		} finally {
			clearOpenedPrimaryWorkspaceClaims();
		}
	});
});
