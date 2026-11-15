import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { piHasProjectTrustGating } from "../../maestro/adapters/pi/script-shell.ts";
import { createLaunchPlanner } from "../../pi-extension/subagents/launch.ts";

describe("launch composition on Windows", () => {
	const paneConfig = {
		mode: "grouped",
		direction: "down",
		maxPerTab: 2,
	} as const;

	it("builds the snapshot's trust data from the launching context", () => {
		// SAFETY: building a snapshot touches only the context below, never the
		// planner's runtime or model config.
		const { launchSnapshot } = createLaunchPlanner({
			runtime: {} as never,
			modelConfig: {} as never,
			paneConfig,
		});
		const ctx = (isProjectTrusted?: () => boolean) =>
			// SAFETY: the stub carries every ExtensionContext member launchSnapshot reads.
			({
				cwd: "/session/cwd",
				sessionManager: {
					getSessionFile: () => "f",
					getSessionId: () => "s",
					getSessionDir: () => "d",
				},
				modelRegistry: {
					find: () => undefined,
					getAvailable: () => [],
					getAll: () => [],
				},
				isProjectTrusted,
			}) as never;
		assert.deepEqual(launchSnapshot(ctx(() => false)).scriptShell, {
			cwd: "/session/cwd",
			projectTrusted: false,
		});
		assert.deepEqual(launchSnapshot(ctx(() => true)).scriptShell, {
			cwd: "/session/cwd",
			projectTrusted: true,
		});
		// A context that cannot report the decision follows this Pi's gating.
		assert.equal(
			launchSnapshot(ctx()).scriptShell?.projectTrusted,
			!piHasProjectTrustGating(),
		);
	});
});
