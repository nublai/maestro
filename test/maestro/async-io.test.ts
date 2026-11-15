import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHarnessAdapter } from "../../maestro/adapters/fake/fake-harness-adapter.ts";
import type { Role, Task } from "../../maestro/core/types.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";

const role: Role = {
	name: "worker",
	version: "1",
	description: "test",
	systemPrompt: "",
	allowedTools: [],
};

const task: Task = {
	id: "uncertain",
	name: "uncertain",
	role: "worker",
	prompt: "test",
	cwd: "/repo",
	runtime: {
		model: "p/first",
		thinking: "off",
		fallbacks: [{ model: "p/second", thinking: "off" }],
	},
};

test("an uncertain remote mutation never advances the model shortlist", async () => {
	const adapter = new FakeHarnessAdapter();
	let attempts = 0;
	adapter.spawn = async () => {
		attempts++;
		throw Object.assign(new Error("remote mutation uncertain"), {
			code: "PIHA_ACQUISITION_UNCERTAIN",
			uncertainty: { kind: "surface-create", placement: "tab" },
		});
	};
	const session = createRunSession({ adapter, roles: [role], cwd: "/repo" });
	await assert.rejects(session.spawn(task), /uncertain/);
	assert.equal(attempts, 1);
});
