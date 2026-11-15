import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOTICE_CAP,
	NOTICE_CHILD_INTERVAL_MS,
} from "../../maestro/core/specialist-notice.ts";
import {
	appendPersistentTaskEvent,
	readPersistentTaskEvents,
} from "../../maestro/adapters/pi/session.ts";
import { buildSubagentToolAllowlist } from "../../maestro/adapters/pi/launch-command.ts";
import { launchPiSubagent } from "../../maestro/adapters/pi/launch.ts";
import subagentDoneExtension from "../../maestro/adapters/pi/child/protocol.ts";
import { createMockExtensionApi } from "../helpers/mock-extension-api.ts";

function withDir(run: (dir: string) => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "specialist-notice-"));
	return Promise.resolve(run(dir)).finally(() =>
		rmSync(dir, { recursive: true, force: true }),
	);
}

describe("caller_notify child tool", () => {
	const envKeys = [
		"PI_SUBAGENT_PERSISTENT",
		"PI_SUBAGENT_NOTIFY",
		"PI_SUBAGENT_SESSION",
		"PI_SUBAGENT_TASK_ID",
		"PI_SUBAGENT_GENERATION_ID",
		"PI_SUBAGENT_AUTO_EXIT",
		"PI_SUBAGENT_ACTIVITY_FILE",
	];

	async function withChild(
		env: Record<string, string>,
		run: (child: {
			sessionFile: string;
			tool: (name: string) => any;
		}) => Promise<void>,
	) {
		const previous = Object.fromEntries(
			envKeys.map((key) => [key, process.env[key]]),
		);
		const dir = mkdtempSync(join(tmpdir(), "caller-notify-"));
		const sessionFile = join(dir, "child.jsonl");
		for (const key of envKeys) delete process.env[key];
		Object.assign(process.env, {
			PI_SUBAGENT_SESSION: sessionFile,
			PI_SUBAGENT_TASK_ID: "task-1",
			PI_SUBAGENT_GENERATION_ID: "generation",
			...env,
		});
		const mock = createMockExtensionApi();
		subagentDoneExtension(mock.api);
		try {
			await run({
				sessionFile,
				tool: (name) =>
					mock.registeredTools.find((entry) => entry.name === name),
			});
		} finally {
			for (const handler of mock.eventHandlers.get("session_shutdown") ?? [])
				await handler({ reason: "quit" });
			for (const key of envKeys)
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			rmSync(dir, { recursive: true, force: true });
		}
	}

	const call = (tool: any, params: { message?: string } = {}) =>
		tool.execute("call", params, undefined, undefined, {});

	it("is registered only for a persistent specialist whose parent opted in", async () => {
		const unopted: Record<string, string>[] = [
			{ PI_SUBAGENT_PERSISTENT: "1" },
			{ PI_SUBAGENT_NOTIFY: "1" },
		];
		for (const env of unopted)
			await withChild(env, async ({ tool }) => {
				assert.equal(tool("caller_notify"), undefined);
				assert.ok(tool("caller_ping"));
			});
		await withChild(
			{ PI_SUBAGENT_PERSISTENT: "1", PI_SUBAGENT_NOTIFY: "1" },
			async ({ tool }) => assert.ok(tool("caller_notify")),
		);
	});

	it("records a numbered notice and leaves the current task open", () =>
		withChild(
			{ PI_SUBAGENT_PERSISTENT: "1", PI_SUBAGENT_NOTIFY: "1" },
			async ({ sessionFile, tool }) => {
				const result = await call(tool("caller_notify"), {
					message: "PR 12 changed",
				});
				assert.match(result.content[0].text, /^Notice 1 of 50 sent\./);
				await call(tool("subagent_done"));
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => [
						event.type,
						event.task,
						event.sequence,
						event.message,
					]),
					[
						["notice", "", 1, "PR 12 changed"],
						["task-done", "task-1", undefined, undefined],
					],
				);
			},
		));

	it("refuses a notice sooner than the child spacing, and past the cap", () =>
		withChild(
			{ PI_SUBAGENT_PERSISTENT: "1", PI_SUBAGENT_NOTIFY: "1" },
			async ({ sessionFile, tool }) => {
				await call(tool("caller_notify"), { message: "one" });
				await assert.rejects(
					call(tool("caller_notify"), { message: "two" }),
					/at least 30 seconds apart; try again in \d+ s/,
				);
				// Older notices, as after a child /reload, still count.
				const old = new Date(
					Date.now() - NOTICE_CHILD_INTERVAL_MS - 1,
				).toISOString();
				writeFileSync(sessionFile + ".tasks", "");
				for (let i = 1; i <= NOTICE_CAP; i++)
					appendPersistentTaskEvent(sessionFile, {
						type: "notice",
						task: "",
						generation: "generation",
						message: `n${i}`,
						sequence: i,
						at: old,
					});
				await assert.rejects(
					call(tool("caller_notify"), { message: "over" }),
					/notice cap \(50\)/,
				);
				assert.equal(
					readPersistentTaskEvents(sessionFile).length,
					NOTICE_CAP,
					"a refused notice is not recorded",
				);
			},
		));

	it("points caller_ping between tasks at caller_notify when opted in", () =>
		withChild(
			{ PI_SUBAGENT_PERSISTENT: "1", PI_SUBAGENT_NOTIFY: "1" },
			async ({ sessionFile, tool }) => {
				await call(tool("subagent_done"));
				await assert.rejects(
					call(tool("caller_ping"), { message: "changed" }),
					/no current task.*caller_notify/,
				);
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => event.type),
					["task-done"],
				);
			},
		));

	it("leaves caller_ping between tasks unchanged without the opt-in", () =>
		withChild(
			{ PI_SUBAGENT_PERSISTENT: "1" },
			async ({ sessionFile, tool }) => {
				await call(tool("subagent_done"));
				await call(tool("caller_ping"), { message: "changed" });
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => [
						event.type,
						event.task,
					]),
					[
						["task-done", "task-1"],
						["help-request", ""],
					],
				);
			},
		));
});

describe("notify launch opt-in", () => {
	it("adds caller_notify to a role allowlist only when opted in", () => {
		assert.equal(
			buildSubagentToolAllowlist("read", false, true),
			"read,caller_ping,caller_notify,subagent_done",
		);
		assert.equal(
			buildSubagentToolAllowlist("read", false),
			"read,caller_ping,subagent_done",
		);
		assert.equal(buildSubagentToolAllowlist(undefined, false, true), null);
	});

	it("passes the opt-in to a persistent child and records it on the run", () =>
		withDir(async (dir) => {
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({ type: "session", version: 3, id: "p", cwd: dir })}\n`,
			);
			const launch = (id: string, notify: boolean) =>
				launchPiSubagent(
					{
						kind: "fresh",
						id,
						name: "Watcher",
						task: "watch",
						parent: {
							cwd: dir,
							sessionFile: parentSession,
							sessionId: "parent-id",
							sessionDir: join(dir, "parent-sessions"),
							agentDir: join(dir, "agent"),
						},
						runtimePlan: {
							provider: "test",
							modelId: "model",
							model: "test/model",
							thinking: "low",
							modelSource: "request",
							thinkingSource: "request",
						},
						behavior: {
							tools: "read",
							deniedTools: [],
							autoExit: false,
							interactive: false,
							persistent: true,
							notify,
							generationId: "generation",
							taskId: "task-1",
							sessionMode: "standalone",
						},
					},
					{
						createPane: () => "pane",
						createWorktree() {
							throw new Error("not expected");
						},
						async waitForShellReady() {},
						runScript: (_surface: string, command: string) => {
							const file = join(dir, `${id}.sh`);
							writeFileSync(file, command);
							return file;
						},
						closePane() {},
					},
				);
			const opted = await launch("opted", true);
			const script = readFileSync(join(dir, "opted.sh"), "utf8");
			assert.match(script, /PI_SUBAGENT_NOTIFY=1/);
			assert.match(
				script,
				/--tools 'read,caller_ping,caller_notify,subagent_done'/,
			);
			assert.equal(opted.notify, true);
			const plain = await launch("plain", false);
			const plainScript = readFileSync(join(dir, "plain.sh"), "utf8");
			assert.match(plainScript, /PI_SUBAGENT_NOTIFY=0/);
			assert.doesNotMatch(plainScript, /caller_notify/);
			assert.equal(plain.notify, undefined);
		}));
});
