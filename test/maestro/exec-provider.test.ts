import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	FakeExecProvider,
	FULL_EXEC_CAPABILITIES,
} from "../../maestro/adapters/fake/fake-exec-provider.ts";
import type {
	FreshPiLaunchRequest,
	PiLaunchRequest,
	PiRunningChild,
} from "../../maestro/adapters/pi/launch.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { PiHarnessAdapter } from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import { TerminalExecProvider } from "../../maestro/adapters/pi/terminal-exec-provider.ts";
import {
	execRefusal,
	projectAgentHandle,
	type ExecCapabilities,
	type ExecHandle,
} from "../../maestro/core/exec-provider.ts";
import type { SpawnOptions } from "../../maestro/core/harness-adapter.ts";
import { createLifecycle } from "../../maestro/core/lifecycle.ts";
import type {
	NativeExecution,
	NativeExecutionInspection,
} from "../../maestro/core/surface-provider.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import type { RoutingModel } from "../../maestro/core/routing.ts";
import type {
	AgentHandle,
	Role,
	Task,
	ThinkingLevel,
} from "../../maestro/core/types.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { registerExecProviderConformance } from "../../maestro/testing/exec-provider.conformance.ts";

const paneConfig = {
	mode: "grouped",
	direction: "right",
	maxPerTab: 4,
} as const;

const role: Role = {
	name: "worker",
	version: "1",
	description: "test",
	systemPrompt: "Focused identity",
	allowedTools: ["read", "bash"],
	defaults: { autoExit: true, spawning: false },
};

const modelRegistry = {
	find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
	available: () => [],
	hasConfiguredAuth: () => true,
	supportedThinkingLevels: (): ThinkingLevel[] => ["off", "high"],
	clampThinkingLevel: (_model: RoutingModel, level: ThinkingLevel) => level,
};

/** A parent session directory the real Pi launch transaction can write under. */
function parentFixture() {
	const root = mkdtempSync(join(tmpdir(), "exec-provider-test-"));
	const sessionDir = join(root, "parent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "parent.jsonl");
	writeFileSync(
		sessionFile,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root }) +
			"\n",
	);
	return {
		root,
		parent: {
			cwd: root,
			sessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir: join(root, "agent"),
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

function freshRequest(
	parent: ReturnType<typeof parentFixture>,
): FreshPiLaunchRequest {
	return {
		kind: "fresh",
		name: "conformance",
		task: "bounded task",
		cwd: parent.root,
		parent: parent.parent,
		runtimePlan: {
			provider: "fake",
			modelId: "test",
			model: "fake/test",
			thinking: "off",
			modelSource: "request",
			thinkingSource: "request",
		},
		behavior: {
			deniedTools: [],
			autoExit: true,
			interactive: false,
			sessionMode: "standalone",
		},
	};
}

/** Prompts a terminal child received, read back from Pi's task inbox files. */
function terminalPrompts(child: PiRunningChild) {
	const prefix = `${basename(child.sessionFile)}.task-inbox.`;
	return readdirSync(dirname(child.sessionFile))
		.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
		.sort()
		.map((name) => {
			const entry = JSON.parse(
				readFileSync(join(dirname(child.sessionFile), name), "utf8"),
			);
			return { id: entry.task, text: entry.message };
		});
}

/** Herdr Core's native program execution, in memory, over the fake terminal. */
class FakeCoreSurface extends FakeSurfaceProvider {
	readonly states = new Map<string, NativeExecutionInspection>();
	refuseTerminate = false;
	starts = 0;
	readonly nativeExecution: NativeExecution = {
		start: async (input) => {
			input.signal?.throwIfAborted();
			this.starts++;
			const id = this.createSurface({ name: "native", cwd: input.cwd });
			this.runScript(id, input.command, input);
			this.states.set(id, { kind: "live" });
			return id;
		},
		inspect: async (id) => this.states.get(id) ?? { kind: "missing" },
		terminate: async (id) => {
			if (this.refuseTerminate) throw new Error("Core refused termination");
			this.states.set(id, { kind: "finished", exitCode: 143 });
			this.removeSurface(id);
		},
	};
}

// Registered at top level: each conformance case's lineage stays in its runner file.
registerExecProviderConformance({ describe, it }, "Fake", async () => {
	const provider = new FakeExecProvider<string, string>({
		launched: (request) => request,
	});
	return {
		provider,
		request: () => "task",
		acquisitions: () => provider.executions.length,
		exit: async ({ handle }) => provider.exit(handle),
		print: async ({ handle }, text) => provider.print(handle, text),
		blockStop: async ({ handle }) =>
			provider.blockStop(handle, new Error("stop refused")),
		prompted: async ({ handle }) => provider.execution(handle).prompts,
		dispose: async () => {},
	};
});

registerExecProviderConformance(
	{ describe, it },
	"Terminal (legacy Herdr pane)",
	async () => {
		const parent = parentFixture();
		const surface = new FakeSurfaceProvider();
		let created = 0;
		const create = surface.createSurface.bind(surface);
		surface.createSurface = (options) => {
			created++;
			return create(options);
		};
		const operations = launchOperationsFromSurface(surface, paneConfig);
		const provider = new TerminalExecProvider({ surface, operations });
		return {
			provider,
			request: () => freshRequest(parent),
			acquisitions: () => created,
			exit: async ({ launched }) => surface.removeSurface(launched.surface),
			print: async ({ launched }, text) =>
				surface.appendScreen(launched.surface, text),
			blockStop: async () => {
				surface.closeSurface = () => {
					throw new Error("close refused");
				};
			},
			prompted: async ({ launched }) => terminalPrompts(launched),
			dispose: async () => parent.dispose(),
		};
	},
);

registerExecProviderConformance(
	{ describe, it },
	"Terminal (Herdr Core native)",
	async () => {
		const parent = parentFixture();
		const surface = new FakeCoreSurface();
		const provider = new TerminalExecProvider({ surface, paneConfig });
		return {
			provider,
			request: () => freshRequest(parent),
			acquisitions: () => surface.starts,
			exit: async ({ launched }) => {
				surface.states.set(launched.surface, {
					kind: "finished",
					exitCode: 0,
				});
				surface.removeSurface(launched.surface);
			},
			print: async ({ launched }, text) =>
				surface.appendScreen(launched.surface, text),
			blockStop: async () => {
				surface.refuseTerminate = true;
			},
			prompted: async ({ launched }) => terminalPrompts(launched),
			dispose: async () => parent.dispose(),
		};
	},
);

describe("ExecProvider seam", () => {
	it("terminal capabilities: Herdr supports every request; Core keeps its refusal text", () => {
		const legacy = new TerminalExecProvider({
			surface: new FakeSurfaceProvider(),
			paneConfig,
		});
		assert.deepEqual(
			{ ...legacy.capabilities },
			{
				...FULL_EXEC_CAPABILITIES,
				executionExit: false,
				parentAdmission: "best-effort",
			},
		);
		const core = new TerminalExecProvider({
			surface: new FakeCoreSurface(),
			paneConfig,
		});
		assert.equal(core.capabilities.worktree, false);
		assert.equal(core.capabilities.callerSurface, false);
		assert.equal(core.capabilities.executionExit, true);
		assert.equal(core.capabilities.parentAdmission, "best-effort");
		for (const requirement of ["worktree", "callerSurface"] as const)
			assert.equal(
				execRefusal(core, [requirement]),
				"Herdr Core supports ordinary native execution only; managed worktrees, handoffs and supplied panes are deferred",
			);
	});

	it("the shared projection carries a surface ID only when the provider hosts one", () => {
		const fields = {
			id: "run",
			name: "worker",
			role: "worker",
			harness: "pi",
			cwd: "/work",
			startedAt: 1,
			sessionId: "/work/session.jsonl",
		};
		const capabilities = FULL_EXEC_CAPABILITIES;
		const worker: ExecHandle = { provider: "worker", ref: "w-1", capabilities };
		assert.deepEqual(projectAgentHandle(worker, fields), fields);
		assert.equal("surfaceId" in projectAgentHandle(worker, fields), false);
		const terminal: ExecHandle = { ...worker, surfaceId: "pane-1" };
		assert.deepEqual(
			Object.keys(
				projectAgentHandle(terminal, { ...fields, launchFailure: "uncertain" }),
			),
			[...Object.keys(fields), "surfaceId", "launchFailure"],
		);
	});

	it("an unreadable terminal is unavailable to observe and reconcile, never a throw", async () => {
		const parent = parentFixture();
		try {
			const surface = new FakeSurfaceProvider();
			const provider = new TerminalExecProvider({ surface, paneConfig });
			const { handle } = await provider.launch(freshRequest(parent));
			surface.inspectSurface = async () => {
				throw new Error("herdr socket closed");
			};
			assert.deepEqual(await provider.reconcile(handle), {
				kind: "unavailable",
				error: "herdr socket closed",
			});
			const controller = new AbortController();
			for await (const snapshot of provider.observe(handle, {
				signal: controller.signal,
				intervalMs: 5,
			})) {
				assert.deepEqual(snapshot, {
					kind: "unavailable",
					error: "herdr socket closed",
				});
				controller.abort();
			}
			await assert.rejects(
				provider.launch(
					{ ...freshRequest(parent), acquisitionSignal: controller.signal },
					{ signal: new AbortController().signal },
				),
				/two acquisition signals/,
			);
		} finally {
			parent.dispose();
		}
	});

	it("the terminal default keeps the adapter's native-binding check", () => {
		// Construction touches no file; nothing is launched.
		const unusedParent = {
			cwd: "/nonexistent",
			sessionFile: "/nonexistent/parent.jsonl",
			sessionId: "parent",
			sessionDir: "/nonexistent",
		};
		const surface = new FakeCoreSurface();
		assert.throws(
			() =>
				new PiHarnessAdapter({
					surface,
					operations: launchOperationsFromSurface(
						new FakeSurfaceProvider(),
						paneConfig,
					),
					modelRegistry,
					supervision: new SupervisionCoordinator(
						async () => ({ complete: true, panes: [] }),
						(id) => surface.inspectSurface(id),
					),
					parent: unusedParent,
				}),
			{
				message:
					"Pi owning provider and launch operations must use the same native execution binding",
			},
		);
		assert.throws(
			() =>
				new PiHarnessAdapter({
					modelRegistry,
					supervision: new SupervisionCoordinator(
						async () => ({ complete: true, panes: [] }),
						async () => ({ kind: "missing" as const }),
					),
					parent: unusedParent,
				}),
			/requires an execution provider or a terminal surface/,
		);
	});

	it("a launch the fake refuses acquires nothing", async () => {
		const provider = new FakeExecProvider<string, string>({
			launched: (request) => request,
		});
		provider.failNextLaunch(new Error("no capacity"));
		await assert.rejects(provider.launch("task"), /no capacity/);
		assert.equal(provider.executions.length, 0);
		assert.equal((await provider.launch("task")).launched, "task");
	});

	it("generic refusals name the provider and requirement", () => {
		const provider = new FakeExecProvider<string, string>({
			name: "worker",
			capabilities: { persistent: false, fork: false },
			launched: (request) => request,
		});
		assert.equal(
			execRefusal(provider, ["sharedCheckout", "persistent", "fork"]),
			"worker execution does not support persistent specialists; refused before acquisition.",
		);
		assert.equal(execRefusal(provider, ["worktree", "resume"]), undefined);
	});
});

/** The shared Pi adapter over an in-memory provider: no terminal is constructed. */
function sharedAdapterFixture(capabilities: Partial<ExecCapabilities> = {}) {
	const parent = parentFixture();
	const runs = join(parent.root, "runs");
	mkdirSync(runs);
	const exec = new FakeExecProvider<PiLaunchRequest, PiRunningChild>({
		name: "worker",
		capabilities,
		launched: (request, ref) => {
			assert.equal(request.kind, "fresh");
			const startTime = Date.now();
			return {
				id: request.id ?? ref,
				name: request.name,
				task: request.task,
				agent: request.agent,
				// Pi-internal supervision key; the shared handle never carries it.
				surface: ref,
				ownsSurface: false,
				startTime,
				sessionFile: join(runs, `${ref}.jsonl`),
				launchScriptFile: join(runs, `${ref}.sh`),
				activityFile: join(runs, `${ref}.activity.json`),
				interactive: false,
				runtimePlan: request.runtimePlan,
				cwd: request.cwd,
				lifecycle: createLifecycle(startTime),
				persistent: request.behavior.persistent,
			};
		},
	});
	const wake = new FileWakeRegistry();
	const supervision = new SupervisionCoordinator(
		async () => ({ complete: true, panes: [] }),
		async () => ({ kind: "unavailable" as const }),
		false,
		wake,
	);
	const adapter = new PiHarnessAdapter({
		exec,
		modelRegistry,
		supervision,
		parent: parent.parent,
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
	});
	const session = createRunSession({
		adapter,
		roles: [role],
		cwd: parent.root,
	});
	let next = 0;
	const task = (overrides: Partial<Task> = {}): Task => ({
		id: `task-${++next}`,
		name: "worker",
		prompt: "bounded task",
		role: "worker",
		cwd: parent.root,
		runtime: { model: "fake/test", thinking: "off" },
		...overrides,
	});
	return {
		parent,
		exec,
		adapter,
		session,
		task,
		dispose() {
			supervision.close();
			wake.close();
			parent.dispose();
		},
	};
}

async function usingShared(
	capabilities: Partial<ExecCapabilities>,
	run: (fixture: ReturnType<typeof sharedAdapterFixture>) => Promise<void>,
) {
	const fixture = sharedAdapterFixture(capabilities);
	try {
		await run(fixture);
	} finally {
		fixture.dispose();
	}
}

describe("one RunSession path over an ExecProvider", () => {
	const refusals: {
		requirement: keyof ExecCapabilities;
		text: RegExp;
		launch(f: ReturnType<typeof sharedAdapterFixture>): Promise<AgentHandle>;
	}[] = [
		{
			requirement: "sharedCheckout",
			text: /does not support running in the caller's checkout; refused before acquisition/,
			launch: (f) => f.session.spawn(f.task()),
		},
		{
			requirement: "worktree",
			text: /does not support managed worktrees; refused before acquisition/,
			launch: (f) => f.session.spawn(f.task({ worktree: { branch: "w" } })),
		},
		{
			requirement: "persistent",
			text: /does not support persistent specialists; refused before acquisition/,
			launch: (f) =>
				f.session.spawn(
					f.task({ behavior: { persistent: true, autoExit: false } }),
				),
		},
		{
			requirement: "fork",
			text: /does not support forking the parent session; refused before acquisition/,
			launch: (f) => f.session.spawn(f.task({ session: { mode: "fork" } })),
		},
		{
			requirement: "resume",
			text: /does not support resuming a saved session; refused before acquisition/,
			launch: (f) =>
				f.session.resume({
					task: f.task(),
					name: "resumed",
					sessionId: join(f.parent.root, "saved.jsonl"),
				}),
		},
		{
			requirement: "callerSurface",
			text: /does not support a caller-provided terminal surface; refused before acquisition/,
			launch: (f) =>
				f.adapter.spawn({
					name: "worker",
					task: "bounded task",
					cwd: f.parent.root,
					sessionId: "logical",
					role,
					runtime: { model: "fake/test", thinking: "off" },
					surface: {
						id: "caller-pane",
						runCommand: () => assert.fail("nothing may run"),
						readScreen: () => assert.fail("nothing may be read"),
					},
				} satisfies SpawnOptions),
		},
	];
	for (const { requirement, text, launch } of refusals)
		it(`refuses a request needing ${requirement} before any acquisition`, async () =>
			usingShared({ [requirement]: false }, async (f) => {
				await assert.rejects(launch(f), text);
				assert.deepEqual(f.exec.calls, []);
				assert.equal(f.exec.executions.length, 0);
			}));

	it("Core refuses a managed worktree with its existing text and starts nothing", async () => {
		const parent = parentFixture();
		const surface = new FakeCoreSurface();
		const supervision = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			(id) => surface.inspectSurface(id),
		);
		try {
			const adapter = new PiHarnessAdapter({
				surface,
				paneConfig,
				modelRegistry,
				supervision,
				parent: parent.parent,
				parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
			});
			await assert.rejects(
				adapter.spawn({
					name: "worker",
					task: "bounded task",
					cwd: parent.root,
					sessionId: "logical",
					role,
					runtime: { model: "fake/test", thinking: "off" },
					worktreeRequest: { branch: "w" },
				}),
				{
					message:
						"Herdr Core supports ordinary native execution only; managed worktrees, handoffs and supplied panes are deferred",
				},
			);
			assert.equal(surface.starts, 0);
			assert.deepEqual(surface.listSurfaces(), []);
		} finally {
			supervision.close();
			parent.dispose();
		}
	});

	it("launches, reads, interrupts and completes through the provider; the handle has no surface", async () =>
		usingShared({}, async (f) => {
			const task = f.task();
			const handle = await f.session.spawn(task);
			assert.equal(handle.harness, "pi");
			assert.equal("surfaceId" in handle, false);
			const [execution] = f.exec.executions;
			assert.ok(execution);
			const exec: ExecHandle = {
				provider: "worker",
				ref: execution.ref,
				capabilities: f.exec.capabilities,
			};
			f.exec.print(exec, "working");
			assert.equal(await f.adapter.readOutput(handle), "working");
			await f.session.interrupt(task.id);
			assert.equal(execution.interrupts, 1);

			const settled = f.session.supervise(handle, task);
			const child = f.adapter.getRunningChild(handle);
			f.exec.exit(exec);
			writeFileSync(
				`${child.sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			const result = await settled;
			assert.equal(result.outcome, "completed");
			assert.equal(result.evidence?.reason, "done");
			assert.ok(f.exec.calls.includes("reconcile"));
			assert.equal(f.session.getTask(task.id), undefined);
		}));

	it("cancel stops through the provider; an unconfirmed stop keeps the run owned", async () =>
		usingShared({}, async (f) => {
			const task = f.task();
			const handle = await f.session.spawn(task);
			const [execution] = f.exec.executions;
			assert.ok(execution);
			const exec: ExecHandle = {
				provider: "worker",
				ref: execution.ref,
				capabilities: f.exec.capabilities,
			};
			const settled = f.session.supervise(handle, task);
			f.exec.blockStop(exec, new Error("worker did not confirm the stop"));
			const first = await f.session.cancel(task.id);
			assert.deepEqual(first, {
				status: "unconfirmed",
				requestedAt: first.requestedAt,
				error: "worker did not confirm the stop",
			});
			assert.equal(execution.state, "live");
			assert.equal(f.session.getHandle(task.id), handle);
			assert.deepEqual(await f.session.cancel(task.id), {
				status: "confirmed",
				requestedAt: first.requestedAt,
				repeated: true,
			});
			assert.equal(execution.state, "stopped");
			const result = await settled;
			assert.equal(result.outcome, "killed");
			assert.equal(result.cancellation?.termination, "confirmed");
			assert.deepEqual(
				f.exec.calls.filter((call) => call === "stop"),
				["stop", "stop"],
			);
		}));

	it("a persistent specialist's later task is delivered through prompt", async () =>
		usingShared({}, async (f) => {
			const task = f.task({ behavior: { persistent: true } });
			const handle = await f.session.spawn(task);
			const child = f.adapter.getRunningChild(handle);
			// The launch transaction records these for a real persistent child.
			Object.assign(child, {
				generationId: "g1",
				logicalId: "l1",
				policyHash: "p1",
				tasksCompleted: 0,
			});
			await f.session.send(task.id, "next task");
			const [execution] = f.exec.executions;
			assert.equal(execution?.prompts.length, 1);
			assert.equal(execution?.prompts[0]?.text, "next task");
			assert.equal(child.taskId, execution?.prompts[0]?.id);
			assert.deepEqual(child.issuedTaskIds, [child.taskId]);
			// A busy specialist refuses before the provider is asked.
			await assert.rejects(f.session.send(task.id, "too soon"), /busy/);
			assert.equal(execution?.prompts.length, 1);
		}));
});
