import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as runtime from "../../maestro/runtime/index.ts";
import type {
	DefaultRunSessionOptions,
	PiCompletedMetadata,
	PiLaunchInput,
	PiRunRecord,
} from "../../maestro/runtime/pi-run-session-types.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import {
	EXIT_OUTPUT_LINE_CHARS,
	EXIT_OUTPUT_MAX_CHARS,
	EXIT_OUTPUT_MAX_LINES,
	extractExitOutput,
	redactSecrets,
} from "../../maestro/adapters/pi/exit-output.ts";
import {
	renderParentMessage,
	resolveResultPresentation,
} from "../../pi-extension/subagents/presentation.ts";

// Supplemental #149 tests (not migrated identities): a child that exits before
// its session starts reports its last terminal lines, not only an exit code.

const SCRIPT = "/tmp/a/subagent-scripts/Echo-1234.sh";
const LOAD_ERROR =
	'Error: Failed to load extension "/x/index.ts": Failed to load extension: Invalid subagent status config in /h/.pi/agent/herdr-agents/config.json: status must be an object';
const HINT = 'Hint: Start without extensions using "pi -ne".';

test("extracts the child's lines between its launch line and the exit marker", () => {
	const screen = [
		"old output from an earlier command",
		`$ bash '${SCRIPT}'`,
		"\u001b[31m" + LOAD_ERROR + "\u001b[0m",
		"\t" + HINT,
		"",
		"__SUBAGENT_DONE_1__",
		"$ ",
	].join("\r\n");
	assert.equal(extractExitOutput(screen, SCRIPT), `${LOAD_ERROR}\n ${HINT}`);
	// Without a launch line (a Core terminal), everything before the marker.
	assert.equal(
		extractExitOutput(`${LOAD_ERROR}\n${HINT}\n__SUBAGENT_DONE_1__\n`, SCRIPT),
		`${LOAD_ERROR}\n${HINT}`,
	);
	assert.equal(
		extractExitOutput(`$ bash '${SCRIPT}'\n__SUBAGENT_DONE_1__`, SCRIPT),
		undefined,
	);
	assert.equal(extractExitOutput("", SCRIPT), undefined);
});

test("bounds the relayed output by lines, line length and total size", () => {
	const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	const lines = extractExitOutput(many)!.split("\n");
	assert.equal(lines.length, EXIT_OUTPUT_MAX_LINES);
	assert.equal(lines.at(-1), "line 29");
	const long = extractExitOutput("x".repeat(5_000))!;
	assert.equal(long.length, EXIT_OUTPUT_LINE_CHARS);
	assert.ok(long.endsWith("…"));
	const wide = Array.from({ length: 12 }, (_, i) => `${i} ${"y".repeat(400)}`);
	const bounded = extractExitOutput(wide.join("\n"))!;
	assert.ok(bounded.length <= EXIT_OUTPUT_MAX_CHARS, String(bounded.length));
	// The newest lines survive the character bound.
	assert.ok(bounded.split("\n").at(-1)!.startsWith("11 "));
});

test("never echoes credential-shaped values", () => {
	const secrets = {
		openai: "sk-proj-AbCdEf0123456789AbCdEf0123456789",
		anthropic: "sk-ant-api03-AbCdEf0123456789AbCdEf0123456789",
		github: "ghp_AbCdEf0123456789AbCdEf0123456789AbCd",
		bearer: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
		env: "hunter2-very-secret",
		query: "Zm9vYmFyYmF6cXV4",
		userinfo: "p4ssw0rd",
		opaque: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
	};
	const screen = [
		`Error: 401 invalid api key ${secrets.openai}`,
		`provider rejected key ${secrets.anthropic}`,
		`git: token ${secrets.github}`,
		`Authorization: Bearer ${secrets.bearer}`,
		`OPENAI_API_KEY=${secrets.env} PASSWORD: "${secrets.env}"`,
		`GET https://api.example.com/v1?alt=json&key=${secrets.query}&x=1`,
		`proxy https://user:${secrets.userinfo}@proxy.example.com:8080`,
		`session ${secrets.opaque}`,
		"__SUBAGENT_DONE_1__",
	].join("\n");
	const output = extractExitOutput(screen)!;
	for (const [name, secret] of Object.entries(secrets))
		assert.ok(!output.includes(secret), `${name} leaked: ${output}`);
	assert.match(output, /\[redacted\]/);
	// Ordinary diagnostics are kept as they are.
	assert.equal(redactSecrets(LOAD_ERROR), LOAD_ERROR);
	assert.equal(redactSecrets(HINT), HINT);
});

async function withRunSession(
	run: (f: {
		dir: string;
		provider: FakeSurfaceProvider;
		session: ReturnType<typeof runtime.createDefaultRunSession>;
		input: PiLaunchInput;
		settled: PiCompletedMetadata[];
		latest: () => PiRunRecord;
	}) => Promise<void>,
) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "maestro-149-exit-")));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	mkdirSync(join(dir, "sessions"));
	const provider = new FakeSurfaceProvider();
	const paneConfig = { mode: "tab", direction: "right", maxPerTab: 4 } as const;
	const operations = launchOperationsFromSurface(provider, paneConfig);
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	const coordinator = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
		false,
		new FileWakeRegistry(),
	);
	const settled: PiCompletedMetadata[] = [];
	let latest: PiRunRecord | undefined;
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: fileURLToPath(
			new URL("../../config.json.example", import.meta.url),
		),
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
		},
		forcePolling: false,
		roles: [],
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				invocationCwd: dir,
				sessionFile: parent,
				sessionId: "parent",
				sessionDir: join(dir, "sessions"),
				agentDir: dir,
			},
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig,
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["off", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned(record) {
				latest = record;
			},
			onSettled(_record, result) {
				settled.push(result);
			},
		},
		persistent: {
			send: () => ({ error: "test policy" }),
			stop: () => ({ error: "test policy" }),
			drain() {},
		},
	};
	const session = runtime.createDefaultRunSession(options);
	const input: PiLaunchInput = {
		task: {
			id: "early-exit",
			name: "Echo",
			prompt: "bounded",
			role: "",
			cwd: dir,
			behavior: { autoExit: true, persistent: false },
		},
		role: {
			name: "",
			version: "1",
			description: "fixture",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [
			{
				provider: "test",
				modelId: "one",
				model: "test/one",
				thinking: "high",
				modelSource: "request",
				thinkingSource: "parent",
			},
		],
		resolved: {},
		identity: {
			id: "public-early-exit",
			logicalId: "logical-early-exit",
			generationId: "generation-early-exit",
			taskId: "inbox-early-exit",
		},
	};
	try {
		await run({
			dir,
			provider,
			session,
			input,
			settled,
			latest: () => latest!,
		});
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
}

function delivered(result: PiCompletedMetadata): string {
	return renderParentMessage(
		resolveResultPresentation(
			{ ...result, sessionFile: result.sessionFile },
			result.name,
		),
	);
}

test("a child that exits before its session starts reports its last terminal lines to the parent", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		f.provider.appendScreen(
			record.surface,
			`$ bash '${record.launchScriptFile}'\n${LOAD_ERROR}\n${HINT}\n__SUBAGENT_DONE_1__\n`,
		);
		await wait;
		assert.equal(f.settled.length, 1);
		const result = f.settled[0];
		assert.equal(result.exitCode, 1);
		assert.equal(result.errorMessage, undefined, "not a provider error");
		assert.equal(
			result.summary,
			`Sub-agent exited with code 1 before its session started. Last output:\n${LOAD_ERROR}\n${HINT}`,
		);
		const text = delivered(result);
		assert.match(text, /Sub-agent "Echo" failed \(exit code 1\)\./);
		assert.ok(text.includes("status must be an object"), text);
		assert.ok(text.includes("pi -ne"), text);
	}));

test("an early exit with nothing printed keeps the plain exit-code summary", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		f.provider.appendScreen(
			record.surface,
			`$ bash '${record.launchScriptFile}'\n__SUBAGENT_DONE_1__\n`,
		);
		await wait;
		assert.equal(f.settled[0].summary, "Sub-agent exited with code 1");
	}));

test("a child whose session started is reported from its transcript, not its terminal", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		writeFileSync(
			record.sessionFile,
			[
				{ type: "session", version: 3, id: record.id, cwd: f.dir },
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "go" }] },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		f.provider.appendScreen(record.surface, "noise\n__SUBAGENT_DONE_1__\n");
		await wait;
		assert.equal(f.settled[0].summary, "Sub-agent exited with code 1");
	}));
