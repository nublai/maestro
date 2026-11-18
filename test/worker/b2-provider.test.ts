/**
 * P3-7 against the real B2 fixture (see b2-conformance.test.ts): prepared-slot
 * acquisition, persisted command IDs, kept uncertainty, the FD-only report
 * path and the grant closure of Maestro's method profile.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ClientFailure } from "@nublai/pi-worker-client";
import { encodeResultClaim } from "../../maestro/adapters/worker/fd-report.ts";
import {
	MAESTRO_WORKER_EXCLUDED_METHODS,
	MAESTRO_WORKER_PARENT_METHODS,
} from "../../maestro/adapters/worker/grant-profile.ts";
import {
	UUIDV7,
	WorkerLaunchStore,
} from "../../maestro/adapters/worker/launch-store.ts";
import { WorkerSlotRefusal } from "../../maestro/adapters/worker/slots.ts";
import { WorkerLaunchRefusal } from "../../maestro/adapters/worker/worker-exec-provider.ts";
import {
	adapterOver,
	B2Fixture,
	composeProvider,
	freshRequest,
	parentSession,
	spawnOptions,
	workerOf,
} from "../helpers/worker-b2-fixture.ts";

async function withFixture(
	run: (f: {
		fixture: B2Fixture;
		composed: ReturnType<typeof composeProvider>;
		session: ReturnType<typeof parentSession>;
	}) => Promise<void>,
	slots = 4,
) {
	const fixture = await B2Fixture.start(slots);
	const composed = composeProvider(fixture);
	const session = parentSession();
	try {
		await run({ fixture, composed, session });
	} finally {
		await composed.dispose();
		await fixture.close();
		session.dispose();
	}
}

/** Owner Git with a synthetic environment, never the user's configuration. */
function ownerGit(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: cwd,
			LANG: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	}).trim();
}

describe("worker provider over real B2: prepared-slot acquisition", () => {
	it("an exhausted pool is refused before any B2 create; nothing is recorded", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches } = composed;
			const first = await provider.launch(freshRequest(session));
			assert.equal(first.launchFailure, undefined);
			const before = await fixture.op<number>("acquisitions");
			await assert.rejects(
				provider.launch(freshRequest(session)),
				(error: Error) =>
					error instanceof WorkerSlotRefusal &&
					error.code === "slots_exhausted" &&
					/refused before acquisition/.test(error.message),
			);
			assert.equal(await fixture.op<number>("acquisitions"), before);
			assert.equal(launches.list().length, 1, "no second manifest");
		}, 1));

	it("a slot that no longer matches its manifest is refused before any B2 create", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { slots, provider, launches } = composed;
			const [s0] = fixture.started.slots;
			assert.ok(s0);
			ownerGit(
				fixture.started.repo,
				"worktree",
				"unlock",
				`${fixture.started.root}/.piw-slots/${s0.name}`,
			);
			await assert.rejects(
				provider.launch(freshRequest(session)),
				(error: Error) =>
					error instanceof WorkerSlotRefusal &&
					error.code === "slot_mismatch" &&
					/not locked/.test(error.message),
			);
			assert.equal(slots.holder(s0.name), undefined, "the slot is not claimed");
			assert.equal(launches.list().length, 0);
			assert.equal(await fixture.op<number>("acquisitions"), 0);
		}));

	it("the requested branch selects its slot; the claim and manifest name it exactly", () =>
		withFixture(async ({ composed, session }) => {
			const { provider, slots } = composed;
			const launch = await provider.launch(
				freshRequest(session, { worktree: { branch: "s2" } }),
			);
			const manifest = provider.manifest(launch.handle);
			assert.ok(manifest);
			assert.equal(manifest.slot.name, "s2");
			assert.equal(manifest.slot.branch, "refs/heads/maestro/s2");
			assert.equal(manifest.requested_branch, "s2");
			assert.equal(manifest.state, "acquired");
			assert.equal(slots.holder("s2"), manifest.launch_id);
			assert.equal(launch.launched.cwd, manifest.slot.path);
		}));

	it("a create the worker refuses acquires nothing, releases its slot and keeps no manifest", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, slots, launches } = composed;
			const refused = freshRequest(session);
			// Not in the parent's launch spec: the worker refuses the child's authority.
			refused.behavior = { ...refused.behavior, tools: "read,python" };
			await assert.rejects(
				provider.launch(refused),
				(error: Error) =>
					error instanceof WorkerLaunchRefusal &&
					/child_authority_not_subset/.test(error.message) &&
					/nothing acquired/.test(error.message),
			);
			assert.equal(await fixture.op<number>("acquisitions"), 0);
			assert.equal(launches.list().length, 0);
			assert.equal(slots.holder("s0"), undefined);
			const next = await provider.launch(freshRequest(session));
			assert.equal(provider.manifest(next.handle)?.slot.name, "s0");
		}));
});

describe("worker provider over real B2: commands and uncertainty", () => {
	it("every mutation has a UUIDv7 command ID and the exact request hash the worker recorded", () =>
		withFixture(async ({ composed, session }) => {
			const { provider, client } = composed;
			const launch = await provider.launch(freshRequest(session));
			await provider.prompt(launch.handle, { id: "input-1", text: "more" });
			await provider.interrupt(launch.handle);
			assert.deepEqual(await provider.stop(launch.handle), {
				request: "sent",
				termination: "confirmed",
			});
			const manifest = provider.manifest(launch.handle);
			assert.ok(manifest);
			assert.deepEqual(
				manifest.commands.map((command) => [command.purpose, command.outcome]),
				[
					["create", "observed"],
					["initial-prompt", "observed"],
					["prompt", "observed"],
					["interrupt", "observed"],
					["stop", "observed"],
				],
			);
			for (const command of manifest.commands) {
				assert.match(command.command_id, UUIDV7);
				const receipt = await client.call("receipts.get", {
					path: { command_id: command.command_id },
				});
				assert.equal(receipt.operation, command.operation);
				assert.equal(receipt.request_hash, command.request_hash);
				assert.ok(command.recorded_at <= (command.settled_at ?? 0));
			}
			assert.equal(new Set(manifest.commands.map((c) => c.command_id)).size, 5);
		}));

	it("each mutation's command is on disk before its bytes reach B2", () =>
		withFixture(async ({ composed, session }) => {
			const { provider, client, launches } = composed;
			const seen: string[] = [];
			const call = client.call.bind(client);
			// SAFETY: a pass-through wrapper with the client's own signature.
			client.call = (async (
				operation: string,
				options: { body?: { command_id?: string } },
			) => {
				const commandId = options?.body?.command_id;
				if (commandId) {
					// A fresh reader of the directory: only durable state counts.
					const fresh = new WorkerLaunchStore(launches.dir);
					const recorded = fresh
						.list()
						.flatMap((manifest) => manifest.commands)
						.find((command) => command.command_id === commandId);
					assert.equal(
						recorded?.outcome,
						"pending",
						`${operation} recorded first`,
					);
					assert.equal(recorded?.operation, operation);
					seen.push(operation);
				}
				// SAFETY: forwards the caller's own operation and options unchanged.
				return call(operation as never, options as never);
			}) as typeof client.call;
			const launch = await provider.launch(freshRequest(session));
			await provider.prompt(launch.handle, { id: "next", text: "more" });
			await provider.interrupt(launch.handle);
			await provider.stop(launch.handle);
			assert.deepEqual(seen, [
				"workers.create",
				"sessions.prompt",
				"sessions.prompt",
				"executions.interrupt",
				"workers.stop",
			]);
		}));

	it("a lost initial-prompt reply keeps the worker owned and uncertain, and the prompt is never re-sent", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			await fixture.op("uncertainNextLaunch");
			const launch = await provider.launch(freshRequest(session));
			assert.match(
				launch.launchFailure ?? "",
				/initial prompt outcome unknown.*never re-sent/,
			);
			const workerId = workerOf(provider, launch);
			const manifest = provider.manifest(launch.handle);
			assert.ok(manifest);
			assert.equal(manifest.state, "acquired");
			assert.match(manifest.uncertainty ?? "", /outcome unknown/);
			const prompt = manifest.commands.find(
				(c) => c.purpose === "initial-prompt",
			);
			assert.equal(prompt?.outcome, "unknown");
			assert.equal(prompt?.reason, "outcome_unknown");
			// The worker fenced the child's session on that prompt; nothing was sent twice.
			assert.equal(
				(await fixture.row(workerId)).fence?.command_id,
				prompt?.command_id,
			);
			assert.equal(
				(await fixture.op<unknown[]>("prompts", { workerId })).length,
				1,
			);
			// Through the shared adapter the next uncertain launch keeps its uncertainty on the run.
			const { adapter } = adapterOver(provider, session);
			await fixture.op("uncertainNextLaunch");
			const handle = await adapter.spawn(spawnOptions(session.root));
			assert.match(
				handle.launchFailure ?? "",
				/initial prompt outcome unknown/,
			);
		}));

	it("a refused input is not delivered and is never retried under the same command", () =>
		withFixture(async ({ composed, session }) => {
			const { provider } = composed;
			const launch = await provider.launch(freshRequest(session));
			await assert.rejects(
				provider.prompt(launch.handle, { id: "slash", text: "/compact" }),
				/refused input slash \(slash_commands_use_typed_methods\); not delivered/,
			);
			const command = provider
				.manifest(launch.handle)
				?.commands.find((c) => c.input_id === "slash");
			assert.equal(command?.outcome, "no_effect");
		}));
});

describe("worker provider over real B2: the FD-only report path", () => {
	it("a typed child gets FD 3 and no socket or grant; its FD report completes the run through the adapter", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			const { adapter, launchOf } = adapterOver(provider, session);
			const handle = await adapter.spawn(spawnOptions(session.root));
			const launch = launchOf(handle);
			const workerId = workerOf(provider, launch);
			assert.deepEqual(await fixture.op("env", { workerId }), {
				report_fd: "3",
				has_socket: false,
				has_grant: false,
			});
			await fixture.op("print", { workerId, text: "the change is ready" });
			const waiting = adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			// A help claim is kept, never a completion.
			await fixture.op("report", {
				workerId,
				kind: "help",
				message: "which file?",
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			await fixture.op("report", {
				workerId,
				kind: "result",
				message: encodeResultClaim({ type: "done", summary: "done" }),
			});
			const evidence = await waiting;
			assert.equal(evidence.reason, "done");
			assert.equal(evidence.exitCode, 0);
			// The final message is the child's own history, mirrored from B2.
			assert.equal(evidence.finalMessage?.text, "the change is ready");
			assert.deepEqual(
				provider.help(launch.handle).map((claim) => claim.message),
				["which file?"],
			);
			const row = await fixture.row(workerId);
			assert.deepEqual(
				row.child_reports?.map((claim) => claim.kind),
				["help", "result"],
			);
			// The report arrived through the child's FD 3: its receipt names the channel.
			const result = row.child_reports?.find(
				(claim) => claim.kind === "result",
			);
			const receipt = await composed.client.call("receipts.get", {
				path: { command_id: result!.command_id },
			});
			assert.equal(receipt.operation, "children.report");
			assert.equal(receipt.result?.channel, "fd3");
			assert.equal(receipt.result?.claim_not_verified, true);
		}));

	it("an invalid result claim completes as an error, never as done", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			const { adapter, launchOf } = adapterOver(provider, session);
			const handle = await adapter.spawn(spawnOptions(session.root));
			const workerId = workerOf(provider, launchOf(handle));
			const waiting = adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			await fixture.op("report", {
				workerId,
				kind: "result",
				message: "all good, trust me",
			});
			const evidence = await waiting;
			assert.equal(evidence.reason, "error");
			assert.match(
				evidence.errorMessage ?? "",
				/Invalid subagent completion sidecar/,
			);
			const child = adapter.getRunningChild(handle);
			assert.ok(existsSync(child.sessionFile));
			assert.doesNotMatch(readFileSync(child.sessionFile, "utf8"), /trust me/);
		}));

	it("a child that exits without a report completes as an error after the report drain", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			const { adapter, launchOf } = adapterOver(provider, session);
			const handle = await adapter.spawn(spawnOptions(session.root));
			const workerId = workerOf(provider, launchOf(handle));
			const waiting = adapter.awaitCompletion(
				handle,
				new AbortController().signal,
			);
			await fixture.op("exit", { workerId });
			const evidence = await waiting;
			assert.equal(evidence.reason, "error");
			assert.match(
				evidence.errorMessage ?? "",
				/disappeared before completion evidence/,
			);
		}));
});

describe("worker provider over real B2: Maestro's grant profile", () => {
	it("the profile is explicit, never `*`, and excludes owner reconciliation and steering", () => {
		for (const method of MAESTRO_WORKER_EXCLUDED_METHODS)
			assert.equal(
				MAESTRO_WORKER_PARENT_METHODS.includes(method),
				false,
				method,
			);
		assert.ok(MAESTRO_WORKER_PARENT_METHODS.includes("children.report"));
	});

	it("a foreign-root worker, its receipts and its events stay invisible to the scoped grant", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { client, provider } = composed;
			const foreign = await fixture.op<{ workerId: string; commandId: string }>(
				"foreign",
			);
			await assert.rejects(
				client.call("workers.get", { path: { worker_id: foreign.workerId } }),
				(error: Error) =>
					error instanceof ClientFailure &&
					error.message === "grant_scope_denied",
			);
			await assert.rejects(
				client.call("receipts.get", {
					path: { command_id: foreign.commandId },
				}),
				(error: Error) =>
					error instanceof ClientFailure &&
					error.message === "grant_scope_denied",
			);
			// The profile carries no workers.list: the grant refuses it outright.
			await assert.rejects(
				client.call("workers.list", {}),
				(error: Error) =>
					error instanceof ClientFailure &&
					error.message === "grant_method_denied",
			);
			await provider.launch(freshRequest(session));
			const seen: string[] = [];
			const controller = new AbortController();
			const watching = client
				.watch(
					(frame) => {
						if (frame.type === "snapshot")
							for (const worker of frame.workers) seen.push(worker.worker_id);
						return false;
					},
					{ signal: controller.signal },
				)
				.catch(() => undefined);
			await watching;
			assert.ok(seen.includes(fixture.started.parentWorkerId));
			assert.equal(seen.includes(foreign.workerId), false);
		}));

	it("records the P2-8 channel gap: its whitelist lacks executions.interrupt", () =>
		withFixture(async ({ fixture }) => {
			// A sandboxed parent's channel serves only its whitelist; Maestro's profile
			// asks for exactly one method more (children.report is the child's ceiling).
			assert.deepEqual(
				MAESTRO_WORKER_PARENT_METHODS.filter(
					(method) => !fixture.started.channelMethods.includes(method),
				),
				["executions.interrupt", "children.report"],
			);
		}));
});
