import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createRunSession,
	type FinalizeControl,
	type Role,
	type Task,
} from "../maestro/engine.ts";
import { FakeHarnessAdapter } from "../maestro/adapters/fake/fake-harness-adapter.ts";

const role: Role = {
	name: "fixture",
	version: "1",
	description: "fixture",
	systemPrompt: "fixture",
	allowedTools: [],
};
const task: Task = {
	id: "fixture",
	name: "fixture",
	prompt: "fixture",
	role: "fixture",
	cwd: "/fixture",
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

for (const action of ["natural", "cancelled", "suppressed", "throw"] as const) {
	test(`generic finalization window ${action} preserves the owner's interruption decision`, async () => {
		const adapter = new FakeHarnessAdapter(),
			started = deferred(),
			finish = deferred();
		let observed: ReturnType<FinalizeControl["interruption"]>;
		const session = createRunSession({
			adapter,
			roles: [role],
			cwd: "/fixture",
			hooks: {
				onCancelState() {
					throw new Error("presentation-only fixture");
				},
			},
		});
		const handle = await session.spawn(task, {
			role,
			persistent: false,
			candidates: [{ model: "fixture/model", thinking: "off" }],
			async spawnAttempt(options) {
				return {
					adapter,
					handle: await adapter.spawn(options),
					async finalize(result, _task, control) {
						if (action === "throw")
							throw new Error("fixture finalization failed");
						await control.cancellable(async () => {
							started.resolve();
							await finish.promise;
						});
						observed = control.interruption();
						return result;
					},
				};
			},
		});
		const result = session.supervise(
			handle,
			task,
			new AbortController().signal,
		);
		adapter.complete(handle.id, { reason: "done", exitCode: 0 });
		if (action === "throw") {
			await assert.rejects(result, /fixture finalization failed/);
			return;
		}
		await started.promise;
		const cancellation =
			action === "cancelled" ? session.cancel(task.id) : undefined;
		if (action === "suppressed") session.suppress(task.id);
		finish.resolve();
		await cancellation;
		const settled = await result;
		assert.equal(observed, action === "natural" ? undefined : action);
		assert.equal(
			settled.outcome,
			action === "cancelled" ? "killed" : "completed",
		);
	});
}

test("a finalizer of a retryable result does not reopen a settlement it never acquired", async () => {
	const adapter = new FakeHarnessAdapter();
	let calls = 0;
	const session = createRunSession({ adapter, roles: [role], cwd: "/fixture" });
	const handle = await session.spawn(task, {
		role,
		persistent: false,
		candidates: [
			{ model: "fixture/one", thinking: "off" },
			{ model: "fixture/two", thinking: "off" },
		],
		async spawnAttempt(options) {
			const handle = await adapter.spawn(options);
			return {
				adapter,
				handle,
				async finalize(result, _task, control) {
					await control.cancellable(async () => {
						calls++;
					});
					return result;
				},
			};
		},
	});
	const result = session.supervise(handle, task);
	adapter.fail(handle.id, "fixture failure");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const next = session.getHandle(task.id);
	assert.ok(next);
	assert.notEqual(next.id, handle.id);
	adapter.complete(next.id, { reason: "done", exitCode: 0 });
	assert.equal((await result).outcome, "completed");
	assert.equal(calls, 2);
});
