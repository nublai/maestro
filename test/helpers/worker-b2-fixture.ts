/**
 * Drives `test/fixtures/worker-b2/supervisor.mjs`: pi-worker's real
 * supervisor and B2 server from a pinned, built checkout
 * (`MAESTRO_PI_WORKER_CHECKOUT`), in its own process, controlled over stdin.
 * Composes the worker provider over it with the exact client tarball Maestro
 * pins. Every directory lives under the test's TMPDIR.
 */
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@nublai/pi-worker-client";
import type {
	FreshPiLaunchRequest,
	PiLaunchRequest,
} from "../../maestro/adapters/pi/launch.ts";
import {
	PiHarnessAdapter,
	type PiExecution,
	type PiSpawnOptions,
} from "../../maestro/adapters/pi/pi-harness-adapter.ts";
import { MAESTRO_WORKER_PARENT_METHODS } from "../../maestro/adapters/worker/grant-profile.ts";
import { WorkerLaunchStore } from "../../maestro/adapters/worker/launch-store.ts";
import {
	type WorkerSlot,
	WorkerSlotPool,
} from "../../maestro/adapters/worker/slots.ts";
import {
	WorkerExecutionProvider,
	type WorkerExecutionProviderOptions,
} from "../../maestro/adapters/worker/worker-exec-provider.ts";
import type {
	ExecLaunch,
	ExecRequirement,
} from "../../maestro/core/exec-provider.ts";
import type { RoutingModel } from "../../maestro/core/routing.ts";
import type {
	AgentHandle,
	Role,
	ThinkingLevel,
} from "../../maestro/core/types.ts";

export interface B2Started {
	socketPath: string;
	grantFile: string;
	root: string;
	repo: string;
	baseSha: string;
	parentWorkerId: string;
	slots: WorkerSlot[];
	channelMethods: string[];
}

/** The worker row as the owner sees it, for assertions only. */
export interface OwnerRow {
	worker_id: string;
	status: string;
	fence: { command_id: string } | null;
	child_reports?: { command_id: string; kind: string; message: string }[];
}

/** A fixture op's arguments: JSON values only. */
export type FixtureArgs = Record<
	string,
	string | number | boolean | readonly string[] | undefined
>;

interface Reply {
	id?: number;
	ok?: boolean;
	result?: never;
	error?: string;
	ready?: boolean;
}

const SUPERVISOR = new URL(
	"../fixtures/worker-b2/supervisor.mjs",
	import.meta.url,
).pathname;

/**
 * The pinned pi-worker checkout, or a failure naming the variable. The lane's
 * runner (`npm run test:worker-b2`) verifies it first and passes the commit it
 * verified; a direct run without that verification is refused.
 */
export function piWorkerCheckout(): string {
	const checkout = process.env.MAESTRO_PI_WORKER_CHECKOUT;
	assert.ok(
		checkout,
		"MAESTRO_PI_WORKER_CHECKOUT must name a built pi-worker checkout (see vendor/pi-worker-client/SOURCE.json)",
	);
	// SAFETY: a small JSON file this repository writes.
	const source = JSON.parse(
		readFileSync(
			new URL("../../vendor/pi-worker-client/SOURCE.json", import.meta.url),
			"utf8",
		),
	) as { source_commit: string };
	assert.equal(
		process.env.MAESTRO_PI_WORKER_VERIFIED,
		source.source_commit,
		"Run through npm run test:worker-b2, which verifies the checkout is the pinned commit and its build",
	);
	return checkout;
}

export class B2Fixture {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #waiters = new Map<number, (reply: Reply) => void>();
	#next = 0;
	started!: B2Started;

	private constructor(child: ChildProcessWithoutNullStreams) {
		this.#process = child;
	}

	/** Starts the supervisor process and its topology. */
	static async start(slots = 4): Promise<B2Fixture> {
		const child = spawn(process.execPath, [SUPERVISOR], {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: process.env.HOME ?? tmpdir(),
				TMPDIR: tmpdir(),
				LANG: "C",
				MAESTRO_PI_WORKER_CHECKOUT: piWorkerCheckout(),
			},
		});
		const fixture = new B2Fixture(child);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4096);
		});
		const ready = new Promise<void>((resolve, reject) => {
			let buffer = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				for (;;) {
					const nl = buffer.indexOf("\n");
					if (nl < 0) break;
					// SAFETY: the fixture writes one JSON reply per line.
					const reply = JSON.parse(buffer.slice(0, nl)) as Reply;
					buffer = buffer.slice(nl + 1);
					if (reply.ready) resolve();
					else if (reply.id !== undefined)
						fixture.#waiters.get(reply.id)?.(reply);
				}
			});
			child.once("exit", (code) =>
				reject(new Error(`B2 fixture exited (${code}): ${stderr}`)),
			);
		});
		await ready;
		fixture.started = await fixture.op<B2Started>("start", {
			profile: MAESTRO_WORKER_PARENT_METHODS,
			slots,
		});
		return fixture;
	}

	/** One control request to the fixture process. */
	op<T>(op: string, args: FixtureArgs = {}): Promise<T> {
		const id = ++this.#next;
		return new Promise<T>((resolve, reject) => {
			this.#waiters.set(id, (reply) => {
				this.#waiters.delete(id);
				if (!reply.ok) {
					reject(new Error(reply.error ?? "fixture failure"));
					return;
				}
				// SAFETY: each fixture op replies with the shape its caller names (supervisor.mjs `ops`).
				const result = reply.result as T;
				resolve(result);
			});
			this.#process.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
		});
	}

	row(workerId: string): Promise<OwnerRow> {
		return this.op<OwnerRow>("row", { workerId });
	}

	async close(): Promise<void> {
		if (this.#process.exitCode !== null) return;
		const exited = new Promise((resolve) =>
			this.#process.once("exit", resolve),
		);
		try {
			await this.op("shutdown");
		} catch {
			this.#process.kill("SIGKILL");
		}
		await exited;
	}
}

/** The provider composed over a fixture, its stores in a private directory. */
export function composeProvider(
	fixture: B2Fixture,
	overrides: Partial<WorkerExecutionProviderOptions> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "maestro-worker-"));
	const state = join(dir, ".piw-maestro");
	const client = new Client({
		socketPath: fixture.started.socketPath,
		grantFile: fixture.started.grantFile,
		timeoutMs: 10_000,
	});
	const launches = new WorkerLaunchStore(join(state, "launches"));
	const slots = new WorkerSlotPool({
		root: fixture.started.root,
		slots: fixture.started.slots,
		claimsDir: join(state, "slots"),
	});
	const provider = new WorkerExecutionProvider({
		client,
		parentWorkerId: fixture.started.parentWorkerId,
		slots,
		launches,
		runsDir: join(state, "runs"),
		reportDrainMs: 300,
		observer: { backoff: { initialMs: 20, maxMs: 200 } },
		...overrides,
	});
	return {
		provider,
		client,
		launches,
		slots,
		dir,
		async dispose() {
			await provider.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export const role: Role = {
	name: "worker",
	version: "1",
	description: "test",
	systemPrompt: "Focused identity",
	allowedTools: ["read", "bash"],
	defaults: { autoExit: true, spawning: false },
};

export const modelRegistry = {
	find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
	available: () => [],
	hasConfiguredAuth: () => true,
	supportedThinkingLevels: (): ThinkingLevel[] => ["off", "high"],
	clampThinkingLevel: (_model: RoutingModel, level: ThinkingLevel) => level,
};

/** A parent Pi session directory for the shared adapter: no terminal, no pane. */
export function parentSession() {
	const root = mkdtempSync(join(tmpdir(), "maestro-worker-parent-"));
	const sessionDir = join(root, "parent");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "parent.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}\n`,
	);
	return {
		root,
		parent: { cwd: root, sessionFile, sessionId: "parent", sessionDir },
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

export function freshRequest(
	session: ReturnType<typeof parentSession>,
	overrides: Partial<FreshPiLaunchRequest> = {},
): FreshPiLaunchRequest {
	return {
		kind: "fresh",
		name: "conformance",
		task: "bounded task",
		cwd: session.root,
		worktree: { branch: "w" },
		parent: session.parent,
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
		...overrides,
	};
}

export function spawnOptions(
	root: string,
	extra: Partial<PiSpawnOptions> = {},
): PiSpawnOptions {
	return {
		name: "worker",
		task: "bounded task",
		cwd: root,
		sessionId: "logical",
		role,
		runtime: { model: "fake/test", thinking: "off" },
		worktreeRequest: { branch: "w" },
		...extra,
	};
}

/** A run that needs `requirement`, through the adapter's public spawn or resume. */
export function spawnRequiring(
	adapter: PiHarnessAdapter<PiExecution>,
	root: string,
	requirement: ExecRequirement,
): Promise<AgentHandle> {
	const plain = spawnOptions(root);
	delete plain.worktreeRequest;
	switch (requirement) {
		case "resume":
			return adapter.resume({
				name: "resumed",
				sessionId: join(root, "saved.jsonl"),
			});
		case "worktree":
			return adapter.spawn(spawnOptions(root));
		case "persistent":
			return adapter.spawn(
				spawnOptions(root, { behavior: { persistent: true, autoExit: false } }),
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
			return adapter.spawn(plain);
	}
}

/** The worker behind a launch, from its acquisition manifest. */
export function workerOf(
	provider: WorkerExecutionProvider,
	launch: ExecLaunch<PiExecution>,
): string {
	const workerId = provider.manifest(launch.handle)?.worker_id;
	assert.ok(workerId, "the launch acquired a worker");
	return workerId;
}

/** The shared Pi adapter over the worker provider, mapping run handles to launches. */
export function adapterOver(
	provider: WorkerExecutionProvider,
	session: ReturnType<typeof parentSession>,
) {
	const launches = new Map<PiExecution, ExecLaunch<PiExecution>>();
	const launch = provider.launch.bind(provider);
	provider.launch = async (request: PiLaunchRequest, control) => {
		const result = await launch(request, control);
		launches.set(result.launched, result);
		return result;
	};
	const adapter = new PiHarnessAdapter<PiExecution>({
		exec: provider,
		modelRegistry,
		parent: session.parent,
		parentRuntime: { provider: "fake", modelId: "test", thinking: "off" },
	});
	const launchOf = (handle: AgentHandle) => {
		const result = launches.get(adapter.getRunningChild(handle));
		assert.ok(result, `no launch recorded for ${handle.id}`);
		return result;
	};
	return { adapter, launchOf };
}
