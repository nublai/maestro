import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskThinkingPreferences } from "../../maestro/core/config/task-model-types.ts";
import {
	buildAuthenticatedModelCatalog,
	buildScopedModelCatalog,
	resolveRuntimePlans,
	type RuntimeRequest,
} from "../../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../../pi-extension/subagents/model-registry.ts";
import { buildSubagentRoutingGuidelines } from "../../pi-extension/subagents/catalog.ts";

const models = [
	{
		provider: "p",
		id: "full",
		reasoning: true,
		thinkingLevelMap: { max: "max", xhigh: "xhigh" },
	},
	{
		provider: "p",
		id: "limited",
		reasoning: true,
		thinkingLevelMap: { xhigh: null, max: null },
	},
	{ provider: "p", id: "plain", reasoning: false },
];

const registry = wrapPiModelRegistry({
	find: (provider, id) =>
		models.find((model) => model.provider === provider && model.id === id),
	getAvailable: () => models,
	hasConfiguredAuth: () => true,
});

const parent = { provider: "p", modelId: "full", thinking: "medium" as const };

const tasks = { coding: models.map((model) => `p/${model.id}`) };

function plans(
	request: RuntimeRequest = { model: "task:coding" },
	role: RuntimeRequest = { thinking: "low" },
	thinking: TaskThinkingPreferences = { coding: "max" },
) {
	return resolveRuntimePlans(
		request,
		role,
		parent,
		registry,
		tasks,
		false,
		thinking,
	);
}

describe("task-category thinking", () => {
	it("conditions thinking omission on the category having configured thinking", () => {
		assert.match(
			buildSubagentRoutingGuidelines("catalog", tasks).join("\n"),
			/Omit thinking on task:<category> only when that category has configured thinking/,
		);
	});

	it("escapes saved model refs instead of injecting extra catalog lines", () => {
		const id = "model\nInjected:\u001b[31m\u202e";
		const hostile = wrapPiModelRegistry({
			find: () => ({ provider: "p", id, reasoning: false }),
			getAvailable: () => [{ provider: "p", id, reasoning: false }],
			hasConfiguredAuth: () => true,
		});
		const catalog = buildAuthenticatedModelCatalog(hostile, 24, {
			coding: [`p/${id}`],
		});
		assert.doesNotMatch(catalog, /\nInjected:/);
		assert.ok(catalog.includes("p/model\\nInjected:\\u001b[31m\\u202e"));
	});

	it("clamps category thinking independently for every candidate and records the source", () => {
		assert.deepEqual(
			plans().map((plan) => [
				plan.model,
				plan.thinking,
				plan.thinkingSource,
				plan.requestedThinking,
				plan.thinkingAdjustment,
			]),
			[
				["p/full", "max", "task", "max", undefined],
				[
					"p/limited",
					"high",
					"task",
					"max",
					{ from: "max", to: "high", reason: "task-clamp" },
				],
				[
					"p/plain",
					"off",
					"task",
					"max",
					{ from: "max", to: "off", reason: "task-clamp" },
				],
			],
		);
	});

	it("resolves explicit before category, category before role, and role before parent", () => {
		const explicit = plans({ model: "task:coding", thinking: "off" });
		assert.ok(
			explicit.every(
				(plan) => plan.thinking === "off" && plan.thinkingSource === "request",
			),
		);
		const role = plans(undefined, { thinking: "off" }, {});
		assert.ok(
			role.every(
				(plan) => plan.thinking === "off" && plan.thinkingSource === "agent",
			),
		);
		const inherited = plans(undefined, {}, {});
		assert.deepEqual(
			inherited.map((plan) => [plan.thinking, plan.thinkingSource]),
			[
				["medium", "parent"],
				["medium", "parent"],
				["off", "parent"],
			],
		);
		assert.throws(
			() => plans({ model: "task:coding", thinking: "max" }),
			/not supported/,
		);
		assert.throws(
			() => plans(undefined, { thinking: "max" }, {}),
			/not supported/,
		);
	});

	it("does not apply category thinking to exact refs and respects worktree selection", () => {
		const [exact] = plans({ model: "p/full" });
		assert.equal(exact.thinking, "low");
		assert.equal(exact.thinkingSource, "agent");
		const worktree = resolveRuntimePlans(
			{ model: "task:coding" },
			{},
			parent,
			registry,
			tasks,
			true,
			{ coding: "max" },
		);
		assert.equal(worktree.length, 1);
		assert.equal(worktree[0].thinking, "max");
	});

	it("shows category thinking in both authenticated and scoped catalogs", () => {
		assert.match(
			buildAuthenticatedModelCatalog(registry, 24, tasks, { coding: "max" }),
			/coding: .*thinking: max \(clamped per candidate\)/,
		);
		assert.match(
			buildScopedModelCatalog(registry, models, tasks, 24, { coding: "high" }),
			/coding: .*thinking: high \(clamped per candidate\)/,
		);
	});
});
