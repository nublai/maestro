import assert from "node:assert/strict";
import { describe as nodeDescribe, it as nodeIt } from "node:test";
import {
	EXEC_REQUIREMENTS,
	execRefusal,
	type ExecHandle,
	type ExecLaunch,
	type ExecPromptInput,
	type ExecProvider,
} from "../core/exec-provider.ts";
import type { PaneInspection } from "../core/types.ts";

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
	/** Make the next stop of this execution unconfirmable. */
	blockStop?(launch: ExecLaunch<Launched>): Promise<void>;
	/** Read back the inputs `prompt` delivered to this execution. */
	prompted?(launch: ExecLaunch<Launched>): Promise<ExecPromptInput[]>;
	dispose(): Promise<void>;
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
					await fixture.blockStop(launch);
					const report = await fixture.provider.stop(launch.handle);
					assert.equal(report.termination, "unconfirmed");
					assert.ok(report.termination === "unconfirmed" && report.error);
					assert.ok(["sent", "not-sent", "unknown"].includes(report.request));
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
	});
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
