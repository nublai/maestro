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
import { readPersistentDeliveryLedger } from "../../maestro/adapters/pi/session.ts";
import {
	PiHarnessAdapter,
	type PiExecProvider,
	type PiExecution,
	type PiSpawnOptions,
} from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import { TerminalExecProvider } from "../../maestro/adapters/pi/terminal-exec-provider.ts";
import {
	execRefusal,
	projectAgentHandle,
	observeSupervision,
	type ExecCapabilities,
	type ExecHandle,
	type ExecLaunch,
	type ExecRequirement,
	type ExecStopRequest,
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
import {
	registerExecProviderConformance,
	type ExecAdapterBoundary,
} from "../../maestro/testing/exec-provider.conformance.ts";

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
	/** Programs whose termination Core refuses. */
	readonly refuseTerminate = new Set<string>();
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
			if (this.refuseTerminate.has(id))
				throw new Error("Core refused termination");
			this.states.set(id, { kind: "finished", exitCode: 143 });
			this.removeSurface(id);
		},
	};
}

function spawnOptions(root: string, extra: Partial<PiSpawnOptions> = {}) {
	return {
		name: "worker",
		task: "bounded task",
		cwd: root,
		sessionId: "logical",
		role,
		runtime: { model: "fake/test", thinking: "off" },
		...extra,
	} satisfies PiSpawnOptions;
}

/** Drive one requirement through the adapter's public spawn or resume. */
function spawnRequiring(
	adapter: PiHarnessAdapter<PiExecution>,
	root: string,
	requirement: ExecRequirement,
): Promise<AgentHandle> {
	switch (requirement) {
		case "resume":
			return adapter.resume({
				name: "resumed",
				sessionId: join(root, "saved.jsonl"),
			});
		case "worktree":
			return adapter.spawn(
				spawnOptions(root, { worktreeRequest: { branch: "w" } }),
			);
		case "persistent":
			return adapter.spawn(
				spawnOptions(root, {
					behavior: { persistent: true, autoExit: false },
				}),
			);
		case "fork":
			return adapter.spawn(spawnOptions(root, { session: { mode: "fork" } }));
		case "callerSurface":
			return adapter.spawn(
				spawnOptions(root, {
					surface: {
						id: "caller-pane",
						runCommand: () => assert.fail("nothing may run"),
						readScreen: () => assert.fail("nothing may be read"),
					},
				}),
			);
		case "sharedCheckout":
			return adapter.spawn(spawnOptions(root));
	}
}

/**
 * The shared Pi adapter over `exec`, recording each launch so a run handle
 * maps back to the provider's own launch result.
 */
function piBoundary<Child extends PiExecution>(
	exec: PiExecProvider<Child>,
	parent: ReturnType<typeof parentFixture>,
	uncertainNextLaunch?: (reason: string) => void,
	/** An adapter already composed over `exec`; default: one given `exec`. */
	composed?: PiHarnessAdapter<Child>,
): ExecAdapterBoundary<Child> & { adapter: PiHarnessAdapter<Child> } {
	const launches = new Map<Child, ExecLaunch<Child>>();
	const launch = exec.launch.bind(exec);
	exec.launch = async (request, control) => {
		const result = await launch(request, control);
		launches.set(result.launched, result);
		return result;
	};
	const adapter =
		composed ??
		new PiHarnessAdapter<Child>({
			exec,
			modelRegistry,
			parent: parent.parent,
			parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
		});
	const boundary: ExecAdapterBoundary<Child> & {
		adapter: PiHarnessAdapter<Child>;
	} = {
		adapter,
		spawn: (acquisitionSignal) =>
			adapter.spawn(
				spawnOptions(
					parent.root,
					acquisitionSignal ? { acquisitionSignal } : {},
				),
			),
		spawnRequiring: (requirement) =>
			spawnRequiring(adapter, parent.root, requirement),
		launchOf: (handle) => {
			const result = launches.get(adapter.getRunningChild(handle));
			assert.ok(result, `no launch recorded for ${handle.id}`);
			return result;
		},
	};
	if (uncertainNextLaunch) boundary.uncertainNextLaunch = uncertainNextLaunch;
	return boundary;
}

/**
 * Pi's shared record for an execution with no terminal: no pane, no launch
 * script. Paths derive from the run's own ID, never the provider reference.
 */
function paneLessExecution(runs: string) {
	let next = 0;
	return (request: PiLaunchRequest): PiExecution => {
		const id = request.id ?? `run-${++next}`;
		const startTime = Date.now();
		const shared = {
			id,
			name: request.name,
			startTime,
			activityFile: join(runs, `${id}.activity.json`),
			interactive: false,
			lifecycle: createLifecycle(startTime),
		};
		return request.kind === "resume"
			? {
					...shared,
					task: request.message ?? "",
					sessionFile: request.sessionFile,
					runtimePlan: undefined,
				}
			: {
					...shared,
					task: request.task,
					agent: request.agent,
					sessionFile: join(runs, `${id}.jsonl`),
					runtimePlan: request.runtimePlan,
					cwd: request.cwd,
					persistent: request.behavior.persistent,
				};
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
		blockStop: async ({ handle }) => {
			provider.blockStop(handle, new Error("stop refused"));
			return "sent";
		},
		prompted: async ({ handle }) => provider.execution(handle).prompts,
		dispose: async () => {},
	};
});

/** A pane-less Pi provider behind the shared adapter, optionally limited. */
function paneLessConformance(
	name: string,
	capabilities: Partial<ExecCapabilities>,
	blockedRequest: ExecStopRequest,
) {
	registerExecProviderConformance({ describe, it }, name, async () => {
		const parent = parentFixture();
		const runs = join(parent.root, "runs");
		mkdirSync(runs);
		const provider = new FakeExecProvider<PiLaunchRequest, PiExecution>({
			name: "pane-less",
			capabilities: { ...capabilities, executionExit: false },
			launched: paneLessExecution(runs),
		});
		const boundary = piBoundary(provider, parent, (reason) =>
			provider.uncertainNextLaunch(reason),
		);
		return {
			provider,
			request: () => freshRequest(parent),
			acquisitions: () => provider.executions.length,
			exit: async ({ handle }) => provider.exit(handle),
			print: async ({ handle }, text) => provider.print(handle, text),
			blockStop: async ({ handle }) => {
				provider.blockStop(handle, new Error("stop refused"), blockedRequest);
				return blockedRequest;
			},
			prompted: async ({ handle }) => provider.execution(handle).prompts,
			adapter: {
				...boundary,
				finish: async (handle) => {
					recordDone(boundary.adapter.getRunningChild(handle));
					provider.exit(boundary.launchOf(handle).handle);
				},
			},
			dispose: async () => parent.dispose(),
		};
	});
}
paneLessConformance("Pane-less Pi (fake)", {}, "sent");
paneLessConformance(
	"Pane-less Pi (fake, limited capabilities)",
	{
		resume: false,
		fork: false,
		persistent: false,
		worktree: false,
		callerSurface: false,
	},
	"not-sent",
);

/** How a hooked pane-less fixture's provider misbehaves (a conformance mutant). */
interface StopMutant {
	/** The first stop of the second acquired execution rejects (illegal). */
	rejectSecondExecutionStop?: boolean;
	/** An unobserved stop's execution never confirms a stop again. */
	neverConfirmUnobserved?: boolean;
	/** Not a mutant: the second execution's first stop goes unobserved. */
	unobserveSecondExecutionStop?: boolean;
	/**
	 * The adapter's first kill of the second execution throws its own error:
	 * `instead` of stopping, or `after` a stop that returned unconfirmed.
	 */
	adapterError?: "instead" | "after";
}

/**
 * A pane-less Pi provider whose stops can go unobserved (`unobserveNextStop`:
 * the next stop reports `unknown`, unconfirmed). Counts the stops each
 * execution received; `dispose` fails a case that sent one execution more
 * than three.
 */
function unobservedStopFixture(mutant: StopMutant = {}) {
	const parent = parentFixture();
	const runs = join(parent.root, "runs");
	mkdirSync(runs);
	const provider = new FakeExecProvider<PiLaunchRequest, PiExecution>({
		name: "pane-less",
		capabilities: { executionExit: false },
		launched: paneLessExecution(runs),
	});
	const stops = new Map<string, number>();
	const unobserved = new Set<string>();
	let rejected = false;
	const stop = provider.stop.bind(provider);
	provider.stop = async (handle) => {
		stops.set(handle.ref, (stops.get(handle.ref) ?? 0) + 1);
		if (
			mutant.unobserveSecondExecutionStop &&
			handle.ref === provider.executions[1]?.ref &&
			stops.get(handle.ref) === 1
		)
			return {
				request: "unknown",
				termination: "unconfirmed",
				error: new Error("stop not observed"),
			};
		if (
			mutant.rejectSecondExecutionStop &&
			!rejected &&
			handle.ref === provider.executions[1]?.ref
		) {
			rejected = true;
			throw new Error("mutant: stop rejected");
		}
		if (mutant.neverConfirmUnobserved && unobserved.has(handle.ref))
			return {
				request: "unknown",
				termination: "unconfirmed",
				error: new Error("mutant: stop never observed"),
			};
		return stop(handle);
	};
	const boundary = piBoundary(provider, parent, (reason) =>
		provider.uncertainNextLaunch(reason),
	);
	if (mutant.adapterError) {
		const kill = boundary.adapter.kill.bind(boundary.adapter);
		let thrown = false;
		boundary.adapter.kill = async (handle) => {
			if (
				thrown ||
				boundary.launchOf(handle).handle.ref !== provider.executions[1]?.ref
			)
				return kill(handle);
			thrown = true;
			if (mutant.adapterError === "after") await kill(handle).catch(() => {});
			throw new Error("mutant: adapter error");
		};
	}
	return {
		stops,
		fixture: {
			provider,
			request: () => freshRequest(parent),
			acquisitions: () => provider.executions.length,
			exit: async ({ handle }: ExecLaunch<PiExecution>) =>
				provider.exit(handle),
			print: async ({ handle }: ExecLaunch<PiExecution>, text: string) =>
				provider.print(handle, text),
			blockStop: async ({ handle }: ExecLaunch<PiExecution>) => {
				provider.blockStop(handle, new Error("stop refused"), "sent");
				return "sent" as const;
			},
			unobserveNextStop: async ({ handle }: ExecLaunch<PiExecution>) => {
				unobserved.add(handle.ref);
				provider.blockStop(handle, new Error("stop not observed"), "unknown");
			},
			prompted: async ({ handle }: ExecLaunch<PiExecution>) =>
				provider.execution(handle).prompts,
			adapter: {
				...boundary,
				finish: async (handle: AgentHandle) => {
					recordDone(boundary.adapter.getRunningChild(handle));
					provider.exit(boundary.launchOf(handle).handle);
				},
			},
			dispose: async () => {
				parent.dispose();
				for (const [ref, count] of stops)
					assert.ok(count <= 3, `${count} stops for ${ref}`);
			},
		},
	};
}
registerExecProviderConformance(
	{ describe, it },
	"Pane-less Pi (fake, stops may go unobserved)",
	async () => unobservedStopFixture().fixture,
);

type ConformanceRunner = Parameters<typeof registerExecProviderConformance>[0];

/** One conformance suite's cases, captured by title instead of run. */
function capturedConformance(
	factory: () => Promise<ReturnType<typeof unobservedStopFixture>["fixture"]>,
) {
	const cases = new Map<string, () => Promise<void>>();
	const skip = () => {
		throw new Error("a captured case skipped");
	};
	const runner = {
		describe: (_name: string, body: () => void) => body(),
		it: (title: string, body: (t: { skip: () => void }) => Promise<void>) => {
			cases.set(title, () => body({ skip }));
		},
	};
	// SAFETY: the suite calls only describe(name, body) and it(title, body), and its bodies read only `t.skip`.
	registerExecProviderConformance(
		runner as ConformanceRunner,
		"mutant",
		factory,
	);
	return (title: string) => {
		const run = cases.get(title);
		assert.ok(run, `no conformance case ${title}`);
		return run();
	};
}

describe("ExecProvider conformance rejects stop mutants of a fixture whose stops can go unobserved", () => {
	it("a stop that rejects on the adapter boundary's second execution fails the suite: only an unconfirmed report is repeated", async () => {
		const run = capturedConformance(
			async () =>
				unobservedStopFixture({ rejectSecondExecutionStop: true }).fixture,
		);
		await assert.rejects(
			run(
				"adapter boundary: read and stop go through the provider; an unconfirmed stop keeps the run live",
			),
			/mutant: stop rejected/,
		);
	});

	for (const when of ["instead", "after"] as const)
		it(`an adapter error ${when === "instead" ? "instead of a stop" : "after an unconfirmed stop"} fails the suite at once`, async () => {
			let stops: Map<string, number> | undefined;
			const run = capturedConformance(async () => {
				const made = unobservedStopFixture({
					unobserveSecondExecutionStop: true,
					adapterError: when,
				});
				stops = made.stops;
				return made.fixture;
			});
			await assert.rejects(
				run(
					"adapter boundary: read and stop go through the provider; an unconfirmed stop keeps the run live",
				),
				/mutant: adapter error/,
			);
			// The blocked first execution's stop, and at most one of the second's.
			assert.deepEqual(
				[...(stops?.values() ?? [])],
				when === "instead" ? [1] : [1, 1],
			);
		});

	it("control: an unobserved stop on the adapter boundary's second execution is repeated and confirms", async () => {
		let stops: Map<string, number> | undefined;
		const run = capturedConformance(async () => {
			const made = unobservedStopFixture({
				unobserveSecondExecutionStop: true,
			});
			stops = made.stops;
			return made.fixture;
		});
		await assert.doesNotReject(
			run(
				"adapter boundary: read and stop go through the provider; an unconfirmed stop keeps the run live",
			),
		);
		assert.deepEqual([...(stops?.values() ?? [])], [1, 2]);
	});

	it("an unobserved stop that never confirms fails the suite after three stops in all", async () => {
		let stops: Map<string, number> | undefined;
		const run = capturedConformance(async () => {
			const made = unobservedStopFixture({ neverConfirmUnobserved: true });
			stops = made.stops;
			return made.fixture;
		});
		await assert.rejects(
			run(
				"a stop the host did not observe is an unconfirmed report; a later stop confirms",
			),
			assert.AssertionError,
		);
		assert.deepEqual([...(stops?.values() ?? [])], [3]);
	});
});

/** Pi's own `done` record, as the child writes it before it exits. */
function recordDone(child: PiExecution) {
	writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "done" }));
}

/**
 * The terminal adapter composed as the run session composes it: built from a
 * surface, with one batched SupervisionCoordinator the adapter forwards to
 * its own TerminalExecProvider. Each coordinator registration is recorded.
 */
function productionTerminal(
	parent: ReturnType<typeof parentFixture>,
	surface: FakeSurfaceProvider,
) {
	const wake = new FileWakeRegistry();
	const supervision = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: surface.listSurfaces().map((info) => ({
				paneId: info.id,
				workspaceId: info.workspaceId ?? "",
			})),
		}),
		(id) => surface.inspectSurface(id),
		false,
		wake,
	);
	const registered: string[] = [];
	const register = supervision.register.bind(supervision);
	supervision.register = (sessionFile, id) => {
		registered.push(sessionFile);
		return register(sessionFile, id);
	};
	const adapter = new PiHarnessAdapter<PiRunningChild>({
		surface,
		paneConfig,
		operations: launchOperationsFromSurface(surface, paneConfig),
		supervision,
		modelRegistry,
		parent: parent.parent,
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
	});
	// The provider the adapter built for itself; nothing else may stand in.
	const provider = adapter["exec"];
	const boundary = piBoundary(provider, parent, undefined, adapter);
	return {
		provider,
		boundary,
		/** Fails unless completion of `handle` is supervised by the coordinator. */
		assertCoordinated(handle: AgentHandle) {
			assert.ok(
				registered.includes(adapter.getRunningChild(handle).sessionFile),
				"completion is supervised by the run's coordinator",
			);
		},
		dispose() {
			supervision.close();
			wake.close();
			parent.dispose();
		},
	};
}

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
		const terminal = productionTerminal(parent, surface);
		const { provider, boundary } = terminal;
		return {
			provider,
			request: () => freshRequest(parent),
			acquisitions: () => created,
			exit: async ({ launched }) => surface.removeSurface(launched.surface),
			print: async ({ launched }, text) =>
				surface.appendScreen(launched.surface, text),
			blockStop: async ({ launched }) => {
				const close = surface.closeSurface.bind(surface);
				surface.closeSurface = (id) => {
					if (id === launched.surface) throw new Error("close refused");
					close(id);
				};
				// Close threw: whether the request reached the pane is unknown.
				return "unknown";
			},
			prompted: async ({ launched }) => terminalPrompts(launched),
			adapter: {
				...boundary,
				finish: async (handle) => {
					terminal.assertCoordinated(handle);
					// The pane stays open: the session-file wake carries completion.
					recordDone(boundary.adapter.getRunningChild(handle));
				},
			},
			dispose: async () => terminal.dispose(),
		};
	},
);

registerExecProviderConformance(
	{ describe, it },
	"Terminal (Herdr Core native)",
	async () => {
		const parent = parentFixture();
		const surface = new FakeCoreSurface();
		const terminal = productionTerminal(parent, surface);
		const { provider, boundary } = terminal;
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
			blockStop: async ({ launched }) => {
				surface.refuseTerminate.add(launched.surface);
				// Terminate threw: whether Core acted on it is unknown.
				return "unknown";
			},
			prompted: async ({ launched }) => terminalPrompts(launched),
			adapter: {
				...boundary,
				finish: async (handle) => {
					terminal.assertCoordinated(handle);
					const child = boundary.adapter.getRunningChild(handle);
					// Native exit first: the sidecar's wake then finds it finished.
					surface.states.set(child.surface, { kind: "finished", exitCode: 0 });
					recordDone(child);
				},
			},
			dispose: async () => terminal.dispose(),
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
	// No terminal: the records carry no pane and no launch script.
	const exec = new FakeExecProvider<PiLaunchRequest, PiExecution>({
		name: "worker",
		capabilities,
		launched: paneLessExecution(runs),
	});
	const adapter = new PiHarnessAdapter({
		exec,
		modelRegistry,
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
	/** The provider handle of the n-th execution. */
	const execHandle = (index = 0): ExecHandle => {
		const execution = exec.executions[index];
		assert.ok(execution, `no execution ${index}`);
		return {
			provider: "worker",
			ref: execution.ref,
			capabilities: exec.capabilities,
		};
	};
	return {
		parent,
		exec,
		adapter,
		session,
		task,
		execHandle,
		dispose() {
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

async function eventually(check: () => boolean, what: string) {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// PR #7 review, finding 1: the provider's top-level launch uncertainty is the
// signal; the adapter keeps it on the owned attempt and the completion path.
describe("launch uncertainty from the provider's launch result", () => {
	const UNKNOWN = "initial prompt outcome unknown";

	it("spawn keeps a top-level launchFailure, and completion never reports done", async () =>
		usingShared({}, async (f) => {
			f.exec.uncertainNextLaunch(UNKNOWN);
			const handle = await f.adapter.spawn(spawnOptions(f.parent.root));
			assert.equal(handle.launchFailure, UNKNOWN);
			const child = f.adapter.getRunningChild(handle);
			assert.equal(child.launchFailure, UNKNOWN);
			f.exec.exit(f.execHandle());
			writeFileSync(
				`${child.sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			const evidence = await f.adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			assert.equal(evidence.reason, "error");
			assert.equal(evidence.exitCode, 1);
			assert.equal(evidence.errorMessage, UNKNOWN);
		}));

	it("resume keeps a top-level launchFailure through completion", async () =>
		usingShared({}, async (f) => {
			f.exec.uncertainNextLaunch(UNKNOWN);
			const handle = await f.adapter.resume({
				name: "resumed",
				sessionId: join(f.parent.root, "saved.jsonl"),
			});
			assert.equal(handle.launchFailure, UNKNOWN);
			f.exec.exit(f.execHandle());
			writeFileSync(
				join(f.parent.root, "saved.jsonl.exit"),
				JSON.stringify({ type: "done" }),
			);
			const evidence = await f.adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			assert.equal(evidence.reason, "error");
			assert.equal(evidence.errorMessage, UNKNOWN);
		}));

	const withFallback = (f: ReturnType<typeof sharedAdapterFixture>) =>
		f.task({
			runtime: {
				model: "fake/test",
				thinking: "off",
				fallbacks: [{ model: "fake/other", thinking: "off" }],
			},
		});
	const owned = (
		f: ReturnType<typeof sharedAdapterFixture>,
		taskId: string,
	): AgentHandle => {
		const handle = f.session.getHandle(taskId);
		assert.ok(handle, `no owned run for ${taskId}`);
		return handle;
	};
	const failFirst = (f: ReturnType<typeof sharedAdapterFixture>) => {
		const child = f.adapter.getRunningChild(owned(f, "task-1"));
		f.exec.exit(f.execHandle(0), 1);
		writeFileSync(
			`${child.sessionFile}.exit`,
			JSON.stringify({ type: "error", errorMessage: "model overloaded" }),
		);
	};

	it("control: an ordinary error attempt falls back to the next model", async () =>
		usingShared({}, async (f) => {
			const task = withFallback(f);
			const handle = await f.session.spawn(task);
			const settled = f.session.supervise(handle, task);
			failFirst(f);
			await eventually(() => f.exec.executions.length === 2, "the fallback");
			const next = owned(f, task.id);
			f.exec.exit(f.execHandle(1));
			writeFileSync(
				`${f.adapter.getRunningChild(next).sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			assert.equal((await settled).outcome, "completed");
		}));

	it("an uncertain attempt that then errors is never retried with a fallback", async () =>
		usingShared({}, async (f) => {
			const task = withFallback(f);
			f.exec.uncertainNextLaunch(UNKNOWN);
			const handle = await f.session.spawn(task);
			assert.equal(handle.launchFailure, UNKNOWN);
			const settled = f.session.supervise(handle, task);
			failFirst(f);
			const result = await settled;
			assert.equal(result.outcome, "failed");
			assert.equal(result.evidence?.errorMessage, UNKNOWN);
			assert.equal(f.exec.executions.length, 1);
		}));
});

// Finding 2: the acquisition signal is the seam's control argument.
describe("acquisition cancellation through the adapter", () => {
	for (const kind of ["spawn", "resume"] as const)
		it(`an aborted ${kind} acquires nothing`, async () =>
			usingShared({}, async (f) => {
				const acquisitionSignal = AbortSignal.abort();
				await assert.rejects(
					kind === "spawn"
						? f.adapter.spawn(
								spawnOptions(f.parent.root, { acquisitionSignal }),
							)
						: f.adapter.resume({
								name: "resumed",
								sessionId: join(f.parent.root, "saved.jsonl"),
								acquisitionSignal,
							}),
				);
				assert.deepEqual(f.exec.calls, ["launch"]);
				assert.equal(f.exec.executions.length, 0);
			}));
});

// Finding 3: completion presence and wake-ups come from the selected provider.
describe("completion supervised by the provider", () => {
	/** A pane supervisor that reports every pane gone: it must not be consulted. */
	function paneLessWithHostileSupervisor() {
		const f = sharedAdapterFixture({ executionExit: false });
		const wake = new FileWakeRegistry();
		const supervision = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			async () => ({ kind: "missing" as const }),
			false,
			wake,
		);
		const adapter = new PiHarnessAdapter({
			exec: f.exec,
			supervision,
			modelRegistry,
			parent: f.parent.parent,
			parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
		});
		return {
			...f,
			adapter,
			dispose() {
				supervision.close();
				wake.close();
				f.dispose();
			},
		};
	}

	it("a live pane-less execution is never reported as a disappeared pane", async () => {
		const f = paneLessWithHostileSupervisor();
		try {
			const handle = await f.adapter.spawn(spawnOptions(f.parent.root));
			const controller = new AbortController();
			const waiting = f.adapter.awaitCompletion(handle, controller.signal);
			await eventually(
				() => f.exec.calls.filter((call) => call === "observe").length > 0,
				"provider observation",
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			await assert.rejects(waiting, /Aborted while waiting/);
			assert.equal(f.exec.executions[0]?.state, "live");
		} finally {
			f.dispose();
		}
	});

	it("its completion evidence and a later exit are still observed", async () => {
		const f = paneLessWithHostileSupervisor();
		try {
			const done = await f.adapter.spawn(spawnOptions(f.parent.root));
			const waiting = f.adapter.awaitCompletion(
				done,
				new AbortController().signal,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			writeFileSync(
				`${f.adapter.getRunningChild(done).sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			assert.equal((await waiting).reason, "done");

			const gone = await f.adapter.spawn(spawnOptions(f.parent.root));
			const lost = f.adapter.awaitCompletion(
				gone,
				new AbortController().signal,
			);
			f.exec.exit(f.execHandle(1));
			const evidence = await lost;
			assert.equal(evidence.reason, "error");
		} finally {
			f.dispose();
		}
	});

	/**
	 * A push provider that reports presence once and then stays quiet until its
	 * observation is aborted: valid, since `observe` owes no periodic snapshots.
	 */
	function quietPush(f: ReturnType<typeof sharedAdapterFixture>) {
		f.exec.observe = async function* (handle, options) {
			f.exec.calls.push("observe");
			yield await f.exec.inspect(handle);
			await new Promise<void>((resolve) =>
				options.signal.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
		};
	}

	/** The completion, or a failure when it is still pending after `ms`. */
	async function within<T>(ms: number, pending: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`still waiting after ${ms}ms`)),
						ms,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	// Astra delta P2: the default supervision must not wait only for snapshots.
	it("a quiet push observer still completes on a sidecar written after observation starts", async () => {
		const f = sharedAdapterFixture({ executionExit: false });
		quietPush(f);
		const controller = new AbortController();
		try {
			const handle = await f.adapter.spawn(spawnOptions(f.parent.root));
			const waiting = f.adapter.awaitCompletion(handle, controller.signal);
			await eventually(
				() => f.exec.calls.includes("observe"),
				"provider observation",
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			writeFileSync(
				`${f.adapter.getRunningChild(handle).sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			assert.equal((await within(3_000, waiting)).reason, "done");
		} finally {
			controller.abort();
			f.dispose();
		}
	});

	it("a quiet push observer still reconciles a native execution that ended", async () => {
		const f = sharedAdapterFixture({ executionExit: true });
		quietPush(f);
		const controller = new AbortController();
		try {
			const handle = await f.adapter.spawn(spawnOptions(f.parent.root));
			const waiting = f.adapter.awaitCompletion(handle, controller.signal);
			await eventually(
				() => f.exec.calls.includes("observe"),
				"provider observation",
			);
			writeFileSync(
				`${f.adapter.getRunningChild(handle).sessionFile}.exit`,
				JSON.stringify({ type: "done" }),
			);
			f.exec.exit(f.execHandle());
			assert.equal((await within(3_000, waiting)).reason, "done");
		} finally {
			controller.abort();
			f.dispose();
		}
	});

	it("the terminal provider supervises through its batched coordinator", async () => {
		const parent = parentFixture();
		const surface = new FakeSurfaceProvider();
		const wake = new FileWakeRegistry();
		const supervision = new SupervisionCoordinator(
			async () => ({ complete: true, panes: [] }),
			(id) => surface.inspectSurface(id),
			false,
			wake,
		);
		const registered: [string, string][] = [];
		const register = supervision.register.bind(supervision);
		supervision.register = (sessionFile, id) => {
			registered.push([sessionFile, id]);
			return register(sessionFile, id);
		};
		try {
			const provider = new TerminalExecProvider({
				surface,
				paneConfig,
				supervision,
			});
			const { handle, launched } = await provider.launch(freshRequest(parent));
			const watched = provider.supervise(handle);
			assert.deepEqual(registered, [[launched.sessionFile, launched.surface]]);
			assert.equal((await watched.inspect()).kind, "present");
			watched.close();
			// Without a coordinator, completion polls the provider's own observe.
			const plain = new TerminalExecProvider({ surface, paneConfig });
			const own = await plain.launch(freshRequest(parent));
			const polled = plain.supervise(own.handle);
			assert.equal(
				await polled.wait(new AbortController().signal),
				"reconcile",
			);
			assert.equal((await polled.inspect()).kind, "present");
			polled.close();
			assert.equal(registered.length, 1);
		} finally {
			supervision.close();
			wake.close();
			parent.dispose();
		}
	});
});

describe("observeSupervision", () => {
	function observed() {
		const provider = new FakeExecProvider<string, string>({
			launched: (request) => request,
		});
		return provider;
	}

	it("wakes on each observed snapshot and reports it as presence", async () => {
		const provider = observed();
		const { handle } = await provider.launch("task");
		const supervision = observeSupervision(provider, handle, 5);
		const signal = new AbortController().signal;
		assert.equal(await supervision.wait(signal), "reconcile");
		assert.equal((await supervision.inspect()).kind, "present");
		assert.equal(provider.calls.includes("inspect"), false);
		provider.exit(handle);
		assert.equal(await supervision.wait(signal), "reconcile");
		// The observation ends on missing; later waits keep a steady cadence.
		assert.equal(await supervision.wait(signal), "reconcile");
		assert.equal((await supervision.inspect()).kind, "missing");
		assert.equal(await supervision.wait(signal), "reconcile");
		supervision.close();
		await assert.rejects(supervision.wait(signal), /unregistered/);
	});

	it("while a quiet observation stays open, waits still wake on a steady cadence", async () => {
		const provider = observed();
		const { handle } = await provider.launch("task");
		provider.observe = async function* (watched, options) {
			yield await provider.inspect(watched);
			await new Promise<void>((resolve) =>
				options.signal.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
		};
		const supervision = observeSupervision(provider, handle, 5);
		const signal = new AbortController().signal;
		assert.equal(await supervision.wait(signal), "reconcile");
		// No snapshot follows: a local-evidence wake, no extra presence read.
		const before = provider.calls.length;
		assert.equal(await supervision.wait(signal), "wake");
		assert.equal((await supervision.inspect()).kind, "present");
		assert.equal(provider.calls.length, before);
		supervision.close();
	});

	it("an aborted wait rejects, and close releases a parked wait", async () => {
		const provider = observed();
		const { handle } = await provider.launch("task");
		const supervision = observeSupervision(provider, handle, 60_000);
		await assert.rejects(
			supervision.wait(AbortSignal.abort()),
			/Aborted while waiting/,
		);
		const signal = new AbortController().signal;
		assert.equal(await supervision.wait(signal), "reconcile");
		const controller = new AbortController();
		const parked = supervision.wait(controller.signal);
		controller.abort();
		await assert.rejects(parked, /Aborted while waiting/);
		const released = supervision.wait(signal);
		supervision.close();
		await assert.rejects(released, /unregistered/);
	});
});

// Grok follow-up: the restore half of the persistent-send claim.
describe("persistent send claims", () => {
	const POLICY = "a".repeat(64);
	async function persistent(f: ReturnType<typeof sharedAdapterFixture>) {
		const task = f.task({ behavior: { persistent: true } });
		const handle = await f.session.spawn(task);
		const child = f.adapter.getRunningChild(handle);
		Object.assign(child, {
			generationId: "g1",
			logicalId: "l1",
			policyHash: POLICY,
			tasksCompleted: 0,
		});
		return { task, child };
	}

	it("a delivery the provider rejects restores the specialist and records no dispatch", async () =>
		usingShared({}, async (f) => {
			const { task, child } = await persistent(f);
			f.exec.exit(f.execHandle());
			await assert.rejects(f.session.send(task.id, "next task"), /not live/);
			assert.equal(child.taskId, undefined);
			assert.deepEqual(child.issuedTaskIds, []);
			assert.deepEqual(
				readPersistentDeliveryLedger(child.sessionFile).filter(
					(entry) => entry.outcome === "dispatched",
				),
				[],
			);
		}));

	it("two sends in the same turn deliver one task and refuse the other busy", async () =>
		usingShared({}, async (f) => {
			const { task, child } = await persistent(f);
			const results = await Promise.allSettled([
				f.session.send(task.id, "first"),
				f.session.send(task.id, "second"),
			]);
			assert.deepEqual(
				results.map((result) => result.status),
				["fulfilled", "rejected"],
			);
			assert.deepEqual(
				f.exec.executions[0]?.prompts.map((prompt) => prompt.text),
				["first"],
			);
			assert.deepEqual(child.issuedTaskIds, [child.taskId]);
			// The busy refusal is recorded at once; the dispatch after delivery.
			assert.deepEqual(
				readPersistentDeliveryLedger(child.sessionFile)
					.map((entry) => entry.outcome)
					.sort(),
				["dispatched", "rejected-busy"],
			);
		}));
});
