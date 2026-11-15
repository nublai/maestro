import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as routing from "../maestro/core/routing.ts";

const models: routing.RoutingModel[] = [
	{
		provider: "fixture",
		id: "parent",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 2_000_000,
		maxTokens: 123,
	},
	{
		provider: "fixture",
		id: "plain",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 32_000,
	},
	{ provider: "fixture", id: "denied", reasoning: true },
];
test("inherited generic scopes never widen a child model scope", () => {
	assert.equal(routing.formatInheritedModelScope(undefined), "");
	assert.equal(
		routing.formatInheritedModelScope(["fixture/parent"]),
		'["fixture/parent"]',
	);
	assert.equal(routing.parseInheritedModelScope(undefined), undefined);
	assert.deepEqual(routing.parseInheritedModelScope("{invalid"), []);
	assert.deepEqual(routing.parseInheritedModelScope("[1]"), []);
	assert.deepEqual(routing.parseInheritedModelScope('["fixture/parent"]'), [
		"fixture/parent",
	]);
	assert.equal(routing.sessionModelScope([], undefined), undefined);
	assert.deepEqual(routing.sessionModelScope(["fixture/parent"], undefined), [
		"fixture/parent",
	]);
	assert.deepEqual(routing.sessionModelScope([], '["fixture/plain"]'), [
		"fixture/plain",
	]);
	assert.deepEqual(
		routing.sessionModelScope(
			["fixture/parent", "fixture/plain"],
			'["fixture/plain"]',
		),
		["fixture/plain"],
	);
});

const capabilities = {
	supportedThinkingLevels: (
		model: routing.RoutingModel,
	): routing.ThinkingLevel[] => (model.reasoning ? ["off", "low"] : ["off"]),
	clampThinkingLevel: (model: routing.RoutingModel): routing.ThinkingLevel =>
		model.reasoning ? "low" : "off",
};
const parent: routing.ParentRuntime = {
	provider: "fixture",
	modelId: "parent",
	thinking: "medium",
};
function registry() {
	return routing.createModelRegistryAdapter(
		{
			find(provider, id) {
				return models.find((m) => m.provider === provider && m.id === id);
			},
			getAvailable: () => models,
			hasConfiguredAuth: (model) => model.id !== "denied",
		},
		capabilities,
	);
}

test("generic registry adapters retain raw receivers, auth fallback, deduplication and injected capabilities", () => {
	const source = {
		find(provider: string, id: string) {
			assert.equal(this, source);
			return models.find((m) => m.provider === provider && m.id === id);
		},
		getAll() {
			assert.equal(this, source);
			return [null, ...models, models[0], { id: 3 }];
		},
		hasConfiguredAuth(model: routing.RoutingModel) {
			assert.equal(this, source);
			return model.id !== "denied";
		},
	};
	const port = routing.createModelRegistryAdapter(source, capabilities);
	assert.deepEqual(
		port.available().map((m) => m.id),
		["parent", "plain"],
	);
	assert.equal(port.find("fixture", "missing"), undefined);
	assert.equal(port.hasConfiguredAuth(models[0]), true);
	assert.equal(
		port.hasConfiguredAuth({ provider: "missing", id: "missing" }),
		false,
	);
	assert.deepEqual(port.supportedThinkingLevels(models[0]), ["off", "low"]);
	assert.equal(port.clampThinkingLevel(models[1], "high"), "off");
	const bare = routing.createModelRegistryAdapter(
		{ find: () => undefined },
		capabilities,
	);
	assert.deepEqual(bare.available(), []);
	assert.equal(bare.hasConfiguredAuth(models[0]), false);
	const direct = routing.createModelRegistryAdapter(
		{ find: () => undefined, getAvailable: () => models },
		capabilities,
	);
	assert.equal(direct.hasConfiguredAuth(models[0]), true);
	assert.equal(
		direct.hasConfiguredAuth({ provider: "other", id: "parent" }),
		false,
	);
	const scoped = routing.scopeModelRegistryAdapter(
		port,
		new Set(["fixture/plain"]),
	);
	assert.deepEqual(routing.modelScopeOf(scoped), ["fixture/plain"]);
	assert.equal(scoped.find("fixture", "parent"), undefined);
	assert.equal(scoped.find("fixture", "plain")?.id, "plain");
	assert.deepEqual(
		scoped.available().map((m) => m.id),
		["plain"],
	);
	assert.equal(scoped.hasConfiguredAuth(models[1]), true);
	assert.deepEqual(scoped.supportedThinkingLevels(models[1]), ["off"]);
	assert.equal(scoped.clampThinkingLevel(models[1], "high"), "off");
	assert.throws(
		() => routing.assertModelInScope("fixture/parent", scoped),
		/outside this session/,
	);
	routing.assertModelInScope("fixture/plain", scoped);
	routing.assertModelInScope("fixture/parent", port);
});

test("generic routing validates exact refs, defaults, every fallback, scope and task candidate plans", () => {
	const port = registry();
	assert.equal(routing.parseExactModelRef("missing"), undefined);
	assert.equal(routing.parseExactModelRef("x/ "), undefined);
	assert.deepEqual(routing.parseExactModelRef(" fixture/ nested/model "), {
		provider: "fixture",
		modelId: "nested/model",
	});
	assert.equal(
		routing.resolveRuntimePlan({}, {}, parent, port).thinkingAdjustment?.reason,
		"inherited-clamp",
	);
	assert.equal(
		routing.resolveRuntimePlan({ model: "fixture/plain" }, {}, parent, port)
			.thinkingAdjustment?.reason,
		"non-reasoning",
	);
	assert.equal(
		routing.resolveRuntimePlan(
			{},
			{ model: "fixture/plain", thinking: "off" },
			parent,
			port,
		).thinkingSource,
		"agent",
	);
	assert.equal(
		routing.resolveRuntimePlan({ thinking: "low" }, {}, parent, port)
			.thinkingSource,
		"request",
	);
	for (const model of ["fuzzy", "missing/model", "fixture/denied"])
		assert.throws(
			() => routing.resolveRuntimePlan({ model }, {}, parent, port),
			routing.RuntimeResolutionError,
		);
	assert.throws(
		() => routing.resolveRuntimePlan({ thinking: "high" }, {}, parent, port),
		/not supported/,
	);
	assert.throws(
		() =>
			routing.resolveRuntimePlan(
				JSON.parse('{"thinking":"impossible"}'),
				{},
				parent,
				port,
			),
		/must be one of/,
	);
	const empty = routing.createModelRegistryAdapter(
		{ find: () => undefined },
		capabilities,
	);
	assert.throws(
		() => routing.resolveRuntimePlan({ thinking: "low" }, {}, parent, empty),
		/capability information/,
	);
	assert.equal(
		routing.resolveRuntimePlan({}, {}, parent, empty).thinking,
		"medium",
	);
	const scoped = routing.scopeModelRegistryAdapter(port, new Set<string>());
	assert.throws(
		() => routing.resolveRuntimePlan({}, {}, parent, scoped),
		/cannot inherit/,
	);
	assert.throws(
		() =>
			routing.resolveRuntimePlan({ thinking: "low" }, {}, parent, {
				...port,
				supportedThinkingLevels: () => [],
			}),
		/supported: \(none\)/,
	);
	assert.throws(
		() => routing.parseModelFallbacks("fixture/parent,"),
		/empty candidate/,
	);
	assert.equal(routing.resolveRuntimePlans({}, {}, parent, port).length, 1);
	assert.equal(
		routing.resolveRuntimePlans(
			{ model: "fixture/parent, fixture/plain" },
			{},
			parent,
			port,
		).length,
		2,
	);
	assert.equal(
		routing.resolveRuntimePlans({}, { model: "fixture/plain" }, parent, port)[0]
			.modelSource,
		"agent",
	);
	for (const model of ["task:coding,fixture/plain", "task:", "task:missing"])
		assert.throws(
			() =>
				routing.resolveRuntimePlans({ model }, {}, parent, port, {
					coding: ["fixture/plain"],
				}),
			routing.RuntimeResolutionError,
		);
	assert.throws(
		() =>
			routing.resolveRuntimePlans({}, { model: "task:coding" }, parent, port, {
				coding: ["fixture/plain"],
			}),
		/only valid/,
	);
	assert.throws(
		() =>
			routing.resolveRuntimePlans({ model: "task:coding" }, {}, parent, empty, {
				coding: ["invalid", "fixture/plain"],
			}),
		/no authenticated candidates/,
	);
	assert.throws(
		() =>
			routing.resolveRuntimePlans({ model: "task:coding" }, {}, parent, port, {
				coding: ["fixture/denied"],
			}),
		/no authenticated candidates/,
	);
	const plans = routing.resolveRuntimePlans(
		{ model: "task:coding" },
		{},
		parent,
		port,
		{
			coding: ["fixture/parent", "fixture/plain", "fixture/denied", "invalid"],
		},
		false,
		{ coding: "high" },
	);
	assert.deepEqual(
		plans.map((p) => p.thinkingAdjustment?.reason),
		["task-clamp", "task-clamp"],
	);
	assert.equal(
		routing.resolveRuntimePlans(
			{ model: "task:coding" },
			{},
			parent,
			port,
			{ coding: ["fixture/parent", "fixture/plain"] },
			true,
		).length,
		1,
	);
});

test("generic model catalogs retain full scope, counts, shortlists, thinking facts and omission tails", () => {
	const port = registry();
	const catalog = routing.buildAuthenticatedModelCatalog(port);
	assert.match(
		catalog,
		/reasoning \(off\/low\), text\+image, 2m context, 123 max output/,
	);
	assert.match(catalog, /non-reasoning, text, 128k context, 32k max output/);
	assert.match(
		routing.buildAuthenticatedModelCatalog(port, 1),
		/1 more authenticated models omitted/,
	);
	const shortlists = {
		coding: ["fixture/parent"],
		review: ["fixture/plain", "fixture/denied", "bad"],
	};
	assert.deepEqual(routing.getAuthenticatedTaskPreferences(port, shortlists), {
		coding: ["fixture/parent"],
		review: ["fixture/plain"],
	});
	assert.match(
		routing.buildAuthenticatedModelCatalog(
			port,
			0,
			{ coding: ["fixture/parent"] },
			{ coding: "high" },
		),
		/Shortlisted model capabilities/,
	);
	assert.match(
		routing.buildAuthenticatedModelCatalog(port, 1, {
			coding: ["fixture/parent"],
		}),
		/Other authenticated model IDs: fixture\/plain/,
	);
	assert.match(
		routing.buildAuthenticatedModelCatalog(port, 24, {
			coding: ["fixture/parent", "fixture/plain"],
		}),
		/thinking: role, then parent/,
	);
	assert.match(
		routing.buildAuthenticatedModelCatalog({ ...port, available: () => [] }),
		/none discovered/,
	);
	assert.match(
		routing.buildScopedModelCatalog(
			port,
			[models[0], models[1], models[0]],
			shortlists,
			1,
		),
		/1 more scoped models omitted/,
	);
	assert.match(
		routing.buildScopedModelCatalog(port, [], undefined),
		/none discovered/,
	);
	assert.match(
		routing.buildAuthenticatedModelCatalog({
			...port,
			supportedThinkingLevels: () => [],
			hasConfiguredAuth: () => true,
			available: () => [
				{ provider: "x", id: "small", reasoning: true, contextWindow: 0 },
			],
		}),
		/no thinking levels/,
	);
});
