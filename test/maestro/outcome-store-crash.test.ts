import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
/** Durability-relevant operations: every append, lock and compaction step. */
const CUT_OPS = new Set([
	"write",
	"fsync",
	"rename",
	"link",
	"unlink",
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
	return new Promise((resolve, reject) => {
		const proc = spawn(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", CHILD, ...args],
			{
				// Synthetic environment: nothing from the parent's shell.
				env: { PATH: process.env.PATH, HOME: process.env.HOME },
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
	it("recovers the acknowledged prefix after a kill before or after each append, lock and compaction step", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "maestro-outcome-crash-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const views: ScenarioView[] = await runScenario(
			await openScenarioStore("/state", new DurableFs(), "a", {
				isProcessAlive: () => false,
			}),
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
		assert.ok(cuts.length >= 60, `${cuts.length} cuts`);
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
});
