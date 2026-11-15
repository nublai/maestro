import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RuntimeResolutionError,
	buildAuthenticatedModelCatalog,
	buildScopedModelCatalog,
	getAuthenticatedTaskPreferences,
	resolveRuntimePlan,
	resolveRuntimePlans,
	scopeModelRegistryAdapter,
	type ParentRuntime,
	type RoutingModel,
	type RuntimeRequest,
} from "../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";

const parent: ParentRuntime = {
	provider: "fake",
	modelId: "parent",
	thinking: "medium",
};

function model(
	provider: string,
	id: string,
	overrides: Partial<RoutingModel> = {},
) {
	return {
		provider,
		id,
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

function normalized(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

const ordinaryReviewClauses = [
	"For ordinary review, prefer a different authenticated model family.",
	"When no other authenticated model family is available, ordinary review may use a same-family reviewer in a fresh standalone session.",
	"Disclose that this review is context-isolated, not cross-family independent.",
	"Cross-family verification must not use this fallback.",
];

function registry(entries = [model("fake", "parent"), model("other", "fast")]) {
	const byRef = new Map(
		entries.map((entry) => [`${entry.provider}/${entry.id}`, entry]),
	);
	return wrapPiModelRegistry({
		find(provider: string, modelId: string) {
			return byRef.get(`${provider}/${modelId}`);
		},
		getAvailable() {
			return entries;
		},
		getAll() {
			return entries;
		},
		hasConfiguredAuth(candidate: { provider: string; id: string }) {
			return (
				byRef.has(`${candidate.provider}/${candidate.id}`) &&
				candidate.id !== "unauthed"
			);
		},
	});
}

function resolve(request: RuntimeRequest = {}, defaults: RuntimeRequest = {}) {
	return resolveRuntimePlan(request, defaults, parent, registry());
}

describe("runtime routing", () => {
	it("inherits the parent model and thinking when no override is requested", () => {
		assert.deepEqual(resolve(), {
			provider: "fake",
			modelId: "parent",
			model: "fake/parent",
			thinking: "medium",
			modelSource: "parent",
			thinkingSource: "parent",
		});
	});

	it("resolves tool-call fields over agent defaults independently", () => {
		assert.deepEqual(
			resolve({ thinking: "high" }, { model: "other/fast", thinking: "low" }),
			{
				provider: "other",
				modelId: "fast",
				model: "other/fast",
				thinking: "high",
				modelSource: "agent",
				thinkingSource: "request",
				requestedModel: "other/fast",
				requestedThinking: "high",
			},
		);
	});

	it("parses exact model references at the first slash", () => {
		const nested = model("other", "family/reasoner");
		const plan = resolveRuntimePlan(
			{ model: "other/family/reasoner" },
			{},
			parent,
			registry([model("fake", "parent"), nested]),
		);
		assert.equal(plan.provider, "other");
		assert.equal(plan.modelId, "family/reasoner");
	});

	it("rejects fuzzy, unknown, and unauthenticated explicit models", () => {
		for (const request of [
			{ model: "fast" },
			{ model: "other/missing" },
			{ model: "other/unauthed" },
		]) {
			const entries = [model("fake", "parent"), model("other", "unauthed")];
			assert.throws(
				() => resolveRuntimePlan(request, {}, parent, registry(entries)),
				RuntimeResolutionError,
			);
		}
	});

	it("resolves trimmed fallback candidates in declaration order", () => {
		const plans = resolveRuntimePlans(
			{ model: " other/fast , fake/parent " },
			{},
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => [plan.model, plan.modelSource]),
			[
				["other/fast", "request"],
				["fake/parent", "request"],
			],
		);
	});

	it("validates every fallback before launch", () => {
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "other/fast, other/missing" },
					{},
					parent,
					registry(),
				),
			/unknown model "other\/missing"/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans({ model: "other/fast," }, {}, parent, registry()),
			/cannot contain an empty candidate/,
		);
	});

	it("expands whole-value task references using authenticated configured order", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "worker"),
			model("other", "backup"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/worker", "other/unauthed", "other/backup"],
		};
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: " task:CoDiNg " },
				{},
				parent,
				registry(entries),
				tasks,
			).map((plan) => plan.model),
			["other/worker", "other/backup"],
		);
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "task:coding" },
				{},
				parent,
				registry(entries),
				tasks,
				true,
			).map((plan) => plan.model),
			["other/worker"],
		);
		for (const modelReference of [
			"task:coding, other/backup",
			"other/backup, task:coding",
		]) {
			assert.throws(
				() =>
					resolveRuntimePlans(
						{ model: modelReference },
						{},
						parent,
						registry(entries),
						tasks,
					),
				/must be the entire model value/,
			);
		}
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:qa" },
					{},
					parent,
					registry(entries),
					tasks,
				),
			/configured categories: coding/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{},
					{ model: "task:coding" },
					parent,
					registry(entries),
					tasks,
				),
			/only valid in the subagent tool's model parameter/,
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:coding" },
					{},
					parent,
					registry([model("fake", "parent"), model("other", "unauthed")]),
					{ coding: ["other/unauthed"] },
				),
			/task category "coding" has no authenticated candidates; authenticated alternatives: fake\/parent/,
		);
	});

	it("hides out-of-scope models while delegating capability helpers", () => {
		const entries = [
			model("fake", "parent"),
			model("zai", "glm-5.3"),
			model("other", "fast", { reasoning: false }),
		];
		const scoped = scopeModelRegistryAdapter(
			registry(entries),
			new Set(["fake/parent", "zai/glm-5.3"]),
		);
		assert.equal(scoped.find("other", "fast"), undefined);
		assert.equal(scoped.find("zai", "glm-5.3")?.id, "glm-5.3");
		assert.deepEqual(
			scoped.available().map((entry) => `${entry.provider}/${entry.id}`),
			["fake/parent", "zai/glm-5.3"],
		);
		assert.equal(
			scoped.hasConfiguredAuth(model("other", "fast")),
			true,
			"auth checks delegate to the underlying registry unfiltered",
		);
		assert.ok(
			scoped.supportedThinkingLevels(entries[0]).length > 0,
			"thinking capabilities delegate to the underlying registry",
		);
		assert.equal(scoped.clampThinkingLevel(entries[2], "high"), "off");
	});

	it("scopes task expansion and exact refs to the session's scoped models", () => {
		const entries = [
			model("fake", "parent"),
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
			model("other", "fast"),
		];
		const tasks = {
			coding: ["other/fast", "zai/glm-5.3"],
			review: ["other/fast"],
		};
		const scoped = scopeModelRegistryAdapter(
			registry(entries),
			new Set(["fake/parent", "zai/glm-5.3", "zai/glm-5.3-flash"]),
		);
		assert.deepEqual(
			resolveRuntimePlans(
				{ model: "task:coding" },
				{},
				parent,
				scoped,
				tasks,
			).map((plan) => plan.model),
			["zai/glm-5.3"],
			"scoped task expansion must skip out-of-scope candidates",
		);
		assert.throws(
			() =>
				resolveRuntimePlans(
					{ model: "task:review" },
					{},
					parent,
					scoped,
					tasks,
				),
			/task category "review" has no authenticated candidates; authenticated alternatives: fake\/parent, zai\/glm-5.3, zai\/glm-5.3-flash/,
		);
		assert.throws(
			() => resolveRuntimePlans({ model: "other/fast" }, {}, parent, scoped),
			/unknown model "other\/fast"; exact registry match required\. Available: fake\/parent, zai\/glm-5.3, zai\/glm-5.3-flash/,
		);
		assert.equal(
			resolveRuntimePlans({}, {}, parent, scoped)[0]?.model,
			"fake/parent",
			"parent-inherit resolution stays available for the in-scope parent model",
		);
	});

	it("refuses to inherit an out-of-scope parent model with an actionable error", () => {
		const scoped = scopeModelRegistryAdapter(
			registry([model("fake", "parent"), model("zai", "glm-5.3")]),
			new Set(["zai/glm-5.3"]),
		);
		for (const thinking of [undefined, "low" as const])
			assert.throws(
				() => resolveRuntimePlans({ thinking }, {}, parent, scoped),
				{
					name: "RuntimeResolutionError",
					message:
						'the parent model "fake/parent" is outside this session\'s model scope (--models / enabledModels: zai/glm-5.3), so a subagent cannot inherit it. Pass model with an in-scope exact provider/model-id or a task: category, set model in the role definition, or switch the parent to an in-scope model with /model',
				},
			);
		assert.equal(
			resolveRuntimePlans({ model: "zai/glm-5.3" }, {}, parent, scoped)[0]
				?.model,
			"zai/glm-5.3",
			"an explicit in-scope model still launches from an out-of-scope parent",
		);
		assert.equal(
			resolveRuntimePlan({}, {}, parent, registry([]))?.model,
			"fake/parent",
			"an unscoped session keeps inheriting an unlisted parent model",
		);
	});
	it("keeps the selected source when agent defaults provide fallbacks", () => {
		const plans = resolveRuntimePlans(
			{},
			{ model: "other/fast, fake/parent" },
			parent,
			registry(),
		);
		assert.deepEqual(
			plans.map((plan) => plan.modelSource),
			["agent", "agent"],
		);
	});

	it("rejects unsupported explicit thinking with supported alternatives", () => {
		const plain = model("other", "plain", { reasoning: false });
		assert.throws(
			() =>
				resolveRuntimePlan(
					{ model: "other/plain", thinking: "high" },
					{},
					parent,
					registry([model("fake", "parent"), plain]),
				),
			/thinking "high" is not supported.*supported: off/,
		);
	});

	it("uses agent-default thinking when the request omits it", () => {
		const plan = resolveRuntimePlan(
			{},
			{ thinking: "low" },
			parent,
			registry(),
		);
		assert.equal(plan.thinking, "low");
		assert.equal(plan.thinkingSource, "agent");
		assert.equal(plan.requestedThinking, "low");
	});

	it("clamps inherited thinking for a reasoning model with a sparse level map", () => {
		const sparse = model("other", "sparse", {
			thinkingLevelMap: {
				off: "off",
				minimal: "minimal",
				low: "low",
				medium: null,
				high: "high",
			},
		});
		const plan = resolveRuntimePlan(
			{ model: "other/sparse" },
			{},
			parent,
			registry([model("fake", "parent"), sparse]),
		);
		assert.equal(plan.thinking, "high");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "high",
			reason: "inherited-clamp",
		});
	});

	it("clamps inherited thinking for a non-reasoning selected model", () => {
		const plain = model("other", "plain", { reasoning: false });
		const plan = resolveRuntimePlan(
			{ model: "other/plain" },
			{},
			parent,
			registry([model("fake", "parent"), plain]),
		);
		assert.equal(plan.thinking, "off");
		assert.equal(plan.thinkingSource, "parent");
		assert.deepEqual(plan.thinkingAdjustment, {
			from: "medium",
			to: "off",
			reason: "non-reasoning",
		});
	});
});

describe("authenticated model catalog", () => {
	it("lists exact authenticated IDs with concise capability facts", () => {
		const available = [
			model("fake", "parent", {
				input: ["text", "image"],
				contextWindow: 200_000,
			}),
			model("other", "plain", {
				reasoning: false,
				cost: { input: 0, output: 0 },
			}),
		];
		const catalog = buildAuthenticatedModelCatalog(registry(available));
		assert.match(catalog, /fake\/parent/);
		assert.match(catalog, /reasoning \(off\/minimal\/low\/medium\/high\)/);
		assert.match(catalog, /text\+image/);
		assert.match(catalog, /200k context/);
		assert.match(catalog, /other\/plain/);
		assert.match(catalog, /non-reasoning/);
	});

	it("keeps shortlisted capabilities and compact alternatives when categories are configured", () => {
		const entries = [
			model("fake", "parent"),
			model("other", "first"),
			model("other", "second"),
			model("third", "alternative"),
			model("other", "unauthed"),
		];
		const tasks = {
			coding: ["other/second", "other/unauthed", "other/first"],
			review: ["fake/parent"],
		};
		assert.deepEqual(
			getAuthenticatedTaskPreferences(registry(entries), tasks),
			{
				coding: ["other/second", "other/first"],
				review: ["fake/parent"],
			},
		);
		const catalog = buildAuthenticatedModelCatalog(
			registry(entries),
			24,
			tasks,
		);
		assert.match(catalog, /- coding: other\/second, other\/first/);
		assert.match(catalog, /- review: fake\/parent/);
		assert.doesNotMatch(catalog, /other\/unauthed/);
		assert.match(catalog, /^- other\/second — reasoning \(/m);
		assert.match(catalog, /^- other\/first — reasoning \(/m);
		assert.match(catalog, /^- fake\/parent — reasoning \(/m);
		assert.match(catalog, /Other authenticated model IDs: third\/alternative/);
		assert.doesNotMatch(catalog, /^- third\/alternative — /m);
		assert.doesNotMatch(catalog, /Authenticated subagent models/);
	});

	it("caps compact alternatives without repeating shortlisted model facts", () => {
		const entries = Array.from({ length: 8 }, (_, index) =>
			model("fake", `model-${index}`),
		);
		const catalog = buildAuthenticatedModelCatalog(registry(entries), 2, {
			coding: ["fake/model-0"],
			docs: ["fake/model-0"],
		});
		assert.equal((catalog.match(/^- fake\/model-0 — /gm) ?? []).length, 1);
		assert.match(
			catalog,
			/Other authenticated model IDs: fake\/model-1, fake\/model-2/,
		);
		assert.doesNotMatch(catalog, /fake\/model-3/);
		assert.match(catalog, /5 more authenticated models omitted/);
	});

	it("lists models when shortlists are empty, unconfigured, or unauthenticated", () => {
		for (const tasks of [undefined, {}, { coding: ["missing/model"] }]) {
			const catalog = buildAuthenticatedModelCatalog(registry(), 24, tasks);
			assert.match(catalog, /Authenticated subagent models/);
			assert.match(catalog, /^- fake\/parent — /m);
			assert.doesNotMatch(catalog, /Task-category shortlists/);
		}
	});

	it("caps large catalogs and reports omitted models", () => {
		const available = Array.from({ length: 30 }, (_, index) =>
			model("fake", `model-${index}`),
		);
		const catalog = buildAuthenticatedModelCatalog(registry(available), 5);
		assert.equal((catalog.match(/^- fake\//gm) ?? []).length, 5);
		assert.match(catalog, /25 more authenticated models omitted/);
	});

	it("builds an untruncated catalog from the scoped model set", () => {
		const available = [
			...Array.from({ length: 30 }, (_, index) =>
				model("fake", `model-${index}`),
			),
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
		];
		const catalog = buildScopedModelCatalog(registry(available), [
			model("zai", "glm-5.3-flash"),
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
		]);
		assert.match(catalog, /- zai\/glm-5.3 — /);
		assert.match(catalog, /- zai\/glm-5.3-flash — /);
		assert.equal(
			(catalog.match(/^- /gm) ?? []).length,
			2,
			"scoped catalogs dedupe refs and list the whole scoped set",
		);
		assert.doesNotMatch(catalog, /fake\//);
		assert.doesNotMatch(catalog, /more authenticated models omitted/);
	});

	it("keeps an upper bound on scoped catalogs behind an explicit tail", () => {
		const available = Array.from({ length: 30 }, (_, index) =>
			model("zai", `glm-${index}`),
		);
		const catalog = buildScopedModelCatalog(
			registry(available),
			available,
			undefined,
			5,
		);
		assert.equal((catalog.match(/^- zai\//gm) ?? []).length, 5);
		assert.match(catalog, /- … 25 more scoped models omitted/);
	});

	it("keeps only scoped shortlist candidates and drops emptied categories", () => {
		const entries = [
			model("zai", "glm-5.3"),
			model("zai", "glm-5.3-flash"),
			model("other", "fast"),
		];
		const tasks = {
			coding: ["zai/glm-5.3", "other/fast"],
			review: ["zai/glm-5.3-flash"],
			qa: ["other/fast"],
		};
		assert.deepEqual(
			getAuthenticatedTaskPreferences(
				scopeModelRegistryAdapter(
					registry(entries),
					new Set(["zai/glm-5.3", "zai/glm-5.3-flash"]),
				),
				tasks,
			),
			{ coding: ["zai/glm-5.3"], review: ["zai/glm-5.3-flash"] },
		);
		const catalog = buildScopedModelCatalog(
			scopeModelRegistryAdapter(
				registry(entries),
				new Set(["zai/glm-5.3", "zai/glm-5.3-flash"]),
			),
			[model("zai", "glm-5.3"), model("zai", "glm-5.3-flash")],
			tasks,
		);
		assert.match(
			catalog,
			/- coding: zai\/glm-5.3; thinking: role, then parent$/m,
		);
		assert.match(
			catalog,
			/- review: zai\/glm-5.3-flash; thinking: role, then parent$/m,
		);
		assert.doesNotMatch(catalog, /- qa:/);
		assert.doesNotMatch(catalog, /other\/fast/);
	});

	it("keeps the none-discovered shape for an empty scoped set", () => {
		const catalog = buildScopedModelCatalog(registry(), []);
		assert.match(catalog, /- none discovered; omitting model still inherits/);
	});

	it("leaves review and fallback policy to tool metadata in both catalog branches", () => {
		const catalogs = [
			[
				"shortlist",
				buildAuthenticatedModelCatalog(registry(), 24, {
					coding: ["other/fast"],
				}),
			],
			["generic", buildAuthenticatedModelCatalog(registry())],
		] as const;
		for (const [label, catalog] of catalogs) {
			const compact = normalized(catalog);
			for (const clause of ordinaryReviewClauses)
				assert.ok(
					!compact.includes(clause),
					`${label} catalog must not repeat: ${clause}`,
				);
			assert.doesNotMatch(compact, /discouraged fallback/, label);
			assert.doesNotMatch(compact, /For orchestrated children/, label);
		}
	});
});
