import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	normalizeAcceptSpec,
	type AcceptCommandResult,
	type AcceptRequest,
} from "../../maestro/core/accept.ts";
import {
	acceptCheckEnv,
	readAcceptSpecFile,
	runAcceptCommand,
	type AcceptRunner,
} from "../../maestro/adapters/pi/accept-runner.ts";
import { createChildAcceptLoop } from "../../maestro/adapters/pi/child/accept-check.ts";
import { buildCompletionSidecar } from "../../maestro/adapters/pi/child/protocol.ts";
import { interpretExitSidecar } from "../../maestro/adapters/pi/completion.ts";
import { launchPiSubagent } from "../../maestro/adapters/pi/launch.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { isString } from "../../maestro/core/config/type-guards.ts";

describe("accept check runner", () => {
	const dir = mkdtempSync(join(tmpdir(), "accept-runner-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("reports the exit code and the combined output tail", async () => {
		const result = await runAcceptCommand({
			run: "echo out; echo err >&2; exit 3",
			cwd: dir,
			timeoutMs: 10_000,
		});
		assert.equal(result.kind, "exit");
		assert.equal(result.kind === "exit" && result.exitCode, 3);
		assert.match(result.output, /out/);
		assert.match(result.output, /err/);
	});

	it("strips PI_SUBAGENT_* from the check's environment", async () => {
		const env = acceptCheckEnv({
			PATH: process.env.PATH,
			PI_SUBAGENT_ID: "x",
			PI_SUBAGENT_SESSION: "y",
			OTHER: "kept",
		});
		assert.deepEqual(Object.keys(env).sort(), ["OTHER", "PATH"]);
		const result = await runAcceptCommand({
			run: "env",
			cwd: dir,
			timeoutMs: 10_000,
			env,
		});
		assert.doesNotMatch(result.output, /PI_SUBAGENT_/);
		assert.match(result.output, /OTHER=kept/);
	});

	it("times out, terminating the process group, then kills after the grace", async () => {
		const started = Date.now();
		const timeout = await runAcceptCommand({
			run: "sleep 30",
			cwd: dir,
			timeoutMs: 100,
		});
		assert.equal(timeout.kind, "timeout");
		const stubborn = await runAcceptCommand({
			run: "trap '' TERM; sleep 30 & wait",
			cwd: dir,
			timeoutMs: 100,
			killGraceMs: 200,
		});
		assert.equal(stubborn.kind, "timeout");
		assert.ok(Date.now() - started < 10_000);
	});

	it("reports a missing cwd and an abort", async () => {
		assert.equal(
			(
				await runAcceptCommand({
					run: "true",
					cwd: join(dir, "missing"),
					timeoutMs: 1_000,
				})
			).kind,
			"cwd-missing",
		);
		const controller = new AbortController();
		const pending = runAcceptCommand({
			run: "sleep 30",
			cwd: dir,
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		assert.equal((await pending).kind, "aborted");
	});

	it("honors an abort while inherited pipes keep it running after the shell exits", async () => {
		const controller = new AbortController();
		const pending = runAcceptCommand({
			run: "sleep 10 & exit 0",
			cwd: dir,
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		// The shell exits at once; the 1 s pipe grace has not run out.
		setTimeout(() => controller.abort(), 200);
		const started = Date.now();
		assert.equal((await pending).kind, "aborted");
		assert.ok(Date.now() - started < 800, "the abort did not wait for pipes");
	});

	it("reads the child's spec file, ignoring a bad one", () => {
		const file = join(dir, "spec.json");
		writeFileSync(file, JSON.stringify({ version: 1, run: "true" }));
		assert.deepEqual(readAcceptSpecFile(file), {
			run: "true",
			maxRetries: 1,
			timeoutSec: 600,
			paths: [],
		});
		writeFileSync(file, "{");
		assert.equal(readAcceptSpecFile(file), undefined);
		assert.equal(readAcceptSpecFile(undefined), undefined);
	});
});

async function withLaunch(
	accept: AcceptRequest,
	check: (script: string, cwd: string | undefined) => void,
) {
	const root = mkdtempSync(join(tmpdir(), "accept-launch-"));
	try {
		const project = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(project);
		mkdirSync(sessionDir);
		const parentSessionFile = join(sessionDir, "parent.jsonl");
		writeFileSync(
			parentSessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
		);
		const operations = launchOperationsFromSurface(new FakeSurfaceProvider(), {
			mode: "tab",
			direction: "right",
			maxPerTab: 4,
		});
		let script = "";
		operations.waitForShellReady = async () => {};
		operations.runScript = (_surface, command, options) => {
			script = command;
			return options.scriptPath;
		};
		const child = await launchPiSubagent(
			{
				kind: "fresh",
				name: "checked",
				task: "work",
				accept: normalizeAcceptSpec(accept),
				parent: {
					cwd: project,
					sessionFile: parentSessionFile,
					sessionId: "parent",
					sessionDir,
					agentDir: join(root, "agent"),
				},
				runtimePlan: {
					provider: "fake",
					modelId: "worker",
					model: "fake/worker",
					thinking: "high",
					modelSource: "request",
					thinkingSource: "request",
				},
				behavior: {
					deniedTools: [],
					autoExit: true,
					interactive: false,
					sessionMode: "standalone",
				},
			},
			operations,
		);
		assert.equal(child.cwd, project);
		assert.equal(child.accept?.run, accept.run);
		check(script, child.cwd);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function scripted(results: AcceptCommandResult[]): AcceptRunner {
	return async () => {
		const next = results.shift();
		assert.ok(next, "unexpected extra check run");
		return next;
	};
}

describe("child accept loop", () => {
	const spec = normalizeAcceptSpec({ run: "npm test", maxRetries: 1 });
	const settle = { outcome: "completed" as const, entries: [] };

	it("retries with the bounded failing output, then records a pass", async () => {
		const loop = createChildAcceptLoop({
			spec,
			cwd: "/work",
			runner: scripted([
				{ kind: "exit", exitCode: 1, output: `${"x".repeat(9000)}FAIL tail` },
				{ kind: "exit", exitCode: 0, output: "ok" },
			]),
		});
		const first = await loop.beforeSettle(settle);
		assert.equal(first?.continue, true);
		const entry = first?.entries?.[0];
		assert.equal(entry?.type, "custom_message");
		const content = entry?.type === "custom_message" ? entry.content : "";
		assert.ok(isString(content), "the retry message is plain text");
		assert.match(content, /exited with code 1 \(try 1 of 2\)/);
		assert.match(content, /FAIL tail/);
		assert.ok(content.length < 4_600, "only the last 4,000 characters");
		assert.deepEqual(loop.report(), {
			tries: 1,
			childVerdict: "failed",
			lastExitCode: 1,
			timedOut: false,
		});
		assert.equal(await loop.beforeSettle(settle), undefined);
		assert.deepEqual(loop.report(), {
			tries: 2,
			childVerdict: "passed",
			lastExitCode: 0,
			timedOut: false,
		});
	});

	it("records a failure when retries are exhausted and keeps other entries", async () => {
		const loop = createChildAcceptLoop({
			spec: normalizeAcceptSpec({ run: "x", maxRetries: 1 }),
			cwd: "/work",
			runner: scripted([
				{ kind: "timeout", output: "" },
				{ kind: "exit", exitCode: 2, output: "still failing" },
			]),
		});
		const other = { type: "custom" as const, customType: "other" };
		const first = await loop.beforeSettle({
			outcome: "completed",
			entries: [other],
		});
		assert.deepEqual(first?.entries?.[0], other);
		assert.match(JSON.stringify(first?.entries?.[1]), /timed out after 600s/);
		assert.equal(await loop.beforeSettle(settle), undefined);
		assert.deepEqual(loop.report(), {
			tries: 2,
			childVerdict: "failed",
			lastExitCode: 2,
			timedOut: false,
		});
	});

	it("runs nothing after an aborted or errored turn", async () => {
		const loop = createChildAcceptLoop({
			spec,
			cwd: "/work",
			runner: scripted([]),
		});
		assert.equal(
			await loop.beforeSettle({ outcome: "aborted", entries: [] }),
			undefined,
		);
		assert.equal(
			await loop.beforeSettle({ outcome: "error", entries: [] }),
			undefined,
		);
		assert.equal(loop.report(), undefined);
	});

	it("writes the report into the done sidecar, which the parent parses", () => {
		const report = {
			tries: 2,
			childVerdict: "failed" as const,
			lastExitCode: 1,
			timedOut: false,
		};
		const sidecar = buildCompletionSidecar([], report);
		assert.deepEqual(sidecar, { type: "done", accept: report });
		assert.deepEqual(buildCompletionSidecar([]), { type: "done" });
		assert.deepEqual(interpretExitSidecar(sidecar), {
			reason: "done",
			exitCode: 0,
			accept: report,
		});
		// A malformed report is unknown, never a verdict.
		assert.deepEqual(
			interpretExitSidecar({ type: "done", accept: { tries: "2" } }),
			{ reason: "done", exitCode: 0 },
		);
	});

	it("launch passes the spec as a file, never the command in the script", () =>
		withLaunch({ run: "secret-check --flag", maxRetries: 2 }, (script) => {
			assert.doesNotMatch(script, /secret-check/);
			const file = script.match(/PI_SUBAGENT_ACCEPT_FILE='([^']+)'/)?.[1];
			assert.ok(file, script);
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
				version: 1,
				run: "secret-check --flag",
				maxRetries: 2,
				timeoutSec: 600,
				paths: [],
			});
		}));
});
