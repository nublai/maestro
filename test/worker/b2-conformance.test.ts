/**
 * P3-7: the ExecProvider conformance suite (adapter-boundary cases included)
 * for WorkerExecutionProvider against a REAL B2 fixture: pi-worker's own
 * supervisor and B2 server from a pinned, built checkout, over its private
 * Unix socket, with the exact client tarball Maestro pins. Typed children are
 * real subprocesses that report through FD 3 with Maestro's reporter. No
 * terminal is constructed on this path. Run with `npm run test:worker-b2`.
 */
import "../clean-host-env.ts";
import { describe, it } from "node:test";
import { encodeResultClaim } from "../../maestro/adapters/worker/fd-report.ts";
import type { PiExecution } from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import {
	type ExecAdapterBoundary,
	registerExecProviderConformance,
} from "../../maestro/testing/exec-provider.conformance.ts";
import {
	adapterOver,
	B2Fixture,
	composeProvider,
	freeSlot,
	freshRequest,
	parentSession,
	spawnOptions,
	spawnRequiring,
	workerOf,
} from "../helpers/worker-b2-fixture.ts";

registerExecProviderConformance(
	{ describe, it },
	"Worker (real pi-worker B2 supervisor)",
	async () => {
		const fixture = await B2Fixture.start();
		const composed = composeProvider(fixture);
		const session = parentSession();
		const { provider } = composed;
		const { adapter, launchOf } = adapterOver(provider, session);
		const boundary: ExecAdapterBoundary<PiExecution> = {
			adapter,
			spawn: (acquisitionSignal) => {
				const extra: Parameters<typeof spawnOptions>[1] = {
					worktreeRequest: { branch: freeSlot(composed.slots) },
				};
				if (acquisitionSignal) extra.acquisitionSignal = acquisitionSignal;
				return adapter.spawn(spawnOptions(session.root, extra));
			},
			spawnRequiring: (requirement) =>
				spawnRequiring(adapter, session.root, requirement),
			launchOf,
			finish: async (handle) => {
				const workerId = workerOf(provider, launchOf(handle));
				// The leaf's own report, through its FD 3, then its natural exit.
				await fixture.op("report", {
					workerId,
					kind: "result",
					message: encodeResultClaim({ type: "done", summary: "finished" }),
				});
				await fixture.op("exit", { workerId });
			},
		};
		return {
			provider,
			request: () =>
				freshRequest(session, {
					worktree: { branch: freeSlot(composed.slots) },
				}),
			acquisitions: () => fixture.op<number>("acquisitions"),
			exit: async (launch) => {
				await fixture.op("exit", { workerId: workerOf(provider, launch) });
			},
			print: async (launch, text) => {
				await fixture.op("print", {
					workerId: workerOf(provider, launch),
					text,
				});
			},
			blockStop: async (launch) => {
				await fixture.op("blockStop", { workerId: workerOf(provider, launch) });
				// The supervisor recorded the stop; its termination is not observed.
				return "unknown";
			},
			// B2 confirms a stop only once the leader process is proven gone; under
			// load a leader that is a zombie with a thread still exiting is not, so
			// a stop that did end the child is `outcome_unknown` and a later stop
			// confirms it.
			unobserveNextStop: async (launch) => {
				await fixture.op("unobserveNextStop", {
					workerId: workerOf(provider, launch),
				});
			},
			prompted: async (launch) => {
				const received = await fixture.op<
					{ command_id: string; message: string }[]
				>("prompts", { workerId: workerOf(provider, launch) });
				const inputs = new Map(
					(provider.manifest(launch.handle)?.commands ?? [])
						.filter((command) => command.purpose === "prompt")
						.map((command) => [command.command_id, command.input_id]),
				);
				return received.flatMap((prompt) => {
					const id = inputs.get(prompt.command_id);
					return id === undefined ? [] : [{ id, text: prompt.message }];
				});
			},
			adapter: boundary,
			dispose: async () => {
				await composed.dispose();
				await fixture.close();
				session.dispose();
			},
		};
	},
);
