import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createPiExtension } from "../pi-extension/subagents/extension.ts";
import {
	getSubagentsConfigExamplePath,
	getSubagentsConfigPath,
} from "../pi-extension/subagents/config-path.ts";
import { parseStatusConfig } from "../maestro/core/status.ts";
import { parseModelConfig } from "../maestro/core/config/model-config.ts";
import { parseRoleConfig } from "../maestro/core/config/role-config.ts";
import { parsePersistentConfig } from "../maestro/core/config/persistent-config.ts";
import { parseSpawningConfig } from "../maestro/core/config/spawning-config.ts";
import { parseOutcomeLedgerConfig } from "../maestro/core/config/outcome-ledger-config.ts";
import { parseSupervisionConfig } from "../maestro/core/config/supervision-config.ts";
import { parsePaneConfig } from "../maestro/core/config/pane-config.ts";
import { parseGuidelinesConfig } from "../maestro/core/config/guidelines-config.ts";
import { parseHerdrConfig } from "../maestro/core/config/herdr-config.ts";
import type { JsonObject } from "../maestro/core/config/type-guards.ts";
import { createMockExtensionApi } from "./helpers/mock-extension-api.ts";
import subagentsExtension, {
	testHostSurface,
	testPresentation,
} from "./helpers/pi-extension.ts";

// Supplemental #149 tests (not migrated identities): config.json sections are
// optional, and the task-model writer keeps the rest of the file, owner-only.

const example = JSON.parse(
	readFileSync(getSubagentsConfigExamplePath(), "utf8"),
);

/** Every section the host parses while the extension loads, parent or child. */
function parseAll(config: JsonObject) {
	return {
		herdr: parseHerdrConfig(config),
		status: parseStatusConfig(config),
		models: parseModelConfig(config),
		roles: parseRoleConfig(config),
		persistent: parsePersistentConfig(config),
		spawning: parseSpawningConfig(config),
		outcomeLedger: parseOutcomeLedgerConfig(config),
		supervision: parseSupervisionConfig(config),
		panes: parsePaneConfig(config),
		guidelines: parseGuidelinesConfig(config),
	};
}

/** The models-only file the shep-app staging VM held (#149). */
const modelsOnly: JsonObject = {
	models: {
		tasks: { recon: ["p/recon"] },
		tasksThinking: { recon: "off" },
		tasksMeta: { generatedAt: "2026-11-16T03:46:28Z", method: "registry-only" },
	},
};

function withConfig(config: JsonObject, run: () => void) {
	const path = getSubagentsConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config));
	try {
		run();
	} finally {
		rmSync(path, { force: true });
	}
}

function load() {
	const extension = createPiExtension({
		hostSurface: testHostSurface,
		presentation: testPresentation,
	});
	const mock = createMockExtensionApi();
	extension(mock.api);
	return mock;
}

test("a config.json holding only models loads the extension with every default", () => {
	withConfig(modelsOnly, () => {
		const mock = load();
		assert.ok(mock.registeredTools.some((tool) => tool.name === "subagent"));
	});
	const { models: _models, ...defaults } = parseAll(example);
	const { models, ...parsed } = parseAll(modelsOnly);
	assert.deepEqual(parsed, defaults);
	assert.deepEqual(models.tasks, { recon: ["p/recon"] });
	assert.deepEqual(models.tasksThinking, { recon: "off" });
});

test("each section omitted from the shipped example keeps its shipped default", () => {
	const expected = parseAll(example);
	assert.deepEqual(parseAll({}), expected);
	for (const key of Object.keys(example)) {
		const { [key]: _omitted, ...rest } = example;
		assert.deepEqual(parseAll(rest), expected, `without ${key}`);
	}
	assert.deepEqual(parseStatusConfig({ status: {} }), {
		enabled: true,
		lineLimit: 4,
	});
	assert.deepEqual(parseStatusConfig({ status: { enabled: false } }), {
		enabled: false,
		lineLimit: 4,
	});
});

test("a present but malformed status section still fails with a clear error", () => {
	for (const [status, message] of [
		["on", /status must be an object/],
		[null, /status must be an object/],
		[[], /status must be an object/],
		[{ enabled: "yes" }, /status\.enabled must be a boolean/],
		[{ enabled: true, cadence: 5 }, /status has unsupported key\(s\): cadence/],
	] as const) {
		assert.throws(
			() => parseStatusConfig({ status }, "/x/config.json"),
			(error: Error) =>
				error.message.startsWith(
					"Invalid subagent status config in /x/config.json: ",
				) && message.test(error.message),
			JSON.stringify(status),
		);
	}
	withConfig({ status: "on" }, () =>
		assert.throws(
			load,
			/Invalid subagent status config in .*config\.json: status must be an object/,
		),
	);
});

const YES = "Yes, save";
const registry = {
	find: (provider: string, id: string) =>
		provider === "p" ? { provider, id, reasoning: false } : undefined,
	getAvailable: () => [{ provider: "p", id: "new", reasoning: false }],
	hasConfiguredAuth: () => true,
};

async function writeThroughTool(agentDir: string) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const mock = createMockExtensionApi();
		subagentsExtension(mock.api);
		const writer = mock.registeredTools.find(
			(tool) => tool.name === "subagents_write_task_models",
		);
		assert.ok(writer);
		mock.api.setActiveTools([...mock.api.getActiveTools(), writer.name]);
		const result = await writer.execute(
			"write",
			{
				tasks: { recon: ["p/new"] },
				tasksThinking: { recon: "off" },
				tasksMeta: {
					generatedAt: "2026-11-16T03:46:28Z",
					method: "registry-only",
				},
			},
			undefined,
			undefined,
			{
				hasUI: true,
				mode: "tui",
				modelRegistry: registry,
				ui: { select: async () => YES },
			},
		);
		assert.match(
			JSON.stringify(result.content),
			/Wrote task model preferences/,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

test("the task-model writer keeps every other key and publishes mode 0600", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "maestro-149-writer-"));
	try {
		const path = join(agentDir, "herdr-agents", "config.json");
		mkdirSync(dirname(path), { recursive: true });
		const existing = {
			...example,
			status: { enabled: false },
			models: { default: "p/default", agents: { scout: "p/scout" } },
			sidebar: { enabled: true },
		};
		writeFileSync(path, JSON.stringify(existing, null, 2));
		chmodSync(path, 0o644);
		await writeThroughTool(agentDir);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		const { models, ...rest } = saved;
		const { models: before, ...unchanged } = existing;
		assert.deepEqual(rest, unchanged);
		assert.deepEqual(Object.keys(saved), Object.keys(existing));
		assert.equal(models.default, before.default);
		assert.deepEqual(models.agents, before.agents);
		assert.deepEqual(models.tasks, { recon: ["p/new"] });
		if (process.platform !== "win32")
			assert.equal(statSync(path).mode & 0o777, 0o600);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a writer-created config.json is owner-only and loads the extension", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "maestro-149-fresh-"));
	try {
		await writeThroughTool(agentDir);
		const path = join(agentDir, "herdr-agents", "config.json");
		if (process.platform !== "win32")
			assert.equal(statSync(path).mode & 0o777, 0o600);
		withConfig(JSON.parse(readFileSync(path, "utf8")), () => {
			assert.ok(
				load().registeredTools.some((tool) => tool.name === "subagent"),
			);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
