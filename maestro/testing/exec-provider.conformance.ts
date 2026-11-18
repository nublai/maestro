import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import {
	EXEC_REQUIREMENTS,
	execRefusal,
	type ExecHandle,
	type ExecLaunch,
	type ExecPromptInput,
	type ExecProvider,
	type ExecRequirement,
	type ExecStopRequest,
} from "../core/exec-provider.ts";
import type { HarnessAdapter } from "../core/harness-adapter.ts";
import type { AgentHandle, PaneInspection } from "../core/types.ts";

interface TestRunner {
	describe: typeof nodeDescribe;
	it: typeof nodeIt;
}

export interface ExecProviderFixture<Launch, Launched> {
	provider: ExecProvider<Launch, Launched>;
	/** A request this provider runs with its declared capabilities. */
	request(): Launch;
	/** Resources acquired so far (surfaces, programs, workers). */
	acquisitions(): number | Promise<number>;
	/** End the execution on its own, as a natural exit would. */
	exit(launch: ExecLaunch<Launched>): Promise<void>;
	/** Make the execution print `text`, which `read` must return. */
	print(launch: ExecLaunch<Launched>, text: string): Promise<void>;
	/**
	 * Make the next stop of this execution unconfirmable, leaving it live.
	 * Resolves with the request state that stop must report (`sent` only when
	 * the request provably reached the execution).
	 */
	blockStop?(launch: ExecLaunch<Launched>): Promise<ExecStopRequest>;
	/** Read back the inputs `prompt` delivered to this execution. */
	prompted?(launch: ExecLaunch<Launched>): Promise<ExecPromptInput[]>;
	/**
	 * The shared harness adapter over this same provider. When present, the
	 * suite also drives the adapter boundary, not only direct provider calls.
	 */
	adapter?: ExecAdapterBoundary<Launched>;
	dispose(): Promise<void>;
}

/** The shared harness adapter composed over a fixture's provider. */
export interface ExecAdapterBoundary<Launched> {
	adapter: HarnessAdapter;
	/** Spawn one ordinary run through the adapter. */
	spawn(acquisitionSignal?: AbortSignal): Promise<AgentHandle>;
	/** Launch (or resume) through the adapter a run that needs `requirement`. */
	spawnRequiring(requirement: ExecRequirement): Promise<AgentHandle>;
	/** The provider launch behind a handle the adapter returned. */
	launchOf(handle: AgentHandle): ExecLaunch<Launched>;
	/** The next launch acquires but reports its dispatch uncertain. */
	uncertainNextLaunch?(reason: string): void;
	/**
	 * Record the run's own `done` completion evidence and end it naturally,
	 * while `awaitCompletion` waits on it. The fixture may also check that the
	 * wait is supervised the way its host composes supervision.
	 */
	finish?(handle: AgentHandle): Promise<void>;
}

const BOOLEAN_CAPABILITIES = [
	...EXEC_REQUIREMENTS,
	"executionExit",
] as const satisfies readonly (keyof ExecProviderFixture<
	unknown,
	unknown
>["provider"]["capabilities"])[];

/** The ExecProvider contract every implementation (fake, terminal, worker) meets. */
export function registerExecProviderConformance<Launch, Launched>(
	runner: TestRunner,
	name: string,
	factory: () => Promise<ExecProviderFixture<Launch, Launched>>,
): void {
	runner.describe(`${name} ExecProvider conformance`, () => {
		runner.it("isAvailable returns a boolean and never throws", async () => {
			await usingFixture(factory, async ({ provider }) => {
				const available = provider.isAvailable();
				assert.ok(available === true || available === false);
			});
		});

		runner.it(
			"declares every capability explicitly and refuses exactly the missing ones",
			async () => {
				await usingFixture(factory, async ({ provider }) => {
					for (const key of BOOLEAN_CAPABILITIES)
						assert.ok(
							provider.capabilities[key] === true ||
								provider.capabilities[key] === false,
							key,
						);
					assert.ok(
						["best-effort", "receipt"].includes(
							provider.capabilities.parentAdmission,
						),
					);
					for (const requirement of EXEC_REQUIREMENTS) {
						const refusal = execRefusal(provider, [requirement]);
						if (provider.capabilities[requirement])
							assert.equal(refusal, undefined, requirement);
						else assert.ok(refusal && refusal.length > 0, requirement);
					}
					assert.equal(execRefusal(provider, []), undefined);
				});
			},
		);

		runner.it(
			"launch issues distinct opaque handles from this provider with its capabilities",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { provider } = fixture;
					const before = await fixture.acquisitions();
					const first = await provider.launch(fixture.request());
					const second = await provider.launch(fixture.request());
					for (const { handle, launchFailure } of [first, second]) {
						assert.equal(handle.provider, provider.name);
						assert.ok(handle.ref.length > 0);
						assert.deepEqual(handle.capabilities, provider.capabilities);
						assert.equal(launchFailure, undefined);
					}
					assert.notEqual(first.handle.ref, second.handle.ref);
					assert.equal(await fixture.acquisitions(), before + 2);
				});
			},
		);

		runner.it(
			"a reference is opaque: no path, PID or surface ID, and only its issuer resolves it",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { provider } = fixture;
					const { handle } = await provider.launch(fixture.request());
					assert.doesNotMatch(handle.ref, /[\\/]/, "a path");
					assert.doesNotMatch(handle.ref, /^\d+$/, "a PID");
					if (handle.surfaceId !== undefined) {
						assert.ok(handle.surfaceId.length > 0);
						assert.notEqual(handle.ref, handle.surfaceId);
						// The surface ID cannot stand in for the reference.
						await assert.rejects(
							provider.inspect({ ...handle, ref: handle.surfaceId }),
						);
					}
					await assert.rejects(
						provider.inspect({ ...handle, provider: `${provider.name}-other` }),
					);
					assert.equal((await provider.inspect(handle)).kind, "present");
				});
			},
		);

		runner.it("an aborted launch acquires nothing", async () => {
			await usingFixture(factory, async (fixture) => {
				const before = await fixture.acquisitions();
				const controller = new AbortController();
				controller.abort();
				await assert.rejects(
					fixture.provider.launch(fixture.request(), {
						signal: controller.signal,
					}),
				);
				assert.equal(await fixture.acquisitions(), before);
			});
		});

		runner.it(
			"inspect and reconcile report a live execution as present and live",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { handle } = await fixture.provider.launch(fixture.request());
					assert.equal(
						(await fixture.provider.inspect(handle)).kind,
						"present",
					);
					assert.deepEqual(await fixture.provider.reconcile(handle), {
						kind: "live",
					});
				});
			},
		);

		runner.it(
			"observe yields the current snapshot first and ends when its signal aborts",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { handle } = await fixture.provider.launch(fixture.request());
					const controller = new AbortController();
					const seen: PaneInspection[] = [];
					for await (const snapshot of fixture.provider.observe(handle, {
						signal: controller.signal,
						intervalMs: 5,
					})) {
						seen.push(snapshot);
						if (seen.length === 2) controller.abort();
					}
					assert.ok(seen.length >= 1 && seen.length <= 2);
					assert.equal(seen[0]!.kind, "present");
				});
			},
		);

		runner.it("read returns what the execution printed", async () => {
			await usingFixture(factory, async (fixture) => {
				const launch = await fixture.provider.launch(fixture.request());
				await fixture.print(launch, "exec-conformance-marker");
				assert.match(
					await fixture.provider.read(launch.handle),
					/exec-conformance-marker/,
				);
				const tail = await fixture.provider.read(launch.handle, 1);
				assert.equal(tail.split("\n").length, 1);
			});
		});

		runner.it(
			"interrupt resolves for a live execution and leaves it live",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { handle } = await fixture.provider.launch(fixture.request());
					await fixture.provider.interrupt(handle);
					assert.deepEqual(await fixture.provider.reconcile(handle), {
						kind: "live",
					});
				});
			},
		);

		runner.it(
			"prompt delivers input to a live execution once, in order",
			async (t) => {
				await usingFixture(factory, async (fixture) => {
					if (!fixture.prompted)
						return t.skip("fixture has no prompt readback");
					const launch = await fixture.provider.launch(fixture.request());
					await fixture.provider.prompt(launch.handle, {
						id: "task-1",
						text: "first",
					});
					await fixture.provider.prompt(launch.handle, {
						id: "task-2",
						text: "second",
					});
					assert.deepEqual(await fixture.prompted(launch), [
						{ id: "task-1", text: "first" },
						{ id: "task-2", text: "second" },
					]);
				});
			},
		);

		runner.it(
			"stop confirms termination of a live execution, which is then not live",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const { handle } = await fixture.provider.launch(fixture.request());
					const report = await fixture.provider.stop(handle);
					assert.deepEqual(report, {
						request: "sent",
						termination: "confirmed",
					});
					assert.notEqual(
						(await fixture.provider.reconcile(handle)).kind,
						"live",
					);
				});
			},
		);

		runner.it(
			"an unconfirmed stop is a report carrying its error, never a rejection",
			async (t) => {
				await usingFixture(factory, async (fixture) => {
					if (!fixture.blockStop) return t.skip("fixture cannot block a stop");
					const launch = await fixture.provider.launch(fixture.request());
					const request = await fixture.blockStop(launch);
					const report = await fixture.provider.stop(launch.handle);
					assert.equal(report.termination, "unconfirmed");
					assert.ok(report.termination === "unconfirmed" && report.error);
					// Sent is not confirmed: the request state is reported as it is.
					assert.equal(report.request, request);
					assert.deepEqual(await fixture.provider.reconcile(launch.handle), {
						kind: "live",
					});
				});
			},
		);

		runner.it(
			"after a natural exit reconcile is not live and observe ends on missing",
			async () => {
				await usingFixture(factory, async (fixture) => {
					const launch = await fixture.provider.launch(fixture.request());
					await fixture.exit(launch);
					const reconciled = await fixture.provider.reconcile(launch.handle);
					assert.ok(
						reconciled.kind === "finished" || reconciled.kind === "missing",
						reconciled.kind,
					);
					if (
						launch.handle.capabilities.executionExit &&
						reconciled.kind === "finished"
					)
						assert.equal(reconciled.exitCode ?? 0, 0);
					const controller = new AbortController();
					const seen: PaneInspection[] = [];
					const timer = setTimeout(() => controller.abort(), 2_000);
					try {
						for await (const snapshot of fixture.provider.observe(
							launch.handle,
							{ signal: controller.signal, intervalMs: 5 },
						)) {
							seen.push(snapshot);
							if (snapshot.kind === "missing") break;
						}
					} finally {
						clearTimeout(timer);
					}
					assert.equal(controller.signal.aborted, false);
					assert.equal(seen.at(-1)?.kind, "missing");
				});
			},
		);

		runner.it("a handle this provider did not issue is refused", async () => {
			await usingFixture(factory, async ({ provider }) => {
				const foreign: ExecHandle = {
					provider: provider.name,
					ref: "never-issued",
					capabilities: provider.capabilities,
				};
				await assert.rejects(provider.inspect(foreign));
				await assert.rejects(provider.read(foreign));
				await assert.rejects(provider.interrupt(foreign));
				await assert.rejects(provider.stop(foreign));
				await assert.rejects(provider.reconcile(foreign));
			});
		});

		registerAdapterBoundary(runner, factory);
	});
}

/** The same contract seen through the shared harness adapter. */
function registerAdapterBoundary<Launch, Launched>(
	runner: TestRunner,
	factory: () => Promise<ExecProviderFixture<Launch, Launched>>,
): void {
	const adapterCase = (
		title: string,
		run: (
			fixture: ExecProviderFixture<Launch, Launched>,
			boundary: ExecAdapterBoundary<Launched>,
			skip: (reason: string) => void,
		) => Promise<void>,
	) =>
		runner.it(`adapter boundary: ${title}`, async (t) => {
			await usingFixture(factory, async (fixture) => {
				if (!fixture.adapter) return t.skip("fixture composes no adapter");
				await run(fixture, fixture.adapter, (reason) => t.skip(reason));
			});
		});

	adapterCase(
		"every missing capability is refused before any acquisition",
		async (fixture, boundary) => {
			const { provider } = fixture;
			const missing = EXEC_REQUIREMENTS.filter(
				(requirement) => !provider.capabilities[requirement],
			);
			const refusals = missing.map((requirement) =>
				execRefusal(provider, [requirement]),
			);
			const before = await fixture.acquisitions();
			for (const requirement of missing)
				await assert.rejects(
					boundary.spawnRequiring(requirement),
					(error: Error) => refusals.includes(error.message),
					requirement,
				);
			assert.equal(await fixture.acquisitions(), before);
		},
	);

	adapterCase(
		"an aborted acquisition signal acquires nothing",
		async (fixture, boundary) => {
			const before = await fixture.acquisitions();
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(boundary.spawn(controller.signal));
			assert.equal(await fixture.acquisitions(), before);
		},
	);

	adapterCase(
		"the run handle carries the provider's own surface, never its reference",
		async (fixture, boundary) => {
			const before = await fixture.acquisitions();
			const handle = await boundary.spawn();
			assert.equal(await fixture.acquisitions(), before + 1);
			const { handle: exec, launchFailure } = boundary.launchOf(handle);
			assert.equal(launchFailure, undefined);
			assert.equal(handle.launchFailure, undefined);
			assert.equal("surfaceId" in handle, exec.surfaceId !== undefined);
			assert.equal(handle.surfaceId, exec.surfaceId);
			assert.ok(!JSON.stringify(handle).includes(exec.ref));
		},
	);

	adapterCase(
		"read and stop go through the provider; an unconfirmed stop keeps the run live",
		async (fixture, boundary) => {
			const { adapter } = boundary;
			const handle = await boundary.spawn();
			const launch = boundary.launchOf(handle);
			await fixture.print(launch, "exec-adapter-marker");
			assert.match(await adapter.readOutput(handle), /exec-adapter-marker/);
			if (fixture.blockStop) {
				await fixture.blockStop(launch);
				await assert.rejects(adapter.kill(handle));
				assert.deepEqual(await fixture.provider.reconcile(launch.handle), {
					kind: "live",
				});
				const other = await boundary.spawn();
				await adapter.kill(other);
				const stopped = boundary.launchOf(other).handle;
				assert.notEqual(
					(await fixture.provider.reconcile(stopped)).kind,
					"live",
				);
			} else {
				await adapter.kill(handle);
				assert.notEqual(
					(await fixture.provider.reconcile(launch.handle)).kind,
					"live",
				);
			}
		},
	);

	adapterCase(
		"an acquired but uncertain launch stays owned and marked uncertain",
		async (fixture, boundary, skip) => {
			if (!boundary.uncertainNextLaunch)
				return skip("fixture cannot make a launch uncertain");
			const before = await fixture.acquisitions();
			boundary.uncertainNextLaunch("dispatch outcome unknown");
			const handle = await boundary.spawn();
			assert.equal(await fixture.acquisitions(), before + 1);
			assert.equal(handle.launchFailure, "dispatch outcome unknown");
		},
	);

	adapterCase(
		"recorded completion evidence completes the run through awaitCompletion",
		async (_fixture, boundary, skip) => {
			if (!boundary.finish)
				return skip("fixture cannot record completion evidence");
			const handle = await boundary.spawn();
			const controller = new AbortController();
			const waiting = boundary.adapter.awaitCompletion(
				handle,
				controller.signal,
			);
			// A wait that never wakes fails here rather than hanging the suite.
			const timer = setTimeout(() => controller.abort(), 5_000);
			try {
				await boundary.finish(handle);
				const evidence = await waiting;
				assert.equal(evidence.reason, "done");
				assert.equal(evidence.exitCode, 0);
			} finally {
				clearTimeout(timer);
				controller.abort();
			}
		},
	);
}

async function usingFixture<Launch, Launched>(
	factory: () => Promise<ExecProviderFixture<Launch, Launched>>,
	run: (fixture: ExecProviderFixture<Launch, Launched>) => Promise<void>,
): Promise<void> {
	const fixture = await factory();
	try {
		await run(fixture);
	} finally {
		await fixture.dispose();
	}
}
