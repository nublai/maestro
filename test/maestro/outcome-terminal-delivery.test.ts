/**
 * Terminal delivery regression (P3-8): the Pi composition with the real tool
 * delivery sends the parent exactly the same messages, retires and releases
 * the same way, and writes the same audit ledger, with or without an outcome
 * store. With one, the store additionally holds each outcome as admitted.
 */
import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import type { OutcomeRecovery } from "../../maestro/core/outcome-store.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import {
	FileOutcomeStore,
	terminalOutcomeStoreDir,
} from "../../maestro/runtime/file-outcome-store.ts";
import * as runtime from "../../maestro/runtime/index.ts";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiRunRecord,
} from "../../maestro/runtime/pi-run-session-types.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { createDelivery } from "../../pi-extension/subagents/delivery.ts";
import {
	bindLiveApi,
	type SubagentRuntime,
} from "../../pi-extension/subagents/state.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

type Scenario = "done" | "error" | "ping" | "accept" | "cancel";

async function deliver(scenario: Scenario, withStore: boolean) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "outcome-terminal-")));
	const parentFile = join(dir, "parent.jsonl");
	writeFileSync(
		parentFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir })}\n`,
	);
	mkdirSync(join(dir, "sessions"));
	const provider = new FakeSurfaceProvider();
	const operations = launchOperationsFromSurface(provider, {
		mode: "tab",
		direction: "right",
		maxPerTab: 4,
	});
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	const coordinator = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
		false,
		new FileWakeRegistry(),
	);
	const parent = createMockExtensionApi();
	const host: SubagentRuntime = { runningSubagents: new Map() };
	// SAFETY: the mock implements the ExtensionAPI members delivery uses.
	bindLiveApi(host, parent.api as never);
	const delivery = createDelivery({
		runtime: host,
		updateWidget() {},
		startPersistentStopTimeout() {},
	});
	const storeDir = terminalOutcomeStoreDir(dir, "parent");
	const store = withStore
		? await FileOutcomeStore.open({ dir: storeDir, parent: "parent" })
		: undefined;
	let record: PiRunRecord | undefined;
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: fileURLToPath(
			new URL("../../config.json.example", import.meta.url),
		),
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
			acceptRunner: async () => ({ kind: "exit", exitCode: 0, output: "ok" }),
		},
		forcePolling: false,
		roles: [],
		outcomeStore: store,
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				invocationCwd: dir,
				sessionFile: parentFile,
				sessionId: "parent",
				sessionDir: join(dir, "sessions"),
				agentDir: dir,
			},
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig: { mode: "tab", direction: "right", maxPerTab: 4 },
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["off", "low", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned(spawned) {
				record = spawned;
				host.runningSubagents.set(spawned.id, spawned);
			},
			onSettled: delivery.deliverPiCompletion,
		},
		persistent: {
			send: () => ({ error: "test policy" }),
			stop: () => ({ error: "test policy" }),
			drain() {},
		},
	};
	const session = runtime.createDefaultRunSession(options);
	const input: PiLaunchInput = {
		task: {
			id: "control",
			name: "child",
			prompt: "bounded",
			role: "",
			cwd: dir,
			behavior: { autoExit: true, persistent: false },
		},
		role: {
			name: "",
			version: "1",
			description: "fixture",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [
			{
				provider: "test",
				modelId: "one",
				model: "test/one",
				thinking: "high",
				modelSource: "request",
				thinkingSource: "parent",
			},
		],
		resolved: {},
		identity: {
			id: "public-control",
			logicalId: "logical-control",
			generationId: "generation-control",
			taskId: "inbox-control",
		},
	};
	if (scenario === "accept")
		input.task.accept = {
			run: "true",
			maxRetries: 0,
			timeoutSec: 5,
			paths: [],
		};
	try {
		const handle = await session.spawnPi(input);
		const wait = session.supervise(handle, input.task);
		const child = record!;
		if (scenario === "cancel")
			assert.equal((await session.cancel(input.task.id)).status, "confirmed");
		else {
			if (!existsSync(child.sessionFile))
				writeFileSync(
					child.sessionFile,
					`${JSON.stringify({ type: "session", version: 3, id: child.id, cwd: dir })}\n`,
				);
			writeFileSync(
				`${child.sessionFile}.exit`,
				JSON.stringify(
					scenario === "error"
						? { type: "error", errorMessage: "provider failed" }
						: scenario === "ping"
							? { type: "ping", name: "child", message: "which file?" }
							: { type: "done" },
				),
			);
		}
		const result = await wait;
		const ledgerFile = join(dir, "herdr-agents", "outcomes.jsonl");
		// Only the temporary directory, the session file's timestamped random
		// name and wall-clock times differ between two runs.
		const normalize = (text: string) =>
			text
				.replaceAll(dir, "<dir>")
				.replace(/<dir>\/sessions\/[^"\\]+?\.jsonl/g, "<session>")
				.replace(/"at":"[^"]+"/g, '"at":"<at>"')
				.replace(/"(requestedAt|confirmedAt)":\d+/g, '"$1":0');
		const recovery: OutcomeRecovery | undefined = store?.recovery();
		const journal = store
			? readFileSync(join(storeDir, "journal.jsonl"), "utf8")
			: undefined;
		return {
			observed: {
				outcome: result.outcome,
				messages: normalize(JSON.stringify(parent.sentMessages)),
				ledger: normalize(
					existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "",
				),
				surfaces: provider.listSurfaces().length,
				retired: session.getRecord(input.task.id) === undefined,
				hostRows: host.runningSubagents.size,
			},
			recovery,
			journal,
			storeDir,
			dir,
		};
	} finally {
		await session.shutdown("quit");
		await store?.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const scenario of ["done", "error", "ping", "accept", "cancel"] as const)
	test(`terminal ${scenario} delivery is unchanged by an outcome store, which holds it as admitted`, async () => {
		const without = await deliver(scenario, false);
		const withStore = await deliver(scenario, true);
		assert.ok(without.observed.messages.length > 2, "a message was sent");
		assert.deepEqual(withStore.observed, without.observed);
		// The audit ledger is unchanged and separate from the store.
		assert.notEqual(without.observed.ledger, "");
		assert.ok(!withStore.storeDir.endsWith("outcomes.jsonl"));
		const recovery = withStore.recovery!;
		assert.deepEqual(recovery.outcomes, [], "nothing left undelivered");
		assert.deepEqual(recovery.interrupted, []);
		assert.deepEqual(
			recovery.final.map(({ state, evidence }) => [state, evidence]),
			[["admitted", "process-local"]],
		);
		assert.match(
			withStore.journal!,
			scenario === "ping" ? /"kind":"help"/ : /"kind":"result"/,
		);
		// Terminal children have no generation: the store owner scopes the key.
		assert.match(
			withStore.journal!,
			/"dedupeKey":"\[\\"parent\\",\\"control\\",\\"owner:/,
		);
		if (scenario === "accept") {
			assert.match(withStore.journal!, /"type":"check"/);
			assert.match(withStore.journal!, /"verdict":\{"verdict":"accepted"/);
		} else assert.doesNotMatch(withStore.journal!, /"type":"check"/);
		if (scenario === "cancel")
			assert.match(withStore.journal!, /"termination":"confirmed"/);
	});

test("a reload must keep the live owner's outcome store", async (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "outcome-reload-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const provider = new FakeSurfaceProvider();
	const operations = launchOperationsFromSurface(provider, {
		mode: "tab",
		direction: "right",
		maxPerTab: 4,
	});
	const coordinator = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		(id) => provider.inspectSurface(id),
		false,
		new FileWakeRegistry(),
	);
	const first = await FileOutcomeStore.open({
		dir: join(dir, "a"),
		parent: "p",
	});
	const second = await FileOutcomeStore.open({
		dir: join(dir, "b"),
		parent: "p",
	});
	t.after(async () => {
		await first.close();
		await second.close();
	});
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: fileURLToPath(
			new URL("../../config.json.example", import.meta.url),
		),
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
		},
		forcePolling: false,
		roles: [],
		outcomeStore: first,
		getLaunchSnapshot: () => assert.fail("no launch"),
		hooks: { onSettled() {} },
		persistent: {
			send: () => ({ error: "x" }),
			stop: () => ({ error: "x" }),
			drain() {},
		},
	};
	const session = runtime.createDefaultRunSession(options);
	assert.ok(
		runtime.createDefaultRunSession(
			{ ...options, outcomeStore: undefined },
			session,
		),
	);
	assert.ok(runtime.createDefaultRunSession(options, session));
	assert.throws(
		() =>
			runtime.createDefaultRunSession(
				{ ...options, outcomeStore: second },
				session,
			),
		/Outcome store changed; restart Pi/,
	);
	await session.shutdown("quit");
});
