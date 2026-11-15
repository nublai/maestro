import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	parseModelConfig,
	readConfigRevision,
	writeTaskModelConfig,
} from "../../maestro/core/config/model-config.ts";
import type { TaskThinkingPreferences } from "../../maestro/core/config/task-model-types.ts";
import { THINKING_LEVELS } from "../../maestro/core/routing.ts";

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

const tasks = { coding: models.map((model) => `p/${model.id}`) };

const tasksMeta = {
	generatedAt: "2026-11-12T00:00:00Z",
	method: "registry-only" as const,
};

describe("task-category thinking", () => {
	it("keeps the packaged example compatible with legacy model parsers", () => {
		const example = JSON.parse(
			readFileSync(
				new URL("../../config.json.example", import.meta.url),
				"utf8",
			),
		);
		assert.equal(Object.hasOwn(example.models, "tasksThinking"), false);
	});

	it("parses every Pi level and leaves absent thinking absent", () => {
		for (const level of THINKING_LEVELS)
			assert.deepEqual(
				parseModelConfig({ models: { tasksThinking: { coding: level } } })
					.tasksThinking,
				{ coding: level },
			);
		assert.deepEqual(parseModelConfig({ models: { tasks } }), {
			agents: {},
			tasks,
		});
		assert.deepEqual(
			parseModelConfig({ models: { tasksThinking: {} } }).tasksThinking,
			{},
		);
		assert.equal(
			parseModelConfig({ models: { tasksThinking: null } }).tasksThinking,
			undefined,
		);
	});

	it("rejects invalid levels, maps and categories", () => {
		for (const tasksThinking of [
			[],
			"high",
			{ coding: "ultra" },
			{ coding: null },
			{ coding: 1 },
			{ coding: " high " },
			{ other: "high" },
		])
			assert.throws(
				() => parseModelConfig({ models: { tasksThinking } }),
				/models.tasksThinking/,
			);
	});

	it("writes models and thinking under one revision, preserves legacy thinking, and clears explicitly", () => {
		const dir = mkdtempSync(join(tmpdir(), "piha-thinking-"));
		try {
			const config = join(dir, "config.json");
			const example = join(dir, "example.json");
			writeFileSync(
				example,
				JSON.stringify({ status: { enabled: false }, models: { agents: {} } }),
			);
			const save = (tasksThinking?: TaskThinkingPreferences) =>
				writeTaskModelConfig(config, example, tasks, tasksMeta, () => true, {
					tasksThinking,
					expectedConfigRevision: readConfigRevision(config),
				});
			const saved = save({ coding: "max" });
			assert.deepEqual(saved.tasksThinking, { coding: "max" });
			assert.equal(saved.configRevision, readConfigRevision(config));
			assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), {
				status: { enabled: true },
				models: {
					tasks,
					tasksThinking: { coding: "max" },
					tasksMeta,
				},
			});
			assert.deepEqual(save().tasksThinking, { coding: "max" });
			const before = readFileSync(config);
			assert.throws(
				() =>
					writeTaskModelConfig(config, example, tasks, tasksMeta, () => true, {
						expectedConfigRevision: "missing",
						tasksThinking: { coding: "low" },
					}),
				/Stale/,
			);
			assert.deepEqual(readFileSync(config), before);
			assert.equal(save({}).tasksThinking, undefined);
			assert.equal(
				Object.hasOwn(
					JSON.parse(readFileSync(config, "utf8")).models,
					"tasksThinking",
				),
				false,
			);
			assert.throws(
				() => save({ review: "high" }),
				/has no submitted task category/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
