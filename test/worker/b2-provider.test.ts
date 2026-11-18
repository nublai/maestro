/**
 * P3-7 against the real B2 fixture (see b2-conformance.test.ts): prepared-slot
 * acquisition, persisted command IDs, kept uncertainty, the FD-only report
 * path and the grant closure of Maestro's method profile.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ClientFailure, type Receipt } from "@nublai/pi-worker-client";
import type {
	ExecHandle,
	ExecStopReport,
} from "../../maestro/core/exec-provider.ts";
import { isAcquisitionUncertainError } from "../../maestro/core/surface-provider.ts";
import { createRunSession } from "../../maestro/runtime/run-session.ts";
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
import {
	WorkerCommandUncertain,
	WorkerLaunchRefusal,
} from "../../maestro/adapters/worker/worker-exec-provider.ts";
import {
	adapterOver,
	B2Fixture,
	composeProvider,
	freshRequest,
	parentSession,
	role,
	spawnOptions,
	workerOf,
} from "../helpers/worker-b2-fixture.ts";

/**
 * The launch store fails every write from the moment the `nth` B2 reply to
 * `operation` arrives: its directory turns read-only (a full disk or a lost
 * mount, as the provider sees it). The reply itself is returned unchanged.
 * The parent's next `workers.get` (a new launch starting) restores it.
 */
interface StoreFault {
	seen: number;
	broken: boolean;
	/** The reply after which the store failed. */
	reply?: Receipt;
}

function failStoreAfter(
	composed: ReturnType<typeof composeProvider>,
	parentWorkerId: string,
	operation: string,
	nth = 1,
) {
	const { client, launches } = composed;
	const call = client.call.bind(client);
	const state: StoreFault = { seen: 0, broken: false };
	const restore = () => {
		if (!state.broken) return;
		chmodSync(launches.dir, 0o700);
		state.broken = false;
	};
	// SAFETY: a pass-through wrapper with the client's own signature.
	client.call = (async (
		op: string,
		options: { path?: { worker_id?: string } },
	) => {
		if (op === "workers.get" && options?.path?.worker_id === parentWorkerId)
			restore();
		// SAFETY: forwards the caller's own operation and options unchanged.
		const reply = await call(op as never, options as never);
		if (op === operation && ++state.seen === nth) {
			// SAFETY: a mutation's reply is its receipt.
			state.reply = reply as Receipt;
			chmodSync(launches.dir, 0o500);
			state.broken = true;
		}
		return reply;
	}) as typeof client.call;
	return { state, restore };
}

/** A stop whose child B2 did not observe ending: `outcome_unknown`, the worker owned. */
function unobservedStop(report: ExecStopReport): boolean {
	return (
		report.termination === "unconfirmed" &&
		report.request === "unknown" &&
		report.error instanceof WorkerCommandUncertain &&
		/ stop not confirmed \(outcome_unknown\)/.test(report.error.message)
	);
}

/**
 * Stops and asserts that B2 confirmed. B2 confirms a stop only once the
 * child's leader is proven gone, and under load a leader that is a zombie with
 * a thread still exiting is not: that stop is `outcome_unknown` and the worker
 * stays owned. Only such a stop is followed by another, as an owner may send
 * one, at most twice. The later stop confirms, either sending its own command
 * or finding that B2 has meanwhile observed the child's exit (`not-sent`).
 * `stops` is the outcome each stop command recorded, in order.
 */
async function stopConfirmed(
	provider: ReturnType<typeof composeProvider>["provider"],
	handle: ExecHandle,
) {
	let unobserved = 0;
	let report = await provider.stop(handle);
	while (unobserved < 2 && unobservedStop(report)) {
		unobserved++;
		report = await provider.stop(handle);
	}
	if (unobserved === 0)
		assert.deepEqual(report, { request: "sent", termination: "confirmed" });
	else assert.equal(report.termination, "confirmed");
	const stops = Array.from({ length: unobserved }, () => "unknown");
	if (report.request === "sent") stops.push("observed");
	return { stops };
}

async function withFixture(
	run: (f: {
		fixture: B2Fixture;
		composed: ReturnType<typeof composeProvider>;
		session: ReturnType<typeof parentSession>;
	}) => Promise<void>,
	slots = 4,
	overrides: Parameters<typeof composeProvider>[1] = {},
) {
	const fixture = await B2Fixture.start(slots);
	const composed = composeProvider(fixture, overrides);
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

describe("worker provider over real B2: invariant 4a (kept; P3-10 owns the handoff)", () => {
	it("stopping a child that never reported fences its parent; the provider neither clears the fence nor launches a replacement", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			const launch = await provider.launch(freshRequest(session));
			await stopConfirmed(provider, launch.handle);
			const parent = await fixture.row(fixture.started.parentWorkerId);
			assert.ok(parent.fence, "the worker fenced the parent");
			await assert.rejects(
				provider.launch(freshRequest(session)),
				(error: Error) =>
					error instanceof WorkerLaunchRefusal &&
					/no running, unfenced execution/.test(error.message),
			);
			assert.equal(await fixture.op<number>("acquisitions"), 1);
			assert.deepEqual(
				(await fixture.row(fixture.started.parentWorkerId)).fence,
				parent.fence,
			);
		}));
});

describe("worker provider over real B2: the role identity", () => {
	it("a request to replace the system prompt is refused before acquisition; append travels as the preamble", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches, slots } = composed;
			const replace = freshRequest(session);
			replace.behavior = {
				...replace.behavior,
				identity: "You are the reviewer.",
				systemPromptMode: "replace",
			};
			await assert.rejects(
				provider.launch(replace),
				(error: Error) =>
					error instanceof WorkerLaunchRefusal &&
					/cannot replace a child's system prompt.*refused before acquisition/.test(
						error.message,
					),
			);
			assert.equal(await fixture.op<number>("acquisitions"), 0);
			assert.equal(launches.list().length, 0);
			assert.equal(slots.holder("s0"), undefined);
			const append = freshRequest(session);
			append.behavior = {
				...append.behavior,
				identity: "You are the reviewer.",
				systemPromptMode: "append",
			};
			const launch = await provider.launch(append);
			assert.equal(launch.launchFailure, undefined);
			const [prompt] = await fixture.op<{ message: string }[]>("prompts", {
				workerId: workerOf(provider, launch),
			});
			assert.match(
				prompt?.message ?? "",
				/^You are the reviewer\.\n\n---\n\nTask:\n/,
			);
		}));
});

describe("worker provider over real B2: commands and uncertainty", () => {
	it("every mutation has a UUIDv7 command ID and the exact request hash the worker recorded", () =>
		withFixture(async ({ composed, session }) => {
			const { provider, client } = composed;
			const launch = await provider.launch(freshRequest(session));
			await provider.prompt(launch.handle, { id: "input-1", text: "more" });
			await provider.interrupt(launch.handle);
			const { stops } = await stopConfirmed(provider, launch.handle);
			const manifest = provider.manifest(launch.handle);
			assert.ok(manifest);
			assert.deepEqual(
				manifest.commands.map((command) => [command.purpose, command.outcome]),
				[
					["create", "observed"],
					["initial-prompt", "observed"],
					["prompt", "observed"],
					["interrupt", "observed"],
					...stops.map((outcome) => ["stop", outcome]),
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
			assert.equal(
				new Set(manifest.commands.map((c) => c.command_id)).size,
				4 + stops.length,
			);
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

describe("worker provider over real B2: a store failure after dispatch", () => {
	it("after workers.create: the acquired worker is returned owned with an explicit failure; nothing more is sent", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, slots } = composed;
			const fault = failStoreAfter(
				composed,
				fixture.started.parentWorkerId,
				"workers.create",
			);
			let launch;
			try {
				launch = await provider.launch(freshRequest(session));
			} finally {
				fault.restore();
			}
			const workerId = fault.state.reply?.worker_id;
			assert.ok(workerId, "the worker acquired one child");
			assert.match(
				launch.launchFailure ?? "",
				/acquired.*could not be recorded.*not prompted, retained/,
			);
			assert.equal(await fixture.op<number>("acquisitions"), 1);
			assert.equal(
				(await fixture.op<unknown[]>("prompts", { workerId })).length,
				0,
				"no initial prompt after the failed write",
			);
			// The original command, manifest and slot stay as they were.
			const manifest = provider.manifest(launch.handle);
			assert.equal(manifest?.state, "creating");
			assert.deepEqual(
				manifest?.commands.map((c) => [c.purpose, c.outcome]),
				[["create", "pending"]],
			);
			assert.equal(slots.holder(manifest.slot.name), manifest.launch_id);
			// It is owned: the provider stops exactly that worker.
			await stopConfirmed(provider, launch.handle);
			assert.equal((await fixture.row(workerId)).status, "stopped");
		}));

	// Worktree tasks take no model fallbacks; the unsafe path was a plain rejection
	// the caller may retry, acquiring a second child (review reproduction).
	it("after workers.create: the shared owner registers that owner instead of a retryable failure", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches } = composed;
			const { adapter } = adapterOver(provider, session);
			const runs = createRunSession({
				adapter,
				roles: [role],
				cwd: session.root,
			});
			const fault = failStoreAfter(
				composed,
				fixture.started.parentWorkerId,
				"workers.create",
			);
			let handle;
			try {
				handle = await runs.spawn({
					id: "post-create",
					name: "post-create",
					role: role.name,
					prompt: "bounded task",
					cwd: session.root,
					worktree: { branch: "w" },
					runtime: { model: "fake/test", thinking: "off" },
				});
			} finally {
				fault.restore();
			}
			assert.match(handle.launchFailure ?? "", /could not be recorded/);
			assert.equal(runs.getHandle("post-create"), handle);
			assert.equal(
				await fixture.op<number>("acquisitions"),
				1,
				"no replacement acquisition",
			);
			assert.equal(launches.list().length, 1, "no second manifest");
		}));

	// The review reproduction: a missing template threw after workers.create, the
	// shared owner saw a plain rejection, and its retry acquired a second child.
	it("an initial prompt that cannot be prepared acquires nothing; the shared owner's retry acquires one child", async () => {
		const templates = mkdtempSync(join(tmpdir(), "maestro-template-"));
		const template = join(templates, "task.md");
		const task = {
			id: "templated",
			name: "templated",
			role: role.name,
			prompt: "bounded task",
			cwd: "",
			worktree: { branch: "w" },
			runtime: { model: "fake/test", thinking: "off" as const },
		};
		try {
			await withFixture(
				async ({ fixture, composed, session }) => {
					const { provider, launches, slots } = composed;
					const { adapter } = adapterOver(provider, session);
					const runs = createRunSession({
						adapter,
						roles: [role],
						cwd: session.root,
					});
					task.cwd = session.root;
					await assert.rejects(
						runs.spawn(task),
						(error: Error) =>
							/ENOENT/.test(error.message) &&
							!isAcquisitionUncertainError(error),
					);
					assert.equal(
						await fixture.op<number>("acquisitions"),
						0,
						"a plain rejection acquired nothing",
					);
					assert.equal(runs.getHandle("templated"), undefined);
					assert.equal(launches.list().length, 0, "no manifest");
					assert.equal(slots.holder("s0"), undefined, "no slot claim");
					writeFileSync(template, "From the template.");
					const handle = await runs.spawn(task);
					assert.equal(handle.launchFailure, undefined);
					assert.equal(runs.getHandle("templated"), handle);
					assert.equal(await fixture.op<number>("acquisitions"), 1);
					const [manifest] = launches.list();
					assert.equal(launches.list().length, 1);
					const prompts = await fixture.op<{ message: string }[]>("prompts", {
						workerId: manifest?.worker_id,
					});
					assert.deepEqual(
						prompts.map((p) => p.message),
						["From the template.\n\nbounded task"],
					);
				},
				4,
				{
					initialPrompt: (request) =>
						`${readFileSync(template, "utf8")}\n\n${request.task}`,
				},
			);
		} finally {
			rmSync(templates, { recursive: true, force: true });
		}
	});

	it("any other failure after workers.create: the shared owner registers the acquired owner; nothing more is sent", async () => {
		// The provider's clock fails once, at the first reading after the create's reply.
		const clock = { armed: false };
		await withFixture(
			async ({ fixture, composed, session }) => {
				const { provider, launches, client } = composed;
				const call = client.call.bind(client);
				// SAFETY: a pass-through wrapper with the client's own signature.
				client.call = (async (
					op: string,
					options: { path?: { worker_id?: string } },
				) => {
					// SAFETY: forwards the caller's own operation and options unchanged.
					const reply = await call(op as never, options as never);
					if (op === "workers.create") clock.armed = true;
					return reply;
				}) as typeof client.call;
				const { adapter } = adapterOver(provider, session);
				const runs = createRunSession({
					adapter,
					roles: [role],
					cwd: session.root,
				});
				const handle = await runs.spawn({
					id: "clock",
					name: "clock",
					role: role.name,
					prompt: "bounded task",
					cwd: session.root,
					worktree: { branch: "w" },
					runtime: { model: "fake/test", thinking: "off" },
				});
				assert.match(
					handle.launchFailure ?? "",
					/acquired, but its launch failed after acquisition \(clock failed\); retained and owned/,
				);
				assert.equal(runs.getHandle("clock"), handle);
				assert.equal(await fixture.op<number>("acquisitions"), 1);
				const [manifest] = launches.list();
				assert.equal(launches.list().length, 1, "no second manifest");
				assert.match(manifest?.uncertainty ?? "", /clock failed/);
				assert.deepEqual(
					manifest?.commands.map((c) => [c.purpose, c.outcome]),
					[["create", "observed"]],
					"no initial prompt was recorded or sent",
				);
				assert.equal(
					(
						await fixture.op<unknown[]>("prompts", {
							workerId: manifest?.worker_id,
						})
					).length,
					0,
				);
			},
			4,
			{
				now: () => {
					if (!clock.armed) return Date.now();
					clock.armed = false;
					throw new Error("clock failed");
				},
			},
		);
	});

	it("after the initial sessions.prompt: the prompted worker stays owned, its prompt never re-sent", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, slots } = composed;
			const fault = failStoreAfter(
				composed,
				fixture.started.parentWorkerId,
				"sessions.prompt",
			);
			let launch;
			try {
				launch = await provider.launch(freshRequest(session));
			} finally {
				fault.restore();
			}
			assert.match(
				launch.launchFailure ?? "",
				/initial prompt.*could not be recorded.*never re-sent/,
			);
			const workerId = workerOf(provider, launch);
			assert.equal(
				(await fixture.op<unknown[]>("prompts", { workerId })).length,
				1,
			);
			assert.equal(await fixture.op<number>("acquisitions"), 1);
			const manifest = provider.manifest(launch.handle);
			assert.equal(manifest?.state, "acquired");
			assert.deepEqual(
				manifest?.commands.map((c) => [c.purpose, c.outcome]),
				[
					["create", "observed"],
					["initial-prompt", "pending"],
				],
			);
			assert.equal(slots.holder(manifest.slot.name), manifest.launch_id);
		}));

	it("after a later sessions.prompt or executions.interrupt: an uncertain command, never a plain failure", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider } = composed;
			const launch = await provider.launch(freshRequest(session));
			const workerId = workerOf(provider, launch);
			const parent = fixture.started.parentWorkerId;
			const prompted = failStoreAfter(composed, parent, "sessions.prompt");
			try {
				await assert.rejects(
					provider.prompt(launch.handle, { id: "later", text: "more" }),
					(error: Error) =>
						error instanceof WorkerCommandUncertain &&
						/input later was accepted.*could not be recorded.*never re-sent/.test(
							error.message,
						),
				);
			} finally {
				prompted.restore();
			}
			assert.equal(
				(await fixture.op<unknown[]>("prompts", { workerId })).length,
				2,
			);
			const interrupted = failStoreAfter(
				composed,
				parent,
				"executions.interrupt",
			);
			try {
				await assert.rejects(
					provider.interrupt(launch.handle),
					(error: Error) =>
						error instanceof WorkerCommandUncertain &&
						/interrupt was observed.*could not be recorded/.test(error.message),
				);
			} finally {
				interrupted.restore();
			}
			assert.deepEqual(
				provider
					.manifest(launch.handle)
					?.commands.map((c) => [c.purpose, c.outcome]),
				[
					["create", "observed"],
					["initial-prompt", "observed"],
					["prompt", "pending"],
					["interrupt", "pending"],
				],
			);
		}));

	it("after workers.stop: an unconfirmed stop report, never a rejection; the next stop confirms without a new command", async () => {
		// The case needs a stop B2 observed. One it did not observe (its
		// `outcome_unknown` receipt under load, see stopConfirmed) proves nothing here,
		// and its stop fenced the parent (invariant 4a): the case runs again
		// over a fresh supervisor, at most three times.
		for (let attempt = 1; ; attempt++) {
			let observed = true;
			await withFixture(async ({ fixture, composed, session }) => {
				const { provider } = composed;
				const launch = await provider.launch(freshRequest(session));
				const fault = failStoreAfter(
					composed,
					fixture.started.parentWorkerId,
					"workers.stop",
				);
				let report;
				try {
					report = await provider.stop(launch.handle);
				} finally {
					fault.restore();
				}
				// Only B2's own `outcome_unknown` receipt for this stop reruns the case.
				if (
					report.request === "unknown" &&
					fault.state.reply?.state === "outcome_unknown" &&
					attempt < 3
				) {
					observed = false;
					return;
				}
				assert.equal(report.request, "sent");
				assert.equal(report.termination, "unconfirmed");
				assert.ok(
					report.termination === "unconfirmed" &&
						report.error instanceof WorkerCommandUncertain &&
						/could not be recorded/.test(report.error.message),
				);
				assert.deepEqual(await provider.stop(launch.handle), {
					request: "not-sent",
					termination: "confirmed",
				});
				const stops = provider
					.manifest(launch.handle)
					?.commands.filter((c) => c.purpose === "stop");
				assert.deepEqual(
					stops?.map((c) => c.outcome),
					["pending"],
				);
			});
			if (observed) return;
		}
	});

	it("a create whose outcome stays unknown is AcquisitionUncertainError even when its record cannot be written", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, client, launches } = composed;
			const call = client.call.bind(client);
			// SAFETY: a pass-through wrapper with the client's own signature.
			client.call = (async (op: string, options: never) => {
				if (op === "workers.create") {
					// SAFETY: forwards the caller's own operation and options unchanged.
					await call(op as never, options);
					chmodSync(launches.dir, 0o500);
					throw new Error("socket closed before the reply");
				}
				if (op === "receipts.get") throw new Error("socket unavailable");
				// SAFETY: forwards the caller's own operation and options unchanged.
				return call(op as never, options);
			}) as typeof client.call;
			try {
				await assert.rejects(provider.launch(freshRequest(session)), (error) =>
					isAcquisitionUncertainError(error),
				);
			} finally {
				chmodSync(launches.dir, 0o700);
			}
			assert.equal(await fixture.op<number>("acquisitions"), 1);
			const [manifest] = launches.list();
			assert.equal(manifest?.state, "creating");
			assert.equal(
				composed.slots.holder(manifest.slot.name),
				manifest.launch_id,
			);
		}));
});

/**
 * The `nth` launch-store write from now fails, once; every other write lands.
 * A launch writes, in order: 1 `creating`, 2 the create's command, 3 its
 * outcome, 4 `acquired` (or `uncertain`), 5 the initial prompt's command, 6
 * its outcome, 7 the launch's uncertainty.
 */
function failNthWrite(launches: WorkerLaunchStore, nth: number): void {
	const update = launches.update.bind(launches);
	let count = 0;
	launches.update = (launchId, change) => {
		if (++count === nth) throw new Error("EIO: injected write failure");
		return update(launchId, change);
	};
}

describe("worker provider over real B2: one failed store write at each step", () => {
	it("the create's command: nothing is sent or acquired, and the slot is released", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches, slots } = composed;
			failNthWrite(launches, 2);
			await assert.rejects(
				provider.launch(freshRequest(session)),
				/EIO: injected/,
			);
			assert.equal(await fixture.op<number>("acquisitions"), 0);
			assert.equal(launches.list().length, 0);
			assert.equal(slots.holder("s0"), undefined);
		}));

	for (const [nth, step, state, commands] of [
		[3, "the create's outcome", "creating", [["create", "pending"]]],
		[4, "the acquired state", "creating", [["create", "observed"]]],
		[5, "the initial prompt's command", "acquired", [["create", "observed"]]],
	] as const)
		it(`${step}: the worker is owned with a failure, and nothing more is sent`, () =>
			withFixture(async ({ fixture, composed, session }) => {
				const { provider, launches } = composed;
				failNthWrite(launches, nth);
				const launch = await provider.launch(freshRequest(session));
				assert.match(
					launch.launchFailure ?? "",
					/acquired, but its outcome could not be recorded \(EIO: injected write failure\); not prompted, retained and owned/,
				);
				const manifest = provider.manifest(launch.handle);
				assert.equal(manifest?.state, state);
				assert.deepEqual(
					manifest?.commands.map((c) => [c.purpose, c.outcome]),
					commands,
				);
				assert.equal(await fixture.op<number>("acquisitions"), 1);
				const { stops } = await stopConfirmed(provider, launch.handle);
				const stopped = provider.manifest(launch.handle);
				assert.deepEqual(
					stopped?.commands.map((c) => c.purpose),
					["create", ...stops.map(() => "stop")],
					"no initial prompt was sent",
				);
			}));

	it("a refused create's outcome: refused, its manifest and slot kept as they were", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches, slots } = composed;
			const refused = freshRequest(session);
			refused.behavior = { ...refused.behavior, tools: "read,python" };
			failNthWrite(launches, 3);
			await assert.rejects(
				provider.launch(refused),
				(error: Error) =>
					error instanceof WorkerLaunchRefusal &&
					/nothing acquired, but its outcome could not be recorded/.test(
						error.message,
					),
			);
			assert.equal(await fixture.op<number>("acquisitions"), 0);
			const [manifest] = launches.list();
			assert.equal(manifest?.state, "creating");
			assert.equal(slots.holder("s0"), manifest.launch_id);
		}));

	it("an unknown create naming no worker: AcquisitionUncertainError, its failure kept", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, client, launches, slots } = composed;
			const call = client.call.bind(client);
			// SAFETY: a pass-through wrapper with the client's own signature.
			client.call = (async (op: string, options: never) => {
				if (op === "receipts.get") throw new Error("socket unavailable");
				// SAFETY: forwards the caller's own operation and options unchanged.
				const reply = await call(op as never, options);
				if (op === "workers.create")
					throw new Error("socket closed before the reply");
				return reply;
			}) as typeof client.call;
			failNthWrite(launches, 4);
			await assert.rejects(
				provider.launch(freshRequest(session)),
				(error: Error) =>
					isAcquisitionUncertainError(error) &&
					/never retried\. Its outcome could not be recorded \(EIO/.test(
						error.message,
					),
			);
			assert.equal(await fixture.op<number>("acquisitions"), 1);
			const [manifest] = launches.list();
			assert.equal(manifest?.state, "creating");
			assert.equal(slots.holder(manifest.slot.name), manifest.launch_id);
		}));

	it("an unknown create naming its worker: owned and uncertain, its failure kept", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, client, launches } = composed;
			const call = client.call.bind(client);
			// SAFETY: a pass-through wrapper with the client's own signature.
			client.call = (async (op: string, options: never) => {
				// SAFETY: forwards the caller's own operation and options unchanged.
				const reply = await call(op as never, options);
				if (op !== "workers.create") return reply;
				// The create's receipt as if it were not settled yet: the worker is named, its outcome unknown.
				// SAFETY: a mutation's reply is its receipt.
				const receipt = reply as Receipt;
				return { ...receipt, state: "accepted" };
			}) as typeof client.call;
			failNthWrite(launches, 4);
			const launch = await provider.launch(freshRequest(session));
			assert.match(
				launch.launchFailure ?? "",
				/create outcome unknown.*never retried\. Its outcome could not be recorded \(EIO/,
			);
			assert.equal(provider.manifest(launch.handle)?.state, "creating");
			assert.equal(await fixture.op<number>("acquisitions"), 1);
		}));

	it("an unknown initial prompt's uncertainty: owned, never re-sent, its failure kept", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches } = composed;
			await fixture.op("uncertainNextLaunch");
			failNthWrite(launches, 7);
			const launch = await provider.launch(freshRequest(session));
			assert.match(
				launch.launchFailure ?? "",
				/initial prompt outcome unknown.*never re-sent\. Its outcome could not be recorded \(EIO/,
			);
			const workerId = workerOf(provider, launch);
			assert.equal(
				(await fixture.op<unknown[]>("prompts", { workerId })).length,
				1,
			);
		}));

	it("a stop's command: not sent, reported unconfirmed, the worker still running", () =>
		withFixture(async ({ fixture, composed, session }) => {
			const { provider, launches } = composed;
			const launch = await provider.launch(freshRequest(session));
			failNthWrite(launches, 1);
			const report = await provider.stop(launch.handle);
			assert.equal(report.request, "not-sent");
			assert.equal(report.termination, "unconfirmed");
			assert.ok(
				report.termination === "unconfirmed" &&
					report.error instanceof Error &&
					/EIO: injected/.test(report.error.message),
			);
			assert.equal(
				(await fixture.row(workerOf(provider, launch))).status,
				"ready",
			);
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

	// FLIP when pi-worker adds executions.interrupt to its parent channel (root
	// decision 2026-11-18, P3-7 open items (1); a separate pi-worker PR): the
	// expected gap becomes ["children.report"] and the provider's interrupt path,
	// kept as is, then works through a sandboxed parent's channel.
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
