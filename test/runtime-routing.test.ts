import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildAuthenticatedModelCatalog,
	createModelRegistryAdapter,
	resolveRuntimePlan,
	type ParentRuntime,
	type RoutingModel,
} from "../maestro/core/routing.ts";

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

interface CapabilityCalls {
	supported: RoutingModel[];
	clamp: [RoutingModel, string][];
}

it("Task15 core attaches only capabilities without losing their receiver or eagerly querying", () => {
	const calls: RoutingModel[] = [];
	const capabilities = {
		marker: "private caller property",
		supportedThinkingLevels(
			candidate: RoutingModel,
		): import("../maestro/core/types.ts").ThinkingLevel[] {
			assert.equal(this, capabilities);
			calls.push(candidate);
			return ["max"];
		},
		clampThinkingLevel(
			candidate: RoutingModel,
			level: import("../maestro/core/types.ts").ThinkingLevel,
		) {
			assert.equal(this, capabilities);
			calls.push(candidate);
			return level;
		},
	};
	const port = createModelRegistryAdapter(
		{
			find() {
				assert.fail("no raw query during construction or capabilities");
			},
		},
		capabilities,
	);
	assert.deepEqual(calls, []);
	assert.equal(Object.hasOwn(port, "marker"), false);
	const candidate = model("p", "m");
	assert.deepEqual(port.supportedThinkingLevels(candidate), ["max"]);
	assert.equal(port.clampThinkingLevel(candidate, "low"), "low");
	assert.deepEqual(calls, [candidate, candidate]);
});

describe("injected routing capabilities", () => {
	function injected() {
		const selected = model("fake", "parent");
		const calls: CapabilityCalls = {
			supported: [],
			clamp: [],
		};
		const port = {
			find: (): RoutingModel | undefined => selected,
			available: () => [selected],
			hasConfiguredAuth: () => true,
			supportedThinkingLevels(candidate: RoutingModel): ("max" | "low")[] {
				calls.supported.push(candidate);
				return ["max", "low"];
			},
			clampThinkingLevel(candidate: RoutingModel, level: string): "low" {
				calls.clamp.push([candidate, level]);
				return "low";
			},
		};
		return { selected, calls, port };
	}

	it("accepts injected max rather than SDK defaults with exactly one capability call", () => {
		const f = injected();
		assert.equal(
			resolveRuntimePlan({ thinking: "max" }, {}, parent, f.port).thinking,
			"max",
		);
		assert.deepEqual(f.calls.supported, [f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});

	it("formats unsupported thinking with a second injected call", () => {
		const f = injected();
		assert.throws(
			() => resolveRuntimePlan({ thinking: "high" }, {}, parent, f.port),
			/supported: max, low$/,
		);
		assert.deepEqual(f.calls.supported, [f.selected, f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});

	it("clamps inherited medium through only the supplied clamp", () => {
		const f = injected();
		assert.equal(resolveRuntimePlan({}, {}, parent, f.port).thinking, "low");
		assert.deepEqual(f.calls.clamp, [[f.selected, "medium"]]);
		assert.deepEqual(f.calls.supported, []);
		f.port.find = () => undefined;
		assert.equal(resolveRuntimePlan({}, {}, parent, f.port).thinking, "medium");
		assert.equal(f.calls.clamp.length, 1);
	});

	it("uses injected catalog levels, including one call for nonreasoners", () => {
		const f = injected();
		assert.match(
			buildAuthenticatedModelCatalog(f.port),
			/reasoning \(max\/low\)/,
		);
		f.selected.reasoning = false;
		assert.match(buildAuthenticatedModelCatalog(f.port), /non-reasoning/);
		assert.deepEqual(f.calls.supported, [f.selected, f.selected]);
		assert.deepEqual(f.calls.clamp, []);
	});
});
