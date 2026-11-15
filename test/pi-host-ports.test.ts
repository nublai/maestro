import "./isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDefaultRunSession } from "../maestro/runtime/pi-run-session.ts";
import type {
	DefaultRunSessionOptions,
	PiLaunchInput,
	PiLaunchSnapshot,
	PiPersistentIO,
	PiRunRecord,
} from "../maestro/runtime/pi-run-session-types.ts";
import type { HostSurfaceBinding } from "../maestro/runtime/host-surface-binding.ts";
import type { HerdrBinding } from "../maestro/core/config/herdr-config.ts";
import type { PaneConfig } from "../maestro/core/config/pane-config.ts";
import { loadPaneConfig } from "../maestro/core/config/pane-config.ts";
import {
	AcquisitionUncertainError,
	type NativeExecution,
	type NativeExecutionInspection,
} from "../maestro/core/surface-provider.ts";
import { FakeSurfaceProvider } from "../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../maestro/adapters/pi/launch-operations.ts";
import { writeSubagentSessionPolicy } from "../maestro/adapters/pi/session.ts";
import { FileWakeRegistry } from "../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../maestro/core/supervision.ts";
import { DEFAULT_CHILD_ENTRY_PATH } from "../maestro/adapters/pi/launch-command.ts";

/**
 * Supplemental M3 tests for the H1 host ports. Upstream exercises these paths
 * through the retained terminal host (Herdr/Core providers and the tool surface);
 * here a fake HostSurfaceBinding drives the same copied runtime directly.
 */
const example = fileURLToPath(
	new URL("../config.json.example", import.meta.url),
);
const paneConfig: PaneConfig = {
	mode: "tab",
	direction: "right",
	maxPerTab: 4,
};

class NativeFakeProvider extends FakeSurfaceProvider {
	readonly starts: Parameters<NativeExecution["start"]>[0][] = [];
	readonly terminated: string[] = [];
	inspection: NativeExecutionInspection = { kind: "live" };
	failNext?: Error;
	#next = 0;
	readonly nativeExecution: NativeExecution = {
		start: async (input) => {
			this.starts.push(input);
			const failure = this.failNext;
			this.failNext = undefined;
			if (failure) throw failure;
			return `native-${++this.#next}`;
		},
		inspect: async () => this.inspection,
		terminate: async (id) => {
			this.terminated.push(id);
			this.inspection = { kind: "missing" };
		},
	};
}

function workspace() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-host-ports-")));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	mkdirSync(join(dir, "sessions"));
	const snapshot: PiLaunchSnapshot = {
		parent: {
			cwd: dir,
			invocationCwd: dir,
			sessionFile: parent,
			sessionId: "parent",
			sessionDir: join(dir, "sessions"),
			agentDir: dir,
		},
		parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
		paneConfig,
		modelRegistry: {
			find: (p, id) => ({ provider: p, id, reasoning: true }),
			available: () => [],
			hasConfiguredAuth: () => true,
			supportedThinkingLevels: () => ["off", "low", "high"],
			clampThinkingLevel: (_model, level) => level,
		},
	};
	return { dir, parent, snapshot };
}

function launchInput(
	dir: string,
	id: string,
	persistent = false,
): PiLaunchInput {
	return {
		task: {
			id,
			name: "child",
			prompt: "bounded",
			role: "",
			cwd: dir,
			behavior: { autoExit: !persistent, persistent },
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
			id: `public-${id}`,
			logicalId: `logical-${id}`,
			generationId: `generation-${id}`,
			taskId: `inbox-${id}`,
		},
	};
}

interface BindingCalls {
	resolve: unknown[][];
	createProvider: { binding: HerdrBinding; paneConfig: PaneConfig }[];
	launch: PiLaunchSnapshot[];
	markers: number;
	writes: unknown[];
}

interface RecordingBinding {
	host: HostSurfaceBinding;
	calls: BindingCalls;
}

function recordingBinding(
	binding: () => HerdrBinding,
	owning: FakeSurfaceProvider,
	launchProvider: () => FakeSurfaceProvider,
): RecordingBinding {
	const calls: BindingCalls = {
		resolve: [],
		createProvider: [],
		launch: [],
		markers: 0,
		writes: [],
	};
	return {
		calls,
		host: {
			resolve(...args) {
				calls.resolve.push(args);
				return binding();
			},
			createProvider(next, config, resolveScriptShell) {
				assert.ok(resolveScriptShell);
				calls.createProvider.push({ binding: next, paneConfig: config });
				return owning;
			},
			createLaunchProvider(snapshot) {
				calls.launch.push(snapshot);
				return launchProvider();
			},
			markers() {
				calls.markers++;
				return {
					write: async (request) => {
						calls.writes.push(request);
						return "answered";
					},
					readSession: async () => ({ kind: "none" }),
				};
			},
		},
	};
}

function options(
	dir: string,
	snapshot: PiLaunchSnapshot,
	extra: Partial<DefaultRunSessionOptions>,
): DefaultRunSessionOptions {
	return {
		configDir: dir,
		configExamplePath: example,
		forcePolling: false,
		roles: [],
		getLaunchSnapshot: () => snapshot,
		hooks: { onSettled() {} },
		persistent: {
			send: () => ({ error: "test policy" }),
			stop: () => ({ error: "test policy" }),
			drain() {},
		},
		...extra,
	};
}

test("a Pi run session refuses to compose without a host surface binding or injected infrastructure", () => {
	const { dir, snapshot } = workspace();
	try {
		assert.throws(
			() => createDefaultRunSession(options(dir, snapshot, {})),
			/^Error: Pi run session requires a host surface binding$/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("injected infrastructure must give the owner and launches one native execution binding", () => {
	const { dir, snapshot } = workspace();
	try {
		const provider = new NativeFakeProvider();
		const wake = new FileWakeRegistry();
		const supervision = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			(id) => provider.inspectSurface(id),
			false,
			wake,
		);
		assert.throws(
			() =>
				createDefaultRunSession(
					options(dir, snapshot, {
						infrastructure: {
							surfaceProvider: provider,
							launchOperations: launchOperationsFromSurface(
								new FakeSurfaceProvider(),
								paneConfig,
							),
							supervision,
						},
					}),
				),
			/same native execution binding/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a legacy host binding resolves per load, owns one provider, creates a provider per launch and rejects a changed binding on reload", async () => {
	const { dir, snapshot } = workspace();
	const owning = new FakeSurfaceProvider();
	const launched: FakeSurfaceProvider[] = [];
	let current: HerdrBinding = { backend: "legacy" };
	const { host, calls } = recordingBinding(
		() => current,
		owning,
		() => {
			const provider = new FakeSurfaceProvider();
			launched.push(provider);
			return provider;
		},
	);
	const first = createDefaultRunSession(
		options(dir, snapshot, { hostSurface: host, platform: "linux" }),
	);
	try {
		assert.deepEqual(calls.resolve, [[dir, example, "linux"]]);
		assert.equal(calls.createProvider.length, 1);
		assert.deepEqual(calls.createProvider[0].binding, { backend: "legacy" });
		assert.deepEqual(
			calls.createProvider[0].paneConfig,
			loadPaneConfig(join(dir, "herdr-agents"), example),
		);
		assert.equal(
			calls.markers,
			1,
			"legacy panes get the host's marker transport",
		);
		const handle = await first.spawnPi(launchInput(dir, "legacy"));
		assert.equal(handle.launchFailure, undefined);
		assert.deepEqual(calls.launch, [snapshot]);
		assert.equal(launched.length, 1);
		assert.deepEqual(
			launched[0].listSurfaces().map((surface) => surface.id),
			[handle.surfaceId],
		);
		assert.deepEqual(
			owning.listSurfaces(),
			[],
			"the owner provider is not a launch provider",
		);
		const surfaceId = handle.surfaceId;
		assert.ok(surfaceId);
		const [command] = launched[0].commands(surfaceId);
		assert(command.includes(DEFAULT_CHILD_ENTRY_PATH));
		assert.deepEqual(first.availability(), {
			available: owning.isAvailable(),
			setupHint: owning.setupHint(),
		});
		assert.deepEqual(await first.listWorktreeSurfaces(), []);
		await assert.rejects(
			first.sendPersistent("unknown", "hello"),
			/^Error: Task "unknown" has no active Pi owner\.$/,
		);

		const reloaded = createDefaultRunSession(
			options(dir, snapshot, { hostSurface: host, platform: "linux" }),
			first,
		);
		assert.equal(
			calls.resolve.length,
			2,
			"every load resolves the current binding",
		);
		assert.equal(
			calls.createProvider.length,
			1,
			"the owner keeps its provider",
		);
		assert.equal(reloaded.getRecord("legacy"), first.getRecord("legacy"));

		current = {
			backend: "core",
			socket: "/fixture.sock",
			parentTerminal: "t1",
		};
		assert.throws(
			() =>
				createDefaultRunSession(
					options(dir, snapshot, { hostSurface: host, platform: "linux" }),
					reloaded,
				),
			/Herdr backend or endpoint changed; restart Pi/,
		);
		assert.equal((await reloaded.cancel("legacy")).status, "confirmed");
	} finally {
		await first.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Core host binding launches and resumes through the owner's native execution and refuses managed-worktree cleanup", async () => {
	const { dir, snapshot } = workspace();
	const owning = new NativeFakeProvider();
	const { host, calls } = recordingBinding(
		() => ({ backend: "core", socket: "/fixture.sock", parentTerminal: "t1" }),
		owning,
		() => assert.fail("Core launches reuse the owning native execution"),
	);
	const session = createDefaultRunSession(
		options(dir, snapshot, { hostSurface: host, platform: "linux" }),
	);
	try {
		assert.equal(calls.markers, 0, "native execution receives no markers");
		const input = launchInput(dir, "native");
		const handle = await session.spawnPi(input);
		assert.equal(handle.surfaceId, "native-1");
		assert.equal(owning.starts.length, 1);
		assert.match(owning.starts[0].command, /__SUBAGENT_DONE_/);
		assert.match(
			owning.starts[0].scriptPreamble,
			/Subagent launch script for child/,
		);
		const record = session.getRecord("native")!;
		writeFileSync(
			record.sessionFile,
			[
				{ type: "session", version: 3, id: record.id, cwd: dir },
				{ type: "model_change", provider: "test", modelId: "two" },
				{ type: "thinking_level_change", thinkingLevel: "low" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		writeFileSync(
			`${record.sessionFile}.exit`,
			JSON.stringify({ type: "done" }),
		);
		owning.inspection = { kind: "finished", exitCode: 0 };
		const result = await session.supervise(handle, input.task);
		assert.equal(result.outcome, "completed");
		assert.equal(record.runtimePlan?.observed?.model, "test/two");
		assert.equal(record.runtimePlan?.thinking, "low");
		assert.equal(
			record.runtimePlan?.runtimeMismatch,
			"Resolved model test/one but child reported test/two",
		);

		const resumeFile = join(dir, "resume.jsonl");
		writeFileSync(
			resumeFile,
			JSON.stringify({ type: "session", version: 3, id: "resume", cwd: dir }) +
				"\n",
		);
		writeSubagentSessionPolicy(resumeFile, {
			owner: "public",
			deniedTools: [],
		});
		owning.inspection = { kind: "live" };
		const resumed = await session.resumePi({
			taskId: "resumed",
			sessionPath: resumeFile,
			name: "resume",
		});
		assert.equal(resumed.surfaceId, "native-2");
		assert.match(
			owning.starts[1].scriptPreamble,
			/Subagent resume script for resume/,
		);
		assert.equal((await session.cancel("resumed")).status, "confirmed");
		// Completion releases its native execution; cancel confirms the resumed one.
		assert.deepEqual([...new Set(owning.terminated)], ["native-1", "native-2"]);

		owning.inspection = { kind: "live" };
		owning.failNext = new AcquisitionUncertainError("start reply lost", {
			kind: "execution-start",
			observedSurfaceId: "t9",
			acquiredSurfaceId: "t9",
		});
		const uncertain = await session.spawnPi(launchInput(dir, "uncertain"));
		assert.ok(uncertain.launchFailure);
		assert.equal(session.getRecord("uncertain")?.surface, "t9");
		assert.equal(session.getStarted("uncertain")?.status, "uncertain");
		assert.equal((await session.cancel("uncertain")).status, "confirmed");

		owning.failNext = new AcquisitionUncertainError("resume start reply lost", {
			kind: "execution-start",
			observedSurfaceId: "t10",
			acquiredSurfaceId: "t10",
		});
		owning.inspection = { kind: "live" };
		const uncertainResume = await session.resumePi({
			taskId: "uncertain-resume",
			sessionPath: resumeFile,
			name: "resume",
		});
		assert.ok(uncertainResume.launchFailure);
		assert.equal(session.getRecord("uncertain-resume")?.surface, "t10");
		assert.equal(
			(await session.cancel("uncertain-resume")).status,
			"confirmed",
		);

		assert.throws(
			() =>
				session.createWorktreeCleanupOperations({
					manifestDir: join(dir, "manifests"),
					liveHolders: () => [],
				}),
			/^Error: Managed worktree cleanup is not supported by Herdr Core$/,
		);
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("persistent facade calls hand the record and owner I/O to the host's persistent policy", async () => {
	const { dir, snapshot } = workspace();
	const owning = new FakeSurfaceProvider();
	const launch = new FakeSurfaceProvider();
	const { host } = recordingBinding(
		() => ({ backend: "legacy" }),
		owning,
		() => launch,
	);
	const seen: { kind: string; record: PiRunRecord; io: PiPersistentIO }[] = [];
	const session = createDefaultRunSession(
		options(dir, snapshot, {
			hostSurface: host,
			platform: "linux",
			persistent: {
				send(record, text, io) {
					seen.push({ kind: `send:${text}`, record, io });
					return text === "busy"
						? { error: "busy" }
						: { id: record.id, task: "t", inbox: "i", outcome: "dispatched" };
				},
				stop(record, timeoutMs, io) {
					seen.push({ kind: `stop:${timeoutMs}`, record, io });
					return { id: record.id, name: record.name, status: "stop_requested" };
				},
				drain() {},
			},
		}),
	);
	try {
		await session.spawnPi(launchInput(dir, "specialist", true));
		const record = session.getRecord("specialist")!;
		assert.deepEqual(await session.sendPersistent("specialist", "next"), {
			id: record.id,
			task: "t",
			inbox: "i",
			outcome: "dispatched",
		});
		await session.send("specialist", "again");
		await assert.rejects(session.send("specialist", "busy"), /^Error: busy$/);
		const stopped = {
			id: record.id,
			name: record.name,
			status: "stop_requested",
		};
		assert.deepEqual(await session.stopPersistent("specialist"), stopped);
		assert.deepEqual(await session.stopPersistent("specialist", 5), stopped);
		assert.deepEqual(
			seen.map((call) => call.kind),
			["send:next", "send:again", "send:busy", "stop:15000", "stop:5"],
		);
		assert(seen.every((call) => call.record === record));
		const io = seen[0].io;
		assert.equal(await io.inspectWorktree(record), undefined);
		assert.deepEqual(io.readTaskSummary(record), {
			summary: "Persistent specialist session is unavailable.",
			summarySource: "host",
		});
		writeFileSync(
			record.sessionFile,
			JSON.stringify({ type: "session", version: 3, id: record.id, cwd: dir }) +
				"\n",
		);
		assert.deepEqual(io.readTaskSummary(record), {
			summary: "Persistent specialist completed without output.",
			summarySource: "host",
		});
		const inbox = io.dispatch(record, "task-1", "work");
		assert(existsSync(inbox));
		assert.equal(record.taskId, "task-1");
		io.rejectBusy(record, "task-2");
		io.requestStop(record);
		io.requestStop(record);
		io.acknowledge(record, {
			version: 1,
			type: "task-done",
			task: "task-1",
			generation: record.generationId ?? "",
			at: new Date(0).toISOString(),
		});
		io.recordStopped(record);
		assert.deepEqual(
			io.readLedger(record).map((row) => [row.task, row.outcome]),
			[
				["inbox-specialist", "dispatched"],
				["task-1", "dispatched"],
				["task-2", "rejected-busy"],
				["task-1", "stop-pending"],
				["task-1", "delivered"],
				["stop", "stopped"],
			],
		);
		assert.equal(record.tasksCompleted, 1);
		assert.deepEqual(io.readEvents(record), []);
		const progress = session.inspectProgress("specialist");
		assert(Number.isFinite(progress.updatedAt));
		assert.equal(progress.lastEntryKind, "other");
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
});
