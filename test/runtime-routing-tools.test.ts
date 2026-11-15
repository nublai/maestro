import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createModelRegistryAdapter,
	type RoutingModel,
} from "../maestro/core/routing.ts";
import { wrapPiModelRegistry } from "../maestro/adapters/pi/model-registry.ts";
import { wrapPiModelRegistry as wrapHostModelRegistry } from "../pi-extension/subagents/model-registry.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";

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

const registryFactories = [
	[
		"core",
		(source: import("../maestro/core/routing.ts").RoutingRegistrySource) =>
			createModelRegistryAdapter(source, {
				supportedThinkingLevels: () => ["off", "low"],
				clampThinkingLevel: (_model, level) => level,
			}),
	],
	["adapter", wrapPiModelRegistry],
	["host", wrapHostModelRegistry],
] as const;

for (const [owner, factory] of registryFactories) {
	describe(`Task15 ${owner} registry query contract`, () => {
		it("keeps construction lazy, raw receivers, direct precedence and live source identity", () => {
			const first = model("", "", {
				thinkingLevelMap: { high: null },
				cost: { input: 7 },
			});
			const duplicate = model("", "", { cost: { input: 99 } });
			let current = first;
			const calls: string[] = [];
			const source = {
				find(provider: string, id: string) {
					assert.equal(this, source);
					calls.push(`find:${provider}/${id}`);
					return current;
				},
				getAvailable() {
					assert.equal(this, source);
					calls.push("available");
					return [current, duplicate, { provider: 2 }];
				},
				getAll() {
					assert.fail("direct nonempty must not fall back");
				},
				hasConfiguredAuth(raw: RoutingModel) {
					assert.equal(this, source);
					assert.equal(raw, current);
					calls.push("auth");
					return true;
				},
			};
			const port = factory(source);
			assert.deepEqual(calls, []);
			const [selected] = port.available();
			assert.equal(selected.provider, "");
			assert.equal(selected.id, "");
			assert.equal(selected.cost, first.cost);
			assert.equal(selected.thinkingLevelMap, first.thinkingLevelMap);
			assert.deepEqual(calls, ["available"]);
			assert.equal(port.hasConfiguredAuth(selected), true);
			assert.deepEqual(calls, ["available", "find:/", "auth"]);
			const before = [...calls];
			port.supportedThinkingLevels(selected);
			port.clampThinkingLevel(selected, "medium");
			assert.deepEqual(calls, before, "capabilities must not query raw source");
			current = duplicate;
			assert.equal(port.find("", "")!.cost, duplicate.cost);
			assert.equal(port.hasConfiguredAuth(selected), true);
			assert.deepEqual(calls.slice(-3), ["find:/", "find:/", "auth"]);
		});
		it("does not rescue nonempty invalid direct results with getAll", () => {
			const calls: string[] = [];
			const port = factory({
				find: () => undefined,
				getAvailable() {
					calls.push("available");
					return [null, { id: 3 }];
				},
				getAll() {
					assert.fail("forbidden rescue");
				},
			});
			assert.deepEqual(port.available(), []);
			assert.deepEqual(calls, ["available"]);
		});
		it("authenticates raw fallback duplicates before first-seen deduplication", () => {
			const one = model("p", "one"),
				duplicate = model("p", "one"),
				denied = model("p", "denied"),
				two = model("p", "two");
			const calls: unknown[] = [];
			const source = {
				find() {
					assert.equal(this, source);
					calls.push("find");
					return undefined;
				},
				getAvailable() {
					assert.equal(this, source);
					calls.push("available");
					return [];
				},
				getAll() {
					assert.equal(this, source);
					calls.push("all");
					return [null, one, denied, duplicate, two];
				},
				hasConfiguredAuth(raw: RoutingModel) {
					assert.equal(this, source);
					calls.push(raw);
					return raw !== denied;
				},
			};
			const port = factory(source);
			assert.deepEqual(calls, []);
			assert.deepEqual(
				port.available().map((m) => m.id),
				["one", "two"],
			);
			assert.deepEqual(calls, [
				"available",
				"all",
				one,
				denied,
				duplicate,
				two,
			]);
			assert.equal(port.hasConfiguredAuth(one), false);
			assert.equal(calls.at(-1), "find");
		});
		it("preserves absent methods and exact getAvailable authentication without getAll rescue", () => {
			const bare = factory({ find: () => undefined });
			assert.deepEqual(bare.available(), []);
			assert.equal(bare.hasConfiguredAuth({ provider: "p", id: "one" }), false);
			let direct = [model("p", "one")];
			const calls: string[] = [];
			const port = factory({
				find: () => undefined,
				getAvailable() {
					calls.push("available");
					return direct;
				},
				getAll() {
					assert.fail("auth must not rescue from all");
				},
			});
			assert.equal(port.hasConfiguredAuth({ provider: "p", id: "one" }), true);
			direct = [model("other", "one")];
			assert.equal(port.hasConfiguredAuth({ provider: "p", id: "one" }), false);
			assert.deepEqual(calls, ["available", "available"]);
		});
	});
}

describe("Task15 SDK boundary equivalence", () => {
	it("uses real sparse/null SDK levels, upward clamp and nonreasoning off", () => {
		const cases: [
			RoutingModel,
			import("../maestro/core/types.ts").ThinkingLevel[],
			import("../maestro/core/types.ts").ThinkingLevel,
		][] = [
			[
				model("p", "sparse", {
					thinkingLevelMap: {
						minimal: null,
						low: null,
						medium: null,
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				}),
				["off", "high", "xhigh", "max"],
				"high",
			],
			[model("p", "plain", { reasoning: false }), ["off"], "off"],
		];
		for (const [candidate, supported, clamped] of cases) {
			const answers = [];
			for (const wrap of [wrapPiModelRegistry, wrapHostModelRegistry]) {
				let queries = 0;
				const port = wrap({
					find() {
						queries++;
						return candidate;
					},
				});
				const selected = port.find(candidate.provider, candidate.id)!;
				answers.push([
					port.supportedThinkingLevels(selected),
					port.clampThinkingLevel(selected, "medium"),
				]);
				assert.equal(queries, 1);
			}
			assert.deepEqual(answers, [
				[supported, clamped],
				[supported, clamped],
			]);
		}
	});
	it("pins both full SDK conversion bodies to the original defaults and filter", () => {
		const original = `function asPiModel(model: RoutingModel): Model<any> {
	return {
		provider: model.provider,
		id: model.id,
		name: model.id,
		api: "openai-completions",
		baseUrl: "",
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input?.filter(
			(entry): entry is "text" | "image" =>
				entry === "text" || entry === "image",
		) ?? ["text"],
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0,
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
	};
}`;
		function body(source: string) {
			const file = ts.createSourceFile(
				"registry.ts",
				source,
				ts.ScriptTarget.Latest,
				true,
			);
			const declaration = file.statements.find(
				(s) => ts.isFunctionDeclaration(s) && s.name?.text === "asPiModel",
			);
			assert.ok(
				declaration &&
					ts.isFunctionDeclaration(declaration) &&
					declaration.body,
			);
			return ts
				.createPrinter({ removeComments: true })
				.printNode(ts.EmitHint.Unspecified, declaration.body, file);
		}
		for (const path of [
			"../maestro/adapters/pi/model-registry.ts",
			"../pi-extension/subagents/model-registry.ts",
		]) {
			assert.equal(
				body(readFileSync(new URL(path, import.meta.url), "utf8")),
				body(original),
				path,
			);
		}
	});
});
