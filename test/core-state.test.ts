import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lifecycle from "../maestro/core/lifecycle.ts";
import type { SubagentActivityState } from "../maestro/core/types.ts";
import { hasUndeliveredChildren } from "../maestro/core/undelivered-children.ts";
import { SupervisionCoordinator } from "../maestro/core/supervision.ts";
import { formatStatusLine } from "../maestro/core/status.ts";

const activity: SubagentActivityState = {
	version: 1,
	runningChildId: "fixture",
	createdAt: 0,
	updatedAt: 1,
	sequence: 1,
	latestEvent: "agent_start",
	phase: "active",
	agentActive: true,
	turnActive: true,
	providerActive: false,
	toolActive: false,
	activeScope: "agent",
	activeSince: 1,
};

test("core lifecycle projects all activity scopes and irreversible terminal/delivery transitions", () => {
	let state = lifecycle.createLifecycle(0);
	state = lifecycle.observePaneInspection(
		state,
		{ kind: "present", agentStatus: "blocked", observedAt: 1 },
		1,
	);
	assert.equal(state.turn.kind, "blocked");
	for (const scope of [
		"tool",
		"provider",
		"streaming",
		"turn",
		"agent",
	] as const) {
		state = lifecycle.observeActivity(
			state,
			{
				ok: true,
				activity: {
					...activity,
					activeScope: scope,
					toolName: "fixture",
					toolStartedAt: 1,
				},
			},
			2,
		);
		assert.equal(state.activityDetail?.kind, "scope");
	}
	state = lifecycle.observeActivity(
		state,
		{ ok: false, reason: "invalid", error: "fixture" },
		3,
	);
	assert.equal(state.activityHealth.kind, "problem");
	state = lifecycle.observeActivity(
		state,
		{ ok: true, activity: { ...activity, phase: "waiting" } },
		4,
	);
	assert.equal(state.activityDetail, null);
	state = lifecycle.observePaneInspection(
		state,
		{ kind: "present", agentStatus: "working", observedAt: 5 },
		5,
	);
	state = lifecycle.observeActivity(state, { ok: true, activity }, 6);
	state = lifecycle.observePaneInspection(
		state,
		{ kind: "present", agentStatus: "working", observedAt: 7 },
		7,
	);
	assert.equal(lifecycle.projectLifecycle(state, 8).kind, "active");
	const running = lifecycle.markProcessRunning(lifecycle.createLifecycle(0), 1);
	assert.equal(running.process.kind, "running");
	assert.equal(lifecycle.markProcessRunning(running, 2), running);
	const failed = lifecycle.markFailed(
		lifecycle.markCompletionDetected(
			running,
			{ reason: "done", exitCode: 0 },
			3,
		),
		"fixture",
		4,
		2,
	);
	assert.equal(lifecycle.projectLifecycle(failed, 5).kind, "failed");
	const delivered = lifecycle.markDelivery(failed, "delivered");
	assert.equal(lifecycle.markDelivery(delivered, "suppressed"), delivered);
	assert.equal(lifecycle.markCompleted(running, 5), running);
	for (const kind of [
		"waiting",
		"active",
		"blocked",
		"interrupted",
		"running",
		"starting",
	] as const) {
		assert.match(
			lifecycle.formatLifecycleTransitionLine(
				"fixture",
				{ kind, label: "tool", stateDurationSince: 1 },
				"recovered",
				5,
				0,
				String,
			),
			/recovered/,
		);
	}
	assert.match(
		lifecycle.formatLifecycleTransitionLine(
			"fixture",
			{ kind: "stalled" },
			"stalled",
			5,
			0,
			String,
		),
		/stalled/,
	);
	assert.match(
		lifecycle.formatLifecycleTransitionLine(
			"fixture",
			{ kind: "active" },
			"recovered",
			5,
			0,
			String,
		),
		/active/,
	);
	assert.equal(hasUndeliveredChildren(), false);
	const snapshot = {
		elapsedMs: 1_000,
		elapsedText: "1s",
		activeSinceMs: null,
		activeDurationText: null,
		activeScope: null,
		waitingSinceMs: null,
		waitingDurationText: null,
		latestEvent: null,
		activityLabel: null,
		snapshotState: "missing" as const,
		snapshotError: null,
		snapshotProblemText: null,
		statusLabel: null,
	};
	assert.match(
		formatStatusLine("fixture", {
			...snapshot,
			kind: "starting",
			statusLabel: "loading",
		}),
		/starting \(loading\)/,
	);
	assert.match(
		formatStatusLine("fixture", { ...snapshot, kind: "active" }),
		/running 1s/,
	);
});

test("core supervision reconfiguration preserves live registration handles and refuses changes after close", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "maestro-reconfigure-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const owner = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		async () => ({ kind: "missing", observedAt: 0 }),
		true,
	);
	t.after(() => owner.close());
	const registration = owner.register(join(dir, "session.jsonl"), "surface");
	await registration.wait(new AbortController().signal);
	const parked = registration.wait(new AbortController().signal);
	owner.setForcePolling(false);
	assert.equal(await parked, "reconcile");
	owner.setForcePolling(true);
	owner.setForcePolling(true);
	assert.equal(
		await registration.wait(new AbortController().signal),
		"reconcile",
	);
	registration.unregister();
	owner.close();
	assert.throws(() => owner.setForcePolling(false), /closed/);
});
