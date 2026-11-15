import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForCompletion } from "../../maestro/adapters/pi/completion.ts";
import {
	createLifecycle,
	lifecycleTransition,
	observePaneInspection,
	projectLifecycle,
	type LifecycleProjection,
	type LifecycleTransition,
} from "../../maestro/core/lifecycle.ts";

test("Core finished native exit admits interactive sentinel only after exit and with matching code", async () => {
	for (const code of [0, 7]) {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			paneDisappearanceGraceMs: 0,
			inspectExecution: async () => ({ kind: "finished", exitCode: code }),
			readTerminalTail: async () => `__SUBAGENT_DONE_${code}__`,
		});
		assert.equal(result.reason, "sentinel");
		assert.equal(result.exitCode, code);
	}
	const stale = await waitForCompletion(new AbortController().signal, {
		intervalMs: 1,
		paneDisappearanceGraceMs: 0,
		inspectExecution: async () => ({ kind: "finished", exitCode: 9 }),
		readTerminalTail: async () => "__SUBAGENT_DONE_0__",
	});
	assert.equal(stale.reason, "error");
	assert.equal(stale.exitCode, 9);
});

for (const nativeKind of ["finished", "missing"] as const)
	for (const exitCode of [0, 7, undefined])
		for (const unreadable of [false, true])
			test(`Core ${nativeKind} exit ${exitCode} without completion evidence preserves native code (unreadable=${unreadable})`, async () => {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					paneDisappearanceGraceMs: 0,
					inspectExecution: async () => ({ kind: nativeKind, exitCode }),
					readTerminalTail: async () => {
						if (unreadable) throw new Error("read unavailable");
						return "";
					},
				});
				assert.equal(
					result.reason,
					"error",
					"process exit alone is not task success",
				);
				assert.equal(
					result.exitCode,
					nativeKind === "finished" ? (exitCode ?? 1) : 1,
				);
				assert.equal(result.errorSource, "host");
				assert.match(
					result.errorMessage!,
					/native execution ended before completion evidence/,
				);
			});

for (const throws of [false, true])
	test(`Core ${throws ? "throwing" : "unavailable"} native inspection stalls and live inspection recovers`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: 1000 });
		const abort = new AbortController();
		let lifecycle = createLifecycle(Date.now());
		let inspections = 0;
		let terminalReads = 0;
		const projections: LifecycleProjection["kind"][] = [];
		const transitions: LifecycleTransition[] = [];
		await assert.rejects(
			waitForCompletion(abort.signal, {
				intervalMs: 1,
				inspectExecution: async () => {
					if (++inspections === 3) return { kind: "live" };
					if (throws) throw new Error("Core disconnected");
					return { kind: "unavailable", error: "Core disconnected" };
				},
				onPaneInspection: (inspection, at) => {
					assert.equal(at, Date.now());
					lifecycle = observePaneInspection(lifecycle, inspection, at);
					const projection = projectLifecycle(lifecycle, at);
					transitions.push(
						lifecycleTransition(projections.at(-1), projection.kind),
					);
					projections.push(projection.kind);
				},
				waitForNextCheck: async () => {
					t.mock.timers.tick(60_001);
					if (inspections === 3) abort.abort();
					return "reconcile";
				},
				readTerminalTail: async () => {
					terminalReads++;
					return "__SUBAGENT_DONE_0__";
				},
			}),
			/Aborted/,
		);
		assert.equal(inspections, 3);
		assert.equal(terminalReads, 0);
		assert.deepEqual(projections, ["starting", "stalled", "running"]);
		assert.deepEqual(transitions, [null, "stalled", "recovered"]);
	});
