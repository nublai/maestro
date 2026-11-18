import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isOutcomeStoreError } from "../../maestro/core/outcome-store.ts";
import { DurableFs } from "../helpers/durable-fs.ts";
import {
	SCENARIO,
	draft,
	openScenarioStore,
	runScenario,
	view,
	type ScenarioView,
} from "../helpers/outcome-store-scenario.ts";

const CHILD = fileURLToPath(
	new URL("../helpers/outcome-store-child.ts", import.meta.url),
);
/**
 * Every append, directory and compaction step. These cuts kill the process,
 * not the machine: the page cache survives a SIGKILL, so they prove a killed
 * writer leaves a readable store and a lock the next opener takes over, never
 * that an fsync happened (with fsync removed they still pass). The fsync proof
 * is the simulated power-loss cuts in outcome-store.test.ts.
 */
const CUT_OPS = new Set([
	"mkdir",
	"open",
	"write",
	"fsync",
	"rename",
	"ftruncate",
]);

interface ChildRun {
	stdout: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}

function child(
	args: string[],
	onLine?: (
		line: string,
		stdin: NodeJS.WritableStream,
		proc: ChildProcess,
	) => void,
): Promise<ChildRun> {
	return spawnChild([process.execPath], args, onLine);
}

/** The child under `prefix` (for example in another PID namespace). */
function spawnChild(
	prefix: string[],
	args: string[],
	onLine?: (
		line: string,
		stdin: NodeJS.WritableStream,
		proc: ChildProcess,
	) => void,
): Promise<ChildRun> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			prefix[0]!,
			[
				...prefix.slice(1),
				...(prefix.length > 1 ? [process.execPath] : []),
				"--experimental-strip-types",
				"--no-warnings",
				CHILD,
				...args,
			],
			{
				// Synthetic environment: nothing from the parent's shell.
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					TMPDIR: tmpdir(),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let pending = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop()!;
			for (const line of lines) onLine?.(line, proc.stdin, proc);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		proc.on("error", reject);
		proc.on("close", (code, signal) => {
			if (code && !signal)
				reject(new Error(`child failed (${code}): ${stderr.slice(-2_000)}`));
			else resolve({ stdout, code, signal });
		});
	});
}

function acked(stdout: string): number {
	let last = -1;
	for (const line of stdout.split("\n"))
		if (line.startsWith("ack ")) last = Number(line.slice(4));
	return last;
}

async function pool<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>,
) {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: limit }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift())
				await work(item);
		}),
	);
}

describe("FileOutcomeStore under SIGKILL", () => {
	it("recovers the acknowledged prefix after a kill before or after each append, directory and compaction step", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-crash-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const views: ScenarioView[] = await runScenario(
			await openScenarioStore("/state", new DurableFs(), "a"),
		);
		const trace = await child([join(root, "trace"), "trace"]);
		assert.equal(acked(trace.stdout), SCENARIO.length);
		const ops = trace.stdout
			.split("\n")
			.filter((line) => line.startsWith("op "))
			.map((line) => {
				const [, index, name] = line.split(" ");
				return { index: Number(index), name: name! };
			});
		const cuts = ops
			.filter((op) => CUT_OPS.has(op.name))
			.flatMap((op) => [
				{ ...op, phase: "before" },
				{ ...op, phase: "after" },
			]);
		assert.ok(cuts.length >= 50, `${cuts.length} cuts`);
		assert.ok(
			ops.some((op) => op.name === "rename"),
			"compaction is cut too",
		);
		let interrupted = 0;
		await pool(cuts, 8, async (cut) => {
			const dir = join(root, `${cut.index}-${cut.phase}`);
			const run = await child([dir, "cut", String(cut.index), cut.phase]);
			const label = `${cut.phase} ${cut.name} #${cut.index}`;
			assert.equal(run.signal, "SIGKILL", label);
			const done = acked(run.stdout);
			if (done < SCENARIO.length) interrupted++;
			// The killed writer's lock is stale: this process recovers it.
			const store = await openScenarioStore(dir, undefined, "r").catch(
				(error: Error) =>
					assert.fail(`${label}: reopen failed: ${error.message}`),
			);
			const actual = JSON.stringify(view(store));
			const allowed = [done, done + 1].map((index) =>
				JSON.stringify(views[Math.min(Math.max(index, 0), views.length - 1)]),
			);
			assert.ok(
				allowed.includes(actual),
				`${label} (acked ${done}): ${actual}`,
			);
			await store.commit(draft("after", "result", "post-crash"));
			await store.close();
		});
		assert.ok(interrupted > cuts.length / 2, `${interrupted} interrupted`);
	});

	it("one writer per store across processes; a released or killed holder's lock is taken over", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-lock-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		for (const ending of ["release", "kill"] as const) {
			const dir = join(root, ending);
			let refused: Error | undefined;
			const holder = child([dir, "hold"], (line, stdin, proc) => {
				if (line !== "ready") return;
				void openScenarioStore(dir, undefined, "b").then(
					() => assert.fail("a second writer must be refused"),
					(error: Error) => {
						refused = error;
						if (ending === "release") stdin.end();
						else proc.kill("SIGKILL");
					},
				);
			});
			const run = await holder;
			assert.ok(refused && isOutcomeStoreError(refused, "locked"), ending);
			assert.match(refused.message, /one writer per store/);
			if (ending === "release") assert.match(run.stdout, /released/);
			else assert.equal(run.signal, "SIGKILL");
			const next = await openScenarioStore(dir, undefined, "c");
			await next.close();
		}
	});

	/** Runs `work` while a child (under `prefix`) holds `dir`, then releases it. */
	async function whileHeld(
		dir: string,
		work: () => Promise<void>,
		prefix: string[] = [process.execPath],
	): Promise<void> {
		let failure: Error | undefined;
		await spawnChild(prefix, [dir, "hold"], (line, stdin) => {
			if (line !== "ready") return;
			void work()
				.catch((error: Error) => {
					failure = error;
				})
				.finally(() => stdin.end());
		});
		if (failure) throw failure;
	}

	it("a live holder whose PID this process cannot see (another PID namespace, simulated) is still refused", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-ns-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const kill = process.kill;
		// From here every process looks gone, as from another PID namespace.
		// SAFETY: the replacement takes kill's (pid, signal) and forwards every
		// real signal to the original; only the existence probe (0) changes.
		process.kill = ((pid: number, signal?: string | number) => {
			if (signal === 0 || signal === undefined)
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			return kill.call(process, pid, signal);
		}) as typeof process.kill;
		try {
			await whileHeld(root, async () => {
				await assert.rejects(
					openScenarioStore(root, undefined, "thief"),
					(error: Error) =>
						isOutcomeStoreError(error, "locked") &&
						/one writer per store/.test(error.message),
				);
			});
		} finally {
			process.kill = kill;
		}
		// The holder released on exit; the lock is free again.
		await (await openScenarioStore(root, undefined, "next")).close();
	});

	// A new PID namespace whose child is not its PID 1: a few hundred PIDs are
	// used up first, so the holder's PID names no process (or another one) here,
	// as a PID-file lock would misread it.
	const unshare = [
		"unshare",
		"--user",
		"--pid",
		"--fork",
		"sh",
		"-c",
		'i=0; while [ $i -lt 300 ]; do /bin/true; i=$((i+1)); done; "$0" "$@"',
	];
	const namespaces =
		process.platform === "linux" &&
		spawnSync("unshare", ["--user", "--pid", "--fork", "true"]).status === 0;

	it("one writer per store across real PID namespaces, in both directions", {
		skip: namespaces ? false : "unprivileged PID namespaces unavailable",
	}, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-ns-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		// The holder runs in a new PID namespace; this process contends.
		await whileHeld(
			join(root, "inner"),
			async () => {
				await assert.rejects(
					openScenarioStore(join(root, "inner"), undefined, "outer"),
					/one writer per store/,
				);
			},
			unshare,
		);
		// This process holds; a contender in a new PID namespace is refused.
		const held = await openScenarioStore(join(root, "outer"), undefined, "h");
		const run = await spawnChild(unshare, [join(root, "outer"), "try"]);
		assert.match(run.stdout, /^locked locked$/m);
		await held.close();
	});

	it("openers racing for a stale lock: exactly one wins", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-race-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		for (let round = 0; round < 3; round++) {
			const dir = join(root, String(round));
			// A holder killed outright leaves a stale lock socket behind.
			const killed = await child([dir, "hold"], (line, _stdin, proc) => {
				if (line === "ready") proc.kill("SIGKILL");
			});
			assert.equal(killed.signal, "SIGKILL");
			const contenders = 6;
			let ready = 0;
			const holders: NodeJS.WritableStream[] = [];
			const runs = await new Promise<ChildRun[]>((resolve, reject) => {
				const all = Array.from({ length: contenders }, () =>
					child([dir, "try"], (line, stdin) => {
						if (line === "ready") holders.push(stdin);
						if (line === "ready" || line.startsWith("locked ")) ready++;
						// Every contender has decided: let the winners go.
						if (ready === contenders) for (const out of holders) out.end();
					}),
				);
				Promise.all(all).then(resolve, reject);
			});
			const winners = runs.filter((run) => /^ready$/m.test(run.stdout));
			assert.equal(winners.length, 1, runs.map((run) => run.stdout).join("|"));
			for (const run of runs)
				if (!/^ready$/m.test(run.stdout))
					assert.match(run.stdout, /^locked locked$/m);
		}
	});
});
