import "./clean-host-env.ts";
import {
	captureWorktreeHandoff,
	writeWorktreeManifest,
	createWorktreeOperations,
} from "../maestro/runtime/worktree-operations.ts";
import { buildSubagentToolAllowlist } from "../maestro/adapters/pi/launch-command.ts";
import "./isolated-agent-dir.ts";
import { createMockExtensionApi } from "./helpers/mock-extension-api.ts";
import { describe, it, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	realpathSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isString } from "../maestro/core/config/type-guards.ts";
import {
	getLeafId,
	getNewEntries,
	findLastAssistantSummary,
	inspectFinalAssistantMessage,
	inspectNoProgressSessionTail,
	findObservedSessionRuntime,
	appendBranchSummary,
	copySessionFile,
	mergeNewEntries,
	seedSubagentSessionFile,
	createWorktreeSessionFork,
	getSubagentSessionPolicyFile,
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
	appendPersistentTaskEvent,
	readPersistentTaskEvents,
	appendPersistentDeliveryLedger,
	readPersistentDeliveryLedger,
	writePersistentTaskInbox,
	consumePersistentTaskInbox,
	type SessionEntry,
} from "../maestro/adapters/pi/session.ts";
import {
	createSubagentActivityRecorder,
	getSubagentActivityFile,
	readSubagentActivityFile,
} from "../maestro/adapters/pi/activity-file.ts";
import subagentDoneExtension, {
	shouldMarkUserTookOver,
	shouldAutoExitOnAgentEnd,
	findLatestAssistantError,
	buildCompletionSidecar,
	buildPersistentTaskEvent,
} from "../maestro/adapters/pi/child/protocol.ts";
import {
	createDoneNudge,
	DONE_NUDGE_DELAY_MS,
	DONE_NUDGE_MESSAGE,
} from "../maestro/adapters/pi/child/done-nudge.ts";
import {
	CHILD_BUSY_CHANNEL,
	type ChildBusyProbe,
} from "../maestro/core/child-busy.ts";
import {
	interpretExitSidecar,
	shellExitFileFor,
	waitForCompletion,
} from "../maestro/adapters/pi/completion.ts";
import { launchPiSubagent } from "../maestro/adapters/pi/launch.ts";
import { AcquisitionUncertainError } from "../maestro/core/surface-provider.ts";

const inheritedSubagentId = process.env.PI_SUBAGENT_ID;

const inheritedDenyTools = process.env.PI_DENY_TOOLS;

before(() => {
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_DENY_TOOLS;
});

after(() => {
	if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
	else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
	if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
	else process.env.PI_DENY_TOOLS = inheritedDenyTools;
});

function createTestDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "subagents-test-")));
}

function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(file, content);
	return file;
}

function withTempDir(run: (dir: string) => void) {
	const dir = createTestDir();
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function restoreEnvVar(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

const SESSION_HEADER: SessionEntry = {
	type: "session",
	id: "sess-001",
	version: 3,
};

const MODEL_CHANGE: SessionEntry = {
	type: "model_change",
	id: "mc-001",
	parentId: null,
};

const USER_MSG: SessionEntry = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, plan something" }],
	},
};

const ASSISTANT_MSG: SessionEntry = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my plan..." }],
	},
};

const ASSISTANT_MSG_2: SessionEntry = {
	type: "message",
	id: "asst-002",
	parentId: "asst-001",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think..." },
			{ type: "text", text: "Updated plan with details." },
		],
	},
};

const TOOL_RESULT: SessionEntry = {
	type: "message",
	id: "tool-001",
	parentId: "asst-001",
	message: {
		role: "toolResult",
		toolCallId: "tc-001",
		toolName: "bash",
		content: [{ type: "text", text: "output here" }],
	},
};

describe("session.ts", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getLeafId", () => {
		it("returns last entry id", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			assert.equal(getLeafId(file), "asst-001");
		});

		it("returns null for empty file", () => {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			assert.equal(getLeafId(file), null);
		});
	});

	describe("getNewEntries", () => {
		it("returns entries after a given line", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 2);
			assert.equal(entries[0].id, "user-001");
			assert.equal(entries[1].id, "asst-001");
		});

		it("returns empty array when no new entries", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 0);
		});
	});

	describe("findLastAssistantSummary", () => {
		it("finds last assistant text", () => {
			const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2];
			assert.deepEqual(findLastAssistantSummary(entries), {
				summary: "Updated plan with details.",
				summarySource: "child",
			});
		});

		it("skips thinking blocks, gets text only", () => {
			const entries = [ASSISTANT_MSG_2];
			assert.deepEqual(findLastAssistantSummary(entries), {
				summary: "Updated plan with details.",
				summarySource: "child",
			});
		});

		it("skips tool results", () => {
			const entries = [ASSISTANT_MSG, TOOL_RESULT];
			assert.deepEqual(findLastAssistantSummary(entries), {
				summary: "Here is my plan...",
				summarySource: "child",
			});
		});

		it("returns null when no assistant messages", () => {
			const entries = [USER_MSG];
			assert.equal(findLastAssistantSummary(entries), null);
		});

		it("returns null for empty array", () => {
			assert.equal(findLastAssistantSummary([]), null);
		});

		it("reports an empty final completion instead of reusing an earlier assistant message", () => {
			const realMsg: SessionEntry = {
				type: "message",
				id: "real",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Real summary content." }],
				},
			};
			const emptyMsg: SessionEntry = {
				type: "message",
				id: "empty",
				message: {
					role: "assistant",
					content: [],
					stopReason: "stop",
				},
			};
			const entries = [realMsg, emptyMsg];
			assert.deepEqual(findLastAssistantSummary(entries), {
				summary: "Real summary content.",
				summarySource: "child",
			});
			assert.deepEqual(inspectFinalAssistantMessage(entries), {
				text: null,
				contentLength: 0,
				stopReason: "stop",
			});
		});

		it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
			// Reproduces the overload-exhaustion case: an earlier turn looked
			// normal, then the provider went 529 and auto-retry gave up. Without
			// the errorMessage fallback we'd return the stale earlier summary and
			// the orchestrator would believe the subagent completed.
			const earlierGood: SessionEntry = {
				type: "message",
				id: "earlier-good",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const overloadError: SessionEntry = {
				type: "message",
				id: "overload-error",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded after 3 retries",
				},
			};
			const entries = [earlierGood, overloadError];
			assert.deepEqual(findLastAssistantSummary(entries), {
				summary: "Subagent error: Anthropic 529 Overloaded after 3 retries",
				summarySource: "child-error",
			});
		});

		it("prefers text content even when an error stopReason is set", () => {
			// If the model produced text before the error (rare but possible), we
			// prefer the actual content over the synthetic error fallback.
			const msg: SessionEntry = {
				type: "message",
				id: "partial",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is partial output." }],
					stopReason: "error",
					errorMessage: "stream interrupted",
				},
			};
			assert.deepEqual(findLastAssistantSummary([msg]), {
				summary: "Here is partial output.",
				summarySource: "child",
			});
		});

		it("does not invent a summary for a stop=error message with no errorMessage", () => {
			const msg: SessionEntry = {
				type: "message",
				id: "no-error-message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			};
			assert.equal(findLastAssistantSummary([msg]), null);
		});

		it("preserves an assistant record that starts exactly at the bounded tail", () => {
			withTempDir((dir) => {
				const session = join(dir, "exact-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const tail = `${assistant}\n${"x".repeat(
					128 * 1024 - Buffer.byteLength(assistant) - 1,
				)}`;
				writeFileSync(session, `{"type":"session"}\n${tail}`);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("skips a mid-record cut before a multibyte character", () => {
			withTempDir((dir) => {
				const session = join(dir, "mid-record-boundary.jsonl");
				const assistant = JSON.stringify({
					type: "message",
					id: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						stopReason: "toolUse",
					},
				});
				const beforeBoundary = Buffer.from(`partial-${"é"}`);
				const afterBoundary = Buffer.from(`\n${assistant}\n`);
				const tail = Buffer.concat([
					beforeBoundary.subarray(-1),
					afterBoundary,
					Buffer.alloc(128 * 1024 - 1 - afterBoundary.length, "x"),
				]);
				writeFileSync(
					session,
					Buffer.concat([beforeBoundary.subarray(0, -1), tail]),
				);

				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});
			});
		});

		it("classifies bounded JSONL tails without trusting malformed trailing lines", () => {
			withTempDir((dir) => {
				const session = join(dir, "hang.jsonl");
				const writeTail = (entries: unknown[]) =>
					writeFileSync(
						session,
						`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{torn`,
					);
				const assistant = (content: unknown[], stopReason?: string) => ({
					type: "message",
					id: "assistant",
					message: { role: "assistant", content, stopReason },
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant(
						[{ type: "toolCall", id: "call-1", name: "bash" }],
						"toolUse",
					),
					{
						type: "message",
						id: "result",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "blocked-tool",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "toolCall", id: "call-1", name: "bash" },
							{ type: "toolCall", id: "call-2", name: "read" },
						],
						"toolUse",
					),
					{
						type: "message",
						id: "result-1",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							content: [],
						},
					},
					{
						type: "message",
						id: "result-2",
						message: {
							role: "toolResult",
							toolCallId: "call-2",
							content: [],
						},
					},
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "tool-result",
				});

				writeTail([
					assistant(
						[
							{ type: "thinking", thinking: "need a tool" },
							{ type: "text", text: "Running it." },
						],
						"toolUse",
					),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "truncated-turn",
					lastEntryKind: "assistant",
				});

				writeTail([
					assistant([{ type: "text", text: "still working" }], "stop"),
				]);
				assert.deepEqual(inspectNoProgressSessionTail(session), {
					classification: "generic-no-progress",
					lastEntryKind: "assistant",
				});
			});
		});
	});

	describe("findObservedSessionRuntime", () => {
		it("extracts the latest model and thinking entries", () => {
			assert.deepEqual(
				findObservedSessionRuntime([
					{ type: "model_change", id: "m1", provider: "fake", modelId: "old" },
					{ type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
					{ type: "model_change", id: "m2", provider: "other", modelId: "new" },
				]),
				{ provider: "other", modelId: "new", thinking: "medium" },
			);
		});
	});

	describe("appendBranchSummary", () => {
		it("appends valid branch_summary entry", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const id = appendBranchSummary(
				file,
				"user-001",
				"asst-001",
				"The plan was created.",
			);

			assert.ok(id, "should return an id");
			assert.ok(isString(id));

			// Read back and verify
			const lines = readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 4); // 3 original + 1 summary

			const summary = JSON.parse(lines[3]);
			assert.equal(summary.type, "branch_summary");
			assert.equal(summary.id, id);
			assert.equal(summary.parentId, "user-001");
			assert.equal(summary.fromId, "asst-001");
			assert.equal(summary.summary, "The plan was created.");
			assert.ok(summary.timestamp);
		});

		it("uses branchPointId as fromId fallback", () => {
			const file = createSessionFile(dir, [SESSION_HEADER]);
			appendBranchSummary(file, "branch-pt", null, "summary");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const summary = JSON.parse(lines[1]);
			assert.equal(summary.fromId, "branch-pt");
		});
	});

	describe("copySessionFile", () => {
		it("creates a copy with different path", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const copyDir = join(dir, "copies");
			mkdirSync(copyDir, { recursive: true });
			const copy = copySessionFile(file, copyDir);

			assert.notEqual(copy, file);
			assert.ok(copy.endsWith(".jsonl"));
			assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
		});
	});

	describe("subagent session policy", () => {
		it("persists an explicit allowlist separately from unrestricted launches", () => {
			const restricted = join(dir, "restricted-policy.jsonl");
			const unrestricted = join(dir, "unrestricted-policy.jsonl");
			writeSubagentSessionPolicy(restricted, {
				owner: "public",
				tools: "read, read, ",
				deniedTools: ["subagent", "subagent"],
			});
			writeSubagentSessionPolicy(unrestricted, {
				owner: "public",
				deniedTools: [],
			});

			const restrictedPolicy = readSubagentSessionPolicy(restricted);
			assert.equal(restrictedPolicy.version, 2);
			assert.equal(restrictedPolicy.owner, "public");
			assert.deepEqual(restrictedPolicy.tools, ["read"]);
			assert.deepEqual(restrictedPolicy.deniedTools, ["subagent"]);
			assert.equal(restrictedPolicy.persistent, false);
			assert.equal(readSubagentSessionPolicy(unrestricted).tools, null);
			assert.equal(existsSync(getSubagentSessionPolicyFile(restricted)), true);
		});

		it("fails closed for missing, malformed, and unsupported policies", () => {
			const sessionFile = join(dir, "policy-errors.jsonl");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy is missing/,
			);

			const policyFile = getSubagentSessionPolicyFile(sessionFile);
			writeFileSync(policyFile, "not json", "utf8");
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/saved launch policy cannot be read/,
			);

			writeFileSync(
				policyFile,
				JSON.stringify({
					version: 3,
					owner: "public",
					tools: null,
					deniedTools: [],
				}),
				"utf8",
			);
			assert.throws(
				() => readSubagentSessionPolicy(sessionFile),
				/launch policy version is unsupported/,
			);
		});
	});

	it("writes v2 persistent policies and reads v1 compatibility", () => {
		const persistent = join(dir, "persistent-policy.jsonl");
		writeSubagentSessionPolicy(persistent, {
			owner: "public",
			tools: ["read"],
			deniedTools: ["subagent"],
			persistent: true,
			logicalId: "logical-1",
			generationId: "generation-1",
		});
		const read = readSubagentSessionPolicy(persistent);
		assert.equal(read.version, 2);
		assert.equal(read.persistent, true);
		assert.equal(read.logicalId, "logical-1");
		assert.match(read.policyHash, /^[a-f0-9]{64}$/);

		const legacy = join(dir, "legacy-policy.jsonl");
		writeFileSync(
			getSubagentSessionPolicyFile(legacy),
			JSON.stringify({
				version: 1,
				owner: "public",
				tools: null,
				deniedTools: [],
			}),
		);
		assert.deepEqual(readSubagentSessionPolicy(legacy), {
			version: 1,
			owner: "public",
			tools: null,
			deniedTools: [],
			persistent: false,
		});
	});

	it("appends task events and ignores a torn tail", () => {
		const sessionFile = join(dir, "tasks.jsonl");
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "task-1",
			generation: "generation-1",
		});
		writeFileSync(`${sessionFile}.tasks`, '{"version":1', { flag: "a" });
		assert.deepEqual(
			readPersistentTaskEvents(sessionFile).map((event) => event.task),
			["task-1"],
		);
	});

	it("preserves invalid inbox claims as evidence and recovers interrupted claims", () => {
		withTempDir((dir) => {
			const sessionFile = join(dir, "recover-inbox.jsonl");
			const invalid = writePersistentTaskInbox(sessionFile, 1, {
				task: "bad",
				message: "will be corrupted",
			});
			writeFileSync(invalid, "not json");
			assert.equal(consumePersistentTaskInbox(sessionFile), null);
			assert.equal(existsSync(`${invalid}.invalid`), true);

			const interrupted = writePersistentTaskInbox(sessionFile, 2, {
				task: "recovered",
				message: "finish this",
			});
			renameSync(interrupted, `${interrupted}.consuming`);
			assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "recovered");
			assert.equal(existsSync(`${interrupted}.consuming`), false);
		});
	});

	it("records delivery outcomes and atomically consumes each inbox task once", () => {
		const sessionFile = join(dir, "inbox.jsonl");
		appendPersistentDeliveryLedger(sessionFile, {
			task: "task-1",
			outcome: "dispatched",
			generation: "generation-1",
			logicalId: "logical-1",
			policyHash: "a".repeat(64),
		});
		assert.equal(
			readPersistentDeliveryLedger(sessionFile)[0].outcome,
			"dispatched",
		);
		const inbox = writePersistentTaskInbox(sessionFile, 1, {
			task: "task-2",
			message: "next task",
		});
		assert.ok(existsSync(inbox));
		assert.equal(consumePersistentTaskInbox(sessionFile)?.task, "task-2");
		assert.equal(consumePersistentTaskInbox(sessionFile), null);
	});

	describe("seedSubagentSessionFile", () => {
		it("creates a lineage-only child session with parent linkage and no copied turns", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "lineage-child.jsonl");

			seedSubagentSessionFile({
				mode: "lineage-only",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/child-cwd",
			});

			const lines = readFileSync(childFile, "utf8").trim().split("\n");
			assert.equal(lines.length, 1);

			const header = JSON.parse(lines[0]);
			assert.equal(header.type, "session");
			assert.equal(header.parentSession, parentFile);
			assert.equal(header.cwd, "/tmp/child-cwd");
		});

		it("creates a forked child session with copied context before the triggering user turn", () => {
			const parentFile = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const childFile = join(dir, "fork-child.jsonl");

			seedSubagentSessionFile({
				mode: "fork",
				parentSessionFile: parentFile,
				childSessionFile: childFile,
				childCwd: "/tmp/fork-child-cwd",
			});

			const entries = readFileSync(childFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(entries.length, 2);
			assert.equal(entries[0].type, "session");
			assert.equal(entries[0].parentSession, parentFile);
			assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
			assert.equal(entries[1].type, "model_change");
			assert.equal(
				entries.some(
					(entry) =>
						entry.type === "session" && entry.parentSession !== parentFile,
				),
				false,
			);
			assert.equal(
				entries.some((entry) => entry.type === "message"),
				false,
			);
		});
	});

	describe("createWorktreeSessionFork", () => {
		it("preserves the active branch, target cwd, and parent immutability", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "handoff-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "root-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "root" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "root-assistant",
					parentId: "root-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "base" }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "abandoned-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "abandoned" }],
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "active-user",
					parentId: "root-assistant",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "active" }],
						timestamp: 4,
					},
				},
				{
					type: "message",
					id: "active-assistant",
					parentId: "active-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "current" }],
						timestamp: 5,
					},
				},
			]);
			const parentBefore = readFileSync(parentFile, "utf8");
			const childFile = join(dir, "handoff-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "active-assistant",
				childSessionFile: childFile,
				childCwd: "/tmp/handoff-worktree",
				handoffMessage: "Continue in the worktree.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getHeader()?.cwd, "/tmp/handoff-worktree");
			assert.equal(child.getHeader()?.parentSession, parentFile);
			assert.deepEqual(
				child
					.getBranch()
					.map((entry) => entry.id)
					.slice(0, 4),
				["root-user", "root-assistant", "active-user", "active-assistant"],
			);
			assert.equal(readFileSync(parentFile, "utf8"), parentBefore);
			const leafEntry = child.getLeafEntry();
			if (leafEntry?.type !== "custom_message") {
				throw new Error("expected a custom_message leaf entry");
			}
			assert.equal(leafEntry.content, "Continue in the worktree.");
		});

		it("preserves compaction entries on the active branch", () => {
			const timestamp = "2026-07-31T00:00:00.000Z";
			const parentFile = createSessionFile(dir, [
				{
					type: "session",
					version: 3,
					id: "compaction-parent",
					timestamp,
					cwd: dir,
				},
				{
					type: "message",
					id: "compaction-user",
					parentId: null,
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "start" }],
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "compaction-assistant",
					parentId: "compaction-user",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "summary follows" }],
						timestamp: 2,
					},
				},
				{
					type: "compaction",
					id: "compaction-entry",
					parentId: "compaction-assistant",
					timestamp,
					summary: "Earlier context summary",
					firstKeptEntryId: "compaction-assistant",
					tokensBefore: 100,
				},
			]);
			const childFile = join(dir, "compaction-child.jsonl");

			createWorktreeSessionFork({
				parentSessionFile: parentFile,
				leafId: "compaction-entry",
				childSessionFile: childFile,
				childCwd: "/tmp/compaction-worktree",
				handoffMessage: "Continue after compaction.",
			});

			const child = SessionManager.open(childFile);
			assert.equal(child.getEntry("compaction-entry")?.type, "compaction");
			assert.equal(child.getHeader()?.cwd, "/tmp/compaction-worktree");
		});
	});

	describe("mergeNewEntries", () => {
		it("appends new entries from source to target", () => {
			// Source starts with same base (2 entries), then has 1 new entry
			const sourceFile = join(dir, "merge-source.jsonl");
			const targetFile = join(dir, "merge-target.jsonl");
			writeFileSync(
				sourceFile,
				[SESSION_HEADER, USER_MSG, ASSISTANT_MSG]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			writeFileSync(
				targetFile,
				[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") +
					"\n",
			);

			// Merge entries after line 2 (the shared base)
			const merged = mergeNewEntries(sourceFile, targetFile, 2);
			assert.equal(merged.length, 1);
			assert.equal(merged[0].id, "asst-001");

			// Target should now have 3 entries
			const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
			assert.equal(targetLines.length, 3);
		});
	});
});

describe("subagent resume launch policy", () => {
	function runtimePlan() {
		return {
			provider: "test",
			modelId: "model",
			model: "test/model",
			thinking: "low" as const,
			modelSource: "request" as const,
			thinkingSource: "request" as const,
		};
	}

	function launchOperations(commands: string[], createPane = () => "pane") {
		return {
			createPane,
			createWorktree() {
				throw new Error("worktree creation is not expected");
			},
			async waitForShellReady() {},
			runScript(_surface: string, command: string) {
				commands.push(command);
				return "/tmp/launch.sh";
			},
			closePane() {},
		};
	}

	it("snapshots restricted tools and spawning denial for repeated public resumes", async () => {
		const dir = createTestDir();
		try {
			const commands: string[] = [];
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify(SESSION_HEADER)}\n`,
				"utf8",
			);
			const fresh = await launchPiSubagent(
				{
					kind: "fresh",
					id: "fresh-id",
					name: "Restricted",
					task: "inspect",
					parent: {
						cwd: dir,
						sessionFile: parentSession,
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
						agentDir: join(dir, "agent"),
					},
					runtimePlan: runtimePlan(),
					behavior: {
						tools: "read",
						deniedTools: ["subagent", "subagent_resume"],
						autoExit: true,
						interactive: false,
						sessionMode: "standalone",
					},
				},
				launchOperations(commands),
			);
			// The mocked launch does not start Pi, which normally writes this header.
			writeFileSync(
				fresh.sessionFile,
				`${JSON.stringify({ ...SESSION_HEADER, cwd: dir })}\n`,
				"utf8",
			);
			const policy = readSubagentSessionPolicy(fresh.sessionFile);
			assert.equal(policy.version, 2);
			assert.equal(policy.owner, "public");
			assert.deepEqual(policy.tools, ["read"]);
			assert.deepEqual(policy.deniedTools, ["subagent", "subagent_resume"]);
			assert.equal(policy.persistent, false);

			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
					behavior: { autoExit: false },
				},
				launchOperations(commands),
			);
			await launchPiSubagent(
				{
					kind: "resume",
					name: "Restricted again",
					sessionFile: fresh.sessionFile,
					parent: {
						sessionId: "parent-id",
						sessionDir: join(dir, "parent-sessions"),
					},
				},
				launchOperations(commands),
			);

			assert.match(
				commands[1],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping,subagent_done'/,
			);
			assert.match(
				commands[2],
				/PI_DENY_TOOLS='subagent,subagent_resume'.*--tools 'read,caller_ping'/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects absent, malformed, unknown-owner, and worktree policies before pane creation", async () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "resume.jsonl");
			let panes = 0;
			const operations = launchOperations([], () => {
				panes += 1;
				return "unexpected-pane";
			});
			const resume = () =>
				launchPiSubagent(
					{
						kind: "resume",
						name: "Resume",
						sessionFile,
						parent: { sessionId: "parent-id", sessionDir: dir },
					},
					operations,
				);

			await assert.rejects(resume, /saved launch policy is missing/);
			writeFileSync(getSubagentSessionPolicyFile(sessionFile), "{", "utf8");
			await assert.rejects(resume, /saved launch policy cannot be read/);
			for (const tools of [[], ["read,write"], [" read"]]) {
				writeFileSync(
					getSubagentSessionPolicyFile(sessionFile),
					JSON.stringify({
						version: 1,
						owner: "public",
						tools,
						deniedTools: [],
					}),
					"utf8",
				);
				await assert.rejects(resume, /saved launch tool policy is malformed/);
			}
			writeFileSync(
				getSubagentSessionPolicyFile(sessionFile),
				JSON.stringify({
					version: 1,
					owner: "workflow",
					tools: ["read"],
					deniedTools: [],
				}),
				"utf8",
			);
			await assert.rejects(resume, /saved launch policy owner is invalid/);
			writeSubagentSessionPolicy(sessionFile, {
				owner: "managed-worktree",
				tools: ["read"],
				deniedTools: [],
			});
			await assert.rejects(resume, /Cannot resume managed-worktree/);
			assert.equal(panes, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("subagent discovery", () => {
	it("buildSubagentToolAllowlist keeps explicit completion for interactive children", () => {
		assert.equal(
			buildSubagentToolAllowlist("read,bash,web_search"),
			"read,bash,web_search,caller_ping,subagent_done",
		);
	});

	it("buildSubagentToolAllowlist omits explicit completion for auto-exit children", () => {
		assert.equal(
			buildSubagentToolAllowlist("read,bash,web_search,subagent_done", true),
			"read,bash,web_search,caller_ping",
		);
	});

	it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
		assert.equal(buildSubagentToolAllowlist(undefined), null);
		assert.equal(buildSubagentToolAllowlist(""), null);
	});
});

describe("subagent-done.ts", () => {
	it("builds a persistent task completion event", () => {
		const event = buildPersistentTaskEvent("task-1", "generation-1");
		assert.equal(event.version, 1);
		assert.equal(event.type, "task-done");
		assert.equal(event.task, "task-1");
		assert.equal(event.generation, "generation-1");
		assert.ok(event.at);
	});

	it("injects the declared skills its own Pi loaded on the first run only", async () => {
		const dir = createTestDir();
		const previous = process.env.PI_SUBAGENT_SKILLS;
		process.env.PI_SUBAGENT_SKILLS = '["tdd","absent"]';
		try {
			const filePath = join(dir, "tdd", "SKILL.md");
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(
				filePath,
				"---\nname: tdd\ndescription: d\n---\nTDD body.\n",
			);
			const { api, eventHandlers } = createMockExtensionApi();
			subagentDoneExtension(api);
			const run = async () => {
				const results = [];
				for (const handler of eventHandlers.get("before_agent_start") ?? [])
					results.push(
						await handler({
							systemPromptOptions: {
								skills: [{ name: "tdd", filePath, baseDir: dirname(filePath) }],
							},
						}),
					);
				return results.filter(Boolean);
			};
			const [first] = await run();
			assert.match(
				first.message.content,
				/^<skill name="tdd"[\s\S]*TDD body\./,
			);
			assert.match(first.message.content, /not loaded by Pi: absent/);
			assert.deepEqual(await run(), [], "later runs inject nothing");
			assert.equal(process.env.PI_SUBAGENT_SKILLS, undefined);
		} finally {
			restoreEnvVar("PI_SUBAGENT_SKILLS", previous);
		}
	});

	it("does not register subagent_done for auto-exit children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "caller_ping"),
				true,
			);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				false,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	it("restarts persistent inbox polling after reload when the initial task is already done", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const sessionFile = join(dir, "persistent-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		writePersistentTaskInbox(sessionFile, 1, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, sentUserMessages } = createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resumes activity recording when a persistent specialist receives its next task", async () => {
		const dir = createTestDir();
		const envKeys = [
			"PI_SUBAGENT_PERSISTENT",
			"PI_SUBAGENT_SESSION",
			"PI_SUBAGENT_TASK_ID",
			"PI_SUBAGENT_GENERATION_ID",
			"PI_SUBAGENT_AUTO_EXIT",
			"PI_SUBAGENT_ID",
			"PI_SUBAGENT_ACTIVITY_FILE",
		];
		const previous = Object.fromEntries(
			envKeys.map((key) => [key, process.env[key]]),
		);
		const sessionFile = join(dir, "persistent-activity.jsonl");
		const activityFile = getSubagentActivityFile(dir, "persistent-child");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "task-1";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		process.env.PI_SUBAGENT_ID = "persistent-child";
		process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		let shutdown: Function | undefined;
		const read = () => {
			const result = readSubagentActivityFile(activityFile, "persistent-child");
			assert.ok(result.ok);
			return result.activity;
		};
		try {
			const { api, eventHandlers, registeredTools, sentUserMessages } =
				createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			const fire = (name: string, event: any = {}) =>
				eventHandlers.get(name)?.[0](event, {
					ui: { setWidget() {} },
					shutdown() {},
				});
			const done = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(done);

			fire("session_start");
			fire("agent_start");
			fire("tool_execution_start", { toolCallId: "t1", toolName: "bash" });
			assert.equal(read().phase, "active");

			// First task ends with subagent_done; the tool's own trailing events
			// and the closing agent_end must not undo the final snapshot.
			await done.execute("call", {}, undefined, undefined, {});
			fire("tool_execution_end", {
				toolCallId: "done-1",
				toolName: "subagent_done",
			});
			fire("agent_end", { messages: [] });
			assert.equal(read().phase, "done");

			writePersistentTaskInbox(sessionFile, 1, {
				task: "task-2",
				message: "next",
			});
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
			assert.notEqual(read().phase, "done");
			assert.equal(read().phase, "active");

			fire("input");
			fire("before_agent_start");
			fire("agent_start");
			fire("tool_execution_start", { toolCallId: "t2", toolName: "read" });
			const working = read();
			assert.equal(working.phase, "active");
			assert.equal(working.activeScope, "tool");
			assert.equal(working.toolName, "read");

			await done.execute("call", {}, undefined, undefined, {});
			fire("agent_end", { messages: [] });
			assert.equal(read().phase, "done");
		} finally {
			shutdown?.({ reason: "reload" });
			for (const key of envKeys) restoreEnvVar(key, previous[key]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a non-persistent child's done snapshot final", async () => {
		const dir = createTestDir();
		const envKeys = [
			"PI_SUBAGENT_PERSISTENT",
			"PI_SUBAGENT_SESSION",
			"PI_SUBAGENT_AUTO_EXIT",
			"PI_SUBAGENT_ID",
			"PI_SUBAGENT_ACTIVITY_FILE",
		];
		const previous = Object.fromEntries(
			envKeys.map((key) => [key, process.env[key]]),
		);
		const activityFile = getSubagentActivityFile(dir, "plain-child");
		delete process.env.PI_SUBAGENT_PERSISTENT;
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_SESSION = join(dir, "plain.jsonl");
		process.env.PI_SUBAGENT_ID = "plain-child";
		process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			const fire = (name: string, event: any = {}) =>
				eventHandlers.get(name)?.[0](event, {
					ui: { setWidget() {} },
					shutdown() {},
				});
			const done = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(done);
			fire("session_start");
			fire("agent_start");
			await done.execute("call", {}, undefined, undefined, {
				shutdown() {},
			});
			fire("agent_start");
			fire("tool_execution_start", { toolCallId: "t1", toolName: "bash" });
			const result = readSubagentActivityFile(activityFile, "plain-child");
			assert.ok(result.ok);
			assert.equal(result.activity.phase, "done");
			assert.equal(result.activity.latestEvent, "subagent_done");
		} finally {
			for (const key of envKeys) restoreEnvVar(key, previous[key]);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps polling paused after reload while a dispatched follow-up remains unsettled", async () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const sessionFile = join(dir, "persistent-follow-up-reload.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "initial-task";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		appendPersistentDeliveryLedger(sessionFile, {
			task: "initial-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		appendPersistentTaskEvent(sessionFile, {
			type: "task-done",
			task: "initial-task",
			generation: "generation",
		});
		appendPersistentDeliveryLedger(sessionFile, {
			task: "follow-up-task",
			outcome: "dispatched",
			generation: "generation",
			logicalId: "logical",
			policyHash: "a".repeat(64),
		});
		writePersistentTaskInbox(sessionFile, 2, {
			task: "next-task",
			message: "next",
		});
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers, registeredTools, sentUserMessages } =
				createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, []);

			const done = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(done);
			await done.execute("call", {}, undefined, undefined, {});
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.deepEqual(sentUserMessages, ["next"]);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers subagent_done for interactive children", () => {
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		try {
			const { api, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			assert.equal(
				registeredTools.some((tool) => tool.name === "subagent_done"),
				true,
			);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
		}
	});

	describe("done nudge", () => {
		const stopped = [{ role: "assistant", stopReason: "stop" }];

		const idleCtx = {
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: { getEditorText: () => "" },
		};

		function harness(t: TestContext, options: { busy?: boolean } = {}) {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const sent: string[] = [];
			const nudge = createDoneNudge({
				send: (message) => sent.push(message),
				isBusy: () => options.busy ?? false,
			});
			const wait = (ms = DONE_NUDGE_DELAY_MS) => t.mock.timers.tick(ms);
			return { nudge, sent, wait };
		}

		it("asks once, 3 seconds after a normal run, and not after the run it started", (t) => {
			const { nudge, sent, wait } = harness(t);
			assert.equal(DONE_NUDGE_DELAY_MS, 3_000);
			nudge.runStarting();
			nudge.settled(stopped, false, idleCtx);
			wait(DONE_NUDGE_DELAY_MS - 1);
			assert.deepEqual(sent, []);
			wait(1);
			assert.deepEqual(sent, [DONE_NUDGE_MESSAGE]);

			nudge.runStarting();
			nudge.settled(stopped, false, idleCtx);
			wait();
			assert.deepEqual(sent, [DONE_NUDGE_MESSAGE]);

			// Any later run, such as one a subagent result starts, re-arms it.
			nudge.runStarting();
			nudge.settled(stopped, false, idleCtx);
			wait();
			assert.deepEqual(sent, [DONE_NUDGE_MESSAGE, DONE_NUDGE_MESSAGE]);
		});

		it("stays quiet before any run, and after an aborted or failed run", (t) => {
			const { nudge, sent, wait } = harness(t);
			nudge.settled(stopped, false, idleCtx);
			wait();
			nudge.runStarting();
			nudge.settled(stopped, true, idleCtx);
			wait();
			for (const stopReason of ["aborted", "error"]) {
				nudge.settled([{ role: "assistant", stopReason }], false, idleCtx);
				wait();
			}
			assert.deepEqual(sent, []);
		});

		it("cancels when a new run starts within the delay", (t) => {
			const { nudge, sent, wait } = harness(t);
			nudge.runStarting();
			nudge.settled(stopped, false, idleCtx);
			wait(1_000);
			nudge.runStarting();
			wait();
			assert.deepEqual(sent, []);
		});

		it("skips a child with working subagents, queued messages, or a draft in its editor", (t) => {
			const busy = harness(t, { busy: true });
			busy.nudge.runStarting();
			busy.nudge.settled(stopped, false, idleCtx);
			busy.wait();
			assert.deepEqual(busy.sent, []);

			for (const ctx of [
				{ ...idleCtx, isIdle: () => false },
				{ ...idleCtx, hasPendingMessages: () => true },
				{ ...idleCtx, ui: { getEditorText: () => "half-typed" } },
			]) {
				const sent: string[] = [];
				const nudge = createDoneNudge({
					send: (message) => sent.push(message),
					isBusy: () => false,
				});
				nudge.runStarting();
				nudge.settled(stopped, false, ctx);
				busy.wait();
				assert.deepEqual(sent, []);
			}
		});

		it("is wired into children without auto-exit only", (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			// An auto-exit settle writes the completion sidecar of PI_SUBAGENT_SESSION,
			// so a run inside a real subagent must not reach that subagent's files.
			const dir = createTestDir();
			const inherited = [
				"PI_SUBAGENT_AUTO_EXIT",
				"PI_SUBAGENT_PERSISTENT",
				"PI_SUBAGENT_SESSION",
				"PI_SUBAGENT_ID",
				"PI_SUBAGENT_ACTIVITY_FILE",
				"PI_SUBAGENT_PROCESS_FILE",
			].map((name) => [name, process.env[name]] as const);
			for (const [name] of inherited) delete process.env[name];
			process.env.PI_SUBAGENT_SESSION = join(dir, "child.jsonl");
			try {
				const run = (autoExit: boolean, busy = false) => {
					if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
					else delete process.env.PI_SUBAGENT_AUTO_EXIT;
					const { api, eventHandlers, sentUserMessages } =
						createMockExtensionApi();
					if (busy)
						api.events.on(CHILD_BUSY_CHANNEL, (probe: ChildBusyProbe) => {
							probe.busy = true;
						});
					subagentDoneExtension(api);
					const emit = (
						name: string,
						event: {
							prompt?: string;
							messages?: typeof stopped;
							aborted?: boolean;
							reason?: string;
						},
						ctx: Partial<typeof idleCtx> & {
							sessionManager?: { getBranch(): [] };
							shutdown?(): void;
						} = {},
					) => {
						for (const handler of eventHandlers.get(name) ?? [])
							handler(event, ctx);
					};
					emit("before_agent_start", { prompt: "task" });
					emit("agent_start", {});
					emit("agent_end", { messages: stopped });
					emit(
						"agent_settled",
						{ aborted: false },
						{
							...idleCtx,
							sessionManager: { getBranch: () => [] },
							shutdown() {},
						},
					);
					t.mock.timers.tick(DONE_NUDGE_DELAY_MS);
					emit("session_shutdown", { reason: "quit" });
					return sentUserMessages;
				};
				assert.deepEqual(run(false), [DONE_NUDGE_MESSAGE]);
				assert.deepEqual(run(false, true), []);
				assert.deepEqual(run(true), []);
			} finally {
				for (const [name, value] of inherited) restoreEnvVar(name, value);
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("waits for settlement after a transient compaction error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const agentEnd = eventHandlers.get("agent_end")?.[0];
				const agentSettled = eventHandlers.get("agent_settled")?.[0];
				assert.ok(agentEnd);
				assert.ok(agentSettled);

				let shutdowns = 0;
				let branch: any[] = [];
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: { getBranch: () => branch },
				};
				const transientError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				agentEnd({ messages: [transientError] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				const completed = {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "Completed after compaction." }],
				};
				branch = [
					{ type: "message", message: transientError },
					{ type: "compaction", summary: "Compacted" },
					{ type: "message", message: completed },
				];
				agentEnd({ messages: [completed] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);

				agentSettled({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "done",
					},
				);
				assert.equal(shutdowns, 1);
				agentSettled({}, ctx);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("uses the settled branch instead of a stale agent_end error", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const cachedError = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [
							{ type: "message", message: cachedError },
							{
								type: "message",
								message: { role: "assistant", stopReason: "stop" },
							},
						],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [cachedError] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{ type: "done" },
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("reports a provider error that remains after settlement", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const error = {
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider failed",
				};
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => {
							throw new Error("session branch unavailable");
						},
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [error] }, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "error",
						errorMessage: "provider failed",
						stopReason: "error",
					},
				);
				assert.equal(shutdowns, 1);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("stays open when the settled assistant turn was aborted", () => {
		withTempDir((dir) => {
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const previousSession = process.env.PI_SUBAGENT_SESSION;
			const sessionFile = join(dir, "child.jsonl");
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			try {
				const { api, eventHandlers } = createMockExtensionApi();
				subagentDoneExtension(api);
				const aborted = { role: "assistant", stopReason: "aborted" };
				let shutdowns = 0;
				const ctx = {
					shutdown: () => shutdowns++,
					sessionManager: {
						getBranch: () => [{ type: "message", message: aborted }],
					},
				};

				eventHandlers.get("agent_end")?.[0]({ messages: [aborted] }, ctx);
				eventHandlers.get("agent_settled")?.[0]({}, ctx);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.equal(shutdowns, 0);
			} finally {
				restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
				restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			}
		});
	});

	it("preserves caller_ping completion when the agent later settles", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousName = process.env.PI_SUBAGENT_NAME;
		const sessionFile = join(dir, "child.jsonl");
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_NAME = "test-child";
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};
			const callerPing = registeredTools.find(
				(tool) => tool.name === "caller_ping",
			);
			assert.ok(callerPing);

			await callerPing.execute(
				"call",
				{ message: "Need input" },
				null,
				null,
				ctx,
			);
			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "ping",
					name: "test-child",
					message: "Need input",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_NAME", previousName);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stays open when Escape aborts a tool and Pi records the abort as an error", () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const sessionFile = join(dir, "child.jsonl");
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const { api, eventHandlers } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const messages: any[] = [
				{
					role: "toolResult",
					content: [{ type: "text", text: "Command aborted" }],
				},
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				},
			];
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () =>
						messages.map((message) => ({ type: "message", message })),
				},
			};

			eventHandlers.get("agent_end")?.[0]({ messages: [...messages] }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: true }, ctx);
			assert.equal(existsSync(`${sessionFile}.exit`), false);
			assert.equal(shutdowns, 0);

			messages.push({ role: "assistant", stopReason: "stop" });
			eventHandlers.get("agent_end")?.[0]({ messages: [...messages] }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: false }, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{ type: "done" },
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not settle a persistent task when Pi reports an aborted run", () => {
		const dir = createTestDir();
		const previousPersistent = process.env.PI_SUBAGENT_PERSISTENT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const previousTask = process.env.PI_SUBAGENT_TASK_ID;
		const previousGeneration = process.env.PI_SUBAGENT_GENERATION_ID;
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const sessionFile = join(dir, "persistent-aborted.jsonl");
		process.env.PI_SUBAGENT_PERSISTENT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		process.env.PI_SUBAGENT_TASK_ID = "task-1";
		process.env.PI_SUBAGENT_GENERATION_ID = "generation";
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		let shutdown: Function | undefined;
		try {
			const { api, eventHandlers } = createMockExtensionApi();
			subagentDoneExtension(api);
			shutdown = eventHandlers.get("session_shutdown")?.[0];
			const messages: any[] = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				},
			];
			const ctx = {
				sessionManager: {
					getBranch: () =>
						messages.map((message) => ({ type: "message", message })),
				},
			};

			eventHandlers.get("agent_end")?.[0]({ messages: [...messages] }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: true }, ctx);
			assert.deepEqual(readPersistentTaskEvents(sessionFile), []);

			messages.push({ role: "assistant", stopReason: "stop" });
			eventHandlers.get("agent_end")?.[0]({ messages: [...messages] }, ctx);
			eventHandlers.get("agent_settled")?.[0]({ aborted: false }, ctx);
			assert.deepEqual(
				readPersistentTaskEvents(sessionFile).map((event) => event.task),
				["task-1"],
			);
		} finally {
			shutdown?.({ reason: "reload" });
			restoreEnvVar("PI_SUBAGENT_PERSISTENT", previousPersistent);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			restoreEnvVar("PI_SUBAGENT_TASK_ID", previousTask);
			restoreEnvVar("PI_SUBAGENT_GENERATION_ID", previousGeneration);
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("persistent caller_ping", () => {
		const envKeys = [
			"PI_SUBAGENT_PERSISTENT",
			"PI_SUBAGENT_SESSION",
			"PI_SUBAGENT_TASK_ID",
			"PI_SUBAGENT_GENERATION_ID",
			"PI_SUBAGENT_AUTO_EXIT",
		];
		const withHelpingSpecialist = async (
			run: (child: {
				sessionFile: string;
				mock: ReturnType<typeof createMockExtensionApi>;
				ping: () => Promise<void>;
			}) => Promise<void>,
		) => {
			const dir = createTestDir();
			const previous = Object.fromEntries(
				envKeys.map((key) => [key, process.env[key]]),
			);
			const sessionFile = join(dir, "persistent-help.jsonl");
			process.env.PI_SUBAGENT_PERSISTENT = "1";
			process.env.PI_SUBAGENT_SESSION = sessionFile;
			process.env.PI_SUBAGENT_TASK_ID = "task-1";
			process.env.PI_SUBAGENT_GENERATION_ID = "generation";
			delete process.env.PI_SUBAGENT_AUTO_EXIT;
			let shutdown: Function | undefined;
			try {
				const mock = createMockExtensionApi();
				subagentDoneExtension(mock.api);
				shutdown = mock.eventHandlers.get("session_shutdown")?.[0];
				const pingTool = mock.registeredTools.find(
					(tool) => tool.name === "caller_ping",
				);
				assert.ok(pingTool);
				await run({
					sessionFile,
					mock,
					ping: async () => {
						await pingTool.execute(
							"call",
							{ message: "which schema?" },
							undefined,
							undefined,
							{},
						);
					},
				});
			} finally {
				shutdown?.({ reason: "reload" });
				for (const key of envKeys) restoreEnvVar(key, previous[key]);
				rmSync(dir, { recursive: true, force: true });
			}
		};

		it("ends the task, so the run's settlement reports no second result", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock, ping }) => {
				await ping();
				const messages = [{ role: "assistant", stopReason: "stop" }];
				const ctx = {
					sessionManager: {
						getBranch: () =>
							messages.map((message) => ({ type: "message", message })),
					},
				};
				mock.eventHandlers.get("agent_end")?.[0]({ messages }, ctx);
				mock.eventHandlers.get("agent_settled")?.[0]({ aborted: false }, ctx);
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => [
						event.type,
						event.task,
					]),
					[["help-request", "task-1"]],
				);
			});
		});

		it("takes the answer from the inbox before the run settles", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock, ping }) => {
				await ping();
				writePersistentTaskInbox(sessionFile, 1, {
					task: "answer-task",
					message: "use schema v2",
				});
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				assert.deepEqual(mock.sentUserMessages, ["use schema v2"]);
			});
		});

		it("queues the answer behind the run that is still streaming", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock, ping }) => {
				const queued: Array<{ message: string; deliverAs: string }> = [];
				const rejected: string[] = [];
				// Like Pi, a streaming session rejects a user message without deliverAs.
				mock.api.sendUserMessage = async (
					message: string,
					options?: { deliverAs?: string },
				) => {
					if (options?.deliverAs)
						queued.push({ message, deliverAs: options.deliverAs });
					else rejected.push(message);
				};
				await ping();
				writePersistentTaskInbox(sessionFile, 1, {
					task: "answer-task",
					message: "use schema v2",
				});
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				assert.deepEqual(rejected, []);
				assert.deepEqual(queued, [
					{ message: "use schema v2", deliverAs: "followUp" },
				]);
			});
		});

		const callSubagentDone = async (
			mock: ReturnType<typeof createMockExtensionApi>,
		) => {
			const doneTool = mock.registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(doneTool);
			let shutdowns = 0;
			await doneTool.execute("call", {}, undefined, undefined, {
				shutdown: () => shutdowns++,
			});
			return shutdowns;
		};

		it("stays alive for the answer when subagent_done follows caller_ping", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock, ping }) => {
				await ping();
				assert.equal(await callSubagentDone(mock), 0);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => [
						event.type,
						event.task,
					]),
					[["help-request", "task-1"]],
				);
			});
		});

		it("stays alive when subagent_done is called with no current task", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock }) => {
				assert.equal(await callSubagentDone(mock), 0);
				assert.equal(await callSubagentDone(mock), 0);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
				assert.deepEqual(
					readPersistentTaskEvents(sessionFile).map((event) => [
						event.type,
						event.task,
					]),
					[["task-done", "task-1"]],
				);
			});
		});

		const startSession = (
			mock: ReturnType<typeof createMockExtensionApi>,
			idle: boolean,
		) => {
			const calls: string[] = [];
			mock.eventHandlers.get("session_start")?.[0](
				{ reason: "startup" },
				{
					ui: { setWidget() {} },
					isIdle: () => idle,
					abort: () => calls.push("abort"),
					shutdown: () => calls.push("shutdown"),
				},
			);
			return calls;
		};

		it("aborts the leftover run when a stop arrives while it streams", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock, ping }) => {
				const calls = startSession(mock, false);
				await ping();
				writePersistentTaskInbox(sessionFile, 1, {
					type: "stop",
					task: "stop",
					message: "",
				});
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				assert.deepEqual(calls, ["abort", "shutdown"]);
			});
		});

		it("stops an idle specialist without aborting", async () => {
			await withHelpingSpecialist(async ({ sessionFile, mock }) => {
				const calls = startSession(mock, true);
				const doneTool = mock.registeredTools.find(
					(tool) => tool.name === "subagent_done",
				);
				assert.ok(doneTool);
				await doneTool.execute("call", {}, undefined, undefined, {});
				writePersistentTaskInbox(sessionFile, 1, {
					type: "stop",
					task: "stop",
					message: "",
				});
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				assert.deepEqual(calls, ["shutdown"]);
			});
		});
	});

	it("leaves non-auto-exit coordinators open until subagent_done", async () => {
		const dir = createTestDir();
		const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const previousSession = process.env.PI_SUBAGENT_SESSION;
		const sessionFile = join(dir, "child.jsonl");
		delete process.env.PI_SUBAGENT_AUTO_EXIT;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			const { api, eventHandlers, registeredTools } = createMockExtensionApi();
			subagentDoneExtension(api);
			let shutdowns = 0;
			const ctx = {
				shutdown: () => shutdowns++,
				sessionManager: {
					getBranch: () => [
						{
							type: "message",
							message: { role: "assistant", stopReason: "stop" },
						},
					],
				},
			};

			eventHandlers.get("agent_end")?.[0](
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.equal(existsSync(`${sessionFile}.exit`), false);
			assert.equal(shutdowns, 0);

			const subagentDone = registeredTools.find(
				(tool) => tool.name === "subagent_done",
			);
			assert.ok(subagentDone);
			await subagentDone.execute("call", {}, null, null, ctx);
			eventHandlers.get("agent_settled")?.[0]({}, ctx);
			assert.deepEqual(
				JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
				{
					type: "done",
				},
			);
			assert.equal(shutdowns, 1);
		} finally {
			restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
			restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("shouldMarkUserTookOver", () => {
		it("ignores the initial injected task before the first agent run", () => {
			assert.equal(shouldMarkUserTookOver(false), false);
		});

		it("treats later input as manual takeover", () => {
			assert.equal(shouldMarkUserTookOver(true), true);
		});
	});

	describe("shouldAutoExitOnAgentEnd", () => {
		it("auto-exits after normal completion when there was no takeover", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});

		it("auto-exits after normal completion even when the user sent the prompt", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
		});

		it("stays open after Escape aborts the run", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
		});

		it("stays open when Pi reports an aborted run whatever the stop reason", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "This operation was aborted",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages, true), false);
			assert.equal(shouldAutoExitOnAgentEnd(false, messages, false), true);
		});

		it("still exits when the latest turn ended with stopReason=error", () => {
			// Auto-exit subagents must shut down on retry-exhaustion errors so the
			// parent is woken. The error sidecar (written separately) carries the
			// failure detail; staying open would just strand the worker.
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "529 overloaded",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
		});
	});

	describe("findLatestAssistantError", () => {
		it("returns the error info from a stopReason=error message", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "ok" }],
				},
				{ role: "toolResult", content: [] },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded",
				},
			];
			assert.deepEqual(findLatestAssistantError(messages), {
				errorMessage: "Anthropic 529 Overloaded",
				stopReason: "error",
			});
		});

		it("returns null when the latest assistant turn completed normally", () => {
			const messages = [
				{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
				{ role: "user", content: [] },
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "done" }],
				},
			];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("returns null when the latest assistant turn was aborted by the user", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(findLatestAssistantError(messages), null);
		});

		it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
			const messages = [{ role: "assistant", stopReason: "error" }];
			const info = findLatestAssistantError(messages);
			assert.ok(info);
			assert.equal(info!.stopReason, "error");
			assert.match(info!.errorMessage, /stopReason=error/);
		});

		it("returns null when messages is undefined or empty", () => {
			assert.equal(findLatestAssistantError(undefined), null);
			assert.equal(findLatestAssistantError([]), null);
		});
	});

	describe("buildCompletionSidecar", () => {
		it("emits done immediately for a normal auto-exit completion", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "done" }],
					},
				]),
				{ type: "done" },
			);
		});

		it("preserves provider errors in the immediate completion sidecar", () => {
			assert.deepEqual(
				buildCompletionSidecar([
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "provider failed",
					},
				]),
				{
					type: "error",
					errorMessage: "provider failed",
					stopReason: "error",
				},
			);
		});
	});
});

describe("completion.ts", () => {
	it("decodes ping payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "ping",
				name: "Worker",
				message: "need help",
			}),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: "Worker", message: "need help" },
			},
		);
	});

	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads and propagates the message with a non-zero exit code", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				errorSource: "child",
			},
		);
	});

	it("falls back to a placeholder when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("rejects unknown completion sidecar payloads", () => {
		for (const payload of [{}, null]) {
			const result = interpretExitSidecar(payload);
			assert.equal(result.reason, "error");
			assert.equal(result.exitCode, 1);
			assert.match(
				result.errorMessage ?? "",
				/Invalid subagent completion sidecar/,
			);
		}
	});

	it("consumes a sidecar and removes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
		const sessionFile = join(dir, "session.jsonl");
		const exitFile = `${sessionFile}.exit`;
		writeFileSync(
			exitFile,
			JSON.stringify({ type: "ping", name: "Scout", message: "ready" }),
		);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
			});
			assert.deepEqual(result, {
				reason: "ping",
				exitCode: 0,
				ping: { name: "Scout", message: "ready" },
			});
			assert.equal(existsSync(exitFile), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("admits the shell's post-exit record unless the process is known alive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-shell-exit-"));
		const sessionFile = join(dir, "child.jsonl");
		const shellExitFile = shellExitFileFor(sessionFile);
		try {
			writeFileSync(shellExitFile, "3\n");
			const options = {
				intervalMs: 1,
				sessionFile,
				shellExitFile,
				requireProcessExit: true,
				paneDisappearanceGraceMs: 0,
				readTerminalTail: async () => "",
			};
			const controller = new AbortController();
			let checks = 0;
			await assert.rejects(
				waitForCompletion(controller.signal, {
					...options,
					inspectProcess: () => {
						if (++checks === 3) controller.abort();
						return "alive";
					},
				}),
				/Aborted/,
			);
			assert.equal(existsSync(shellExitFile), true);
			const result = await waitForCompletion(new AbortController().signal, {
				...options,
				inspectProcess: () => "unknown",
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 3 });
			assert.equal(existsSync(shellExitFile), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the terminal sentinel exit code", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
	});

	it("prefers an error sidecar published during the terminal read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => {
					await Promise.resolve();
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({
							type: "error",
							errorMessage: "account/model rejected",
							stopReason: "error",
						}),
					);
					return "output\n__SUBAGENT_DONE_1__\n";
				},
			});
			assert.deepEqual(result, {
				reason: "error",
				exitCode: 1,
				errorMessage: "account/model rejected",
				errorSource: "child",
			});
			assert.equal(existsSync(`${sessionFile}.exit`), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers semantic sidecars published during a zero-exit terminal read", async () => {
		for (const [payload, expected] of [
			[
				{ type: "ping", name: "Scout", message: "need input" },
				{
					reason: "ping",
					exitCode: 0,
					ping: { name: "Scout", message: "need input" },
				},
			],
			[
				{ type: "error", errorMessage: "late semantic failure" },
				{
					reason: "error",
					exitCode: 1,
					errorMessage: "late semantic failure",
					errorSource: "child",
				},
			],
		] as const) {
			const dir = mkdtempSync(join(tmpdir(), "completion-zero-race-"));
			const sessionFile = join(dir, "child.jsonl");
			try {
				const result = await waitForCompletion(new AbortController().signal, {
					intervalMs: 1,
					sessionFile,
					readTerminalTail: async () => {
						writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
						return "__SUBAGENT_DONE_0__";
					},
				});
				assert.deepEqual(result, expected);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("retries transient terminal read failures and reports ticks", async () => {
		let reads = 0;
		let ticks = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane temporarily unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			onTick: () => {
				ticks += 1;
			},
		});
		assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		assert.equal(reads, 2);
		assert.equal(ticks, 1);
	});

	it("returns a failure when the pane explicitly disappears", async () => {
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				throw new Error("pane read failed");
			},
			inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
			paneDisappearanceGraceMs: 0,
		});
		assert.deepEqual(result, {
			reason: "error",
			exitCode: 1,
			errorMessage:
				"Subagent pane disappeared before completion evidence was recorded.",
			errorSource: "host",
		});
	});

	it("lets a sidecar win the pane-disappearance race", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
		const sessionFile = join(dir, "child.jsonl");
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => {
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({ type: "done" }),
					);
					return { kind: "missing", error: "pane_not_found" };
				},
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
		const sessionFile = join(dir, "child.jsonl");
		const timer = setTimeout(() => {
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		}, 30);
		try {
			const result = await waitForCompletion(new AbortController().signal, {
				intervalMs: 1,
				sessionFile,
				readTerminalTail: async () => "",
				inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
				paneDisappearanceGraceMs: 150,
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
		} finally {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("socket unavailable");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 0,
				agentStatus: "working",
			}),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("treats presence-check throws as unknown and keeps polling", async () => {
		let reads = 0;
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				if (reads === 1) throw new Error("pane read failed");
				return "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => {
				throw new Error("herdr list failed");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(reads, 2);
	});

	it("inspects herdr status even when terminal reads succeed", async () => {
		let reads = 0;
		const inspections: string[] = [];
		const result = await waitForCompletion(new AbortController().signal, {
			intervalMs: 1,
			readTerminalTail: async () => {
				reads += 1;
				return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
			},
			inspectPane: async () => ({
				kind: "present",
				observedAt: 2_000,
				agentStatus: "blocked",
			}),
			onPaneInspection: (inspection) =>
				inspections.push(
					inspection.kind === "present"
						? inspection.agentStatus
						: inspection.kind,
				),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(inspections, ["blocked"]);
	});

	it("rejects promptly when aborted", async () => {
		const controller = new AbortController();
		const completion = waitForCompletion(controller.signal, {
			intervalMs: 10_000,
			readTerminalTail: async () => "",
		});
		controller.abort();
		await assert.rejects(
			completion,
			/Aborted while waiting for subagent to finish/,
		);
	});
});

describe("subagent activity snapshots", () => {
	function validActivity(overrides: any = {}) {
		return {
			version: 1,
			runningChildId: "child-1",
			createdAt: 1_000,
			updatedAt: 1_000,
			sequence: 1,
			latestEvent: "session_start",
			phase: "starting",
			agentActive: false,
			turnActive: false,
			providerActive: false,
			toolActive: false,
			...overrides,
		};
	}

	it("Task15 preserves exact file validation order and real read errors", () => {
		withTempDir((dir) => {
			const file = join(dir, "activity.json");
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "missing",
			});
			for (const [value, error] of [
				[42, "activity must be an object"],
				[
					{ version: 2, runningChildId: "other" },
					"unsupported activity version",
				],
				[
					validActivity({ runningChildId: 42 }),
					"runningChildId must be a string",
				],
				[
					validActivity({ latestEvent: "invalid", phase: "invalid" }),
					"unknown latestEvent",
				],
				[
					validActivity({ phase: "invalid", activeScope: "invalid" }),
					"unknown activity phase",
				],
				[
					validActivity({ activeScope: "invalid", createdAt: "invalid" }),
					"unknown activeScope",
				],
				[
					validActivity({ createdAt: "invalid", updatedAt: "invalid" }),
					"createdAt must be finite",
				],
				[
					validActivity({ toolName: "bad\nname" }),
					"toolName must not contain newlines",
				],
			] as const) {
				writeFileSync(file, JSON.stringify(value));
				assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
					ok: false,
					reason: "invalid",
					error,
				});
			}
			writeFileSync(
				file,
				JSON.stringify(
					validActivity({ runningChildId: "other", latestEvent: "invalid" }),
				),
			);
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "wrong-id",
			});
			const nullable = validActivity({
				activeScope: null,
				activeSince: null,
				waitingSince: null,
				turnIndex: null,
				toolName: null,
				toolCallId: null,
				messageEventType: null,
				toolStartedAt: null,
				toolEndedAt: null,
			});
			writeFileSync(file, JSON.stringify(nullable));
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: true,
				activity: nullable,
			});
			writeFileSync(file, "{");
			let parseError = "";
			try {
				JSON.parse("{");
			} catch (error) {
				parseError = error instanceof Error ? error.message : String(error);
			}
			assert.deepEqual(readSubagentActivityFile(file, "child-1"), {
				ok: false,
				reason: "invalid",
				error: parseError,
			});
			let directoryError = "";
			try {
				readFileSync(dir, "utf8");
			} catch (error) {
				directoryError = error instanceof Error ? error.message : String(error);
			}
			assert.ok(directoryError);
			assert.deepEqual(readSubagentActivityFile(dir, "child-1"), {
				ok: false,
				reason: "invalid",
				error: directoryError,
			});
		});
	});

	it("writes and validates activity files by running child id", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-1");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-1",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.toolExecutionStart("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-1");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "active");
			assert.equal(read.activity.activeScope, "tool");
			assert.equal(read.activity.toolName, "bash");

			assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
				ok: false,
				reason: "wrong-id",
			});
		});
	});

	it("records waiting and final done states", () => {
		withTempDir((dir) => {
			let currentNow = 2_000;
			const activityFile = getSubagentActivityFile(dir, "child-2");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-2",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			currentNow = 3_000;
			recorder.agentEndWaiting();
			let read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "waiting");
			assert.equal(read.activity.waitingSince, 3_000);

			currentNow = 4_000;
			recorder.subagentDone();
			read = readSubagentActivityFile(activityFile, "child-2");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "done");
			assert.equal(read.activity.agentActive, false);
		});
	});

	it("rejects malformed activity fields used by classification and rendering", () => {
		withTempDir((dir) => {
			mkdirSync(join(dir, "subagent-activity"), { recursive: true });
			const cases = [
				{ activeSince: "bad" },
				{ waitingSince: "bad" },
				{ activeScope: "database" },
				{ latestEvent: "unknown" },
				{ runningChildId: 42 },
				{ toolActive: "yes" },
				{ toolName: "bad\nname" },
			];

			for (const [index, overrides] of cases.entries()) {
				const activityFile = getSubagentActivityFile(dir, `child-${index}`);
				const activity = validActivity({
					runningChildId: `child-${index}`,
					...overrides,
				});
				writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

				const read = readSubagentActivityFile(activityFile, `child-${index}`);
				if (read.ok) throw new Error("expected an invalid activity read");
				assert.equal(read.reason, "invalid");
			}
		});
	});

	it("does not let tool_result resurrect finished tool activity", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-3");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-3",
				activityFile,
				now: () => currentNow,
			});

			recorder.sessionStart();
			recorder.agentStart();
			recorder.turnStart(1);
			currentNow = 2_000;
			recorder.toolExecutionStart("tool-1", "bash");
			currentNow = 3_000;
			recorder.toolExecutionEnd("tool-1", "bash");
			currentNow = 4_000;
			recorder.toolResult("tool-1", "bash");

			const read = readSubagentActivityFile(activityFile, "child-3");
			assert.ok(read.ok);
			assert.equal(read.activity.toolActive, false);
			assert.equal(read.activity.activeScope, "turn");
		});
	});

	it("lets a persistent recorder leave done only through taskStart", () => {
		withTempDir((dir) => {
			let currentNow = 1_000;
			const activityFile = getSubagentActivityFile(dir, "child-p");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-p",
				activityFile,
				persistent: true,
				now: () => currentNow,
			});
			const phase = () => {
				const read = readSubagentActivityFile(activityFile, "child-p");
				assert.ok(read.ok);
				return read.activity;
			};

			recorder.sessionStart();
			recorder.agentStart();
			recorder.subagentDone();
			recorder.agentEndWaiting();
			recorder.toolExecutionStart("t", "bash");
			assert.equal(phase().phase, "done");
			assert.equal(phase().latestEvent, "subagent_done");

			currentNow = 2_000;
			recorder.taskStart();
			assert.equal(phase().phase, "active");
			assert.equal(phase().activeScope, "agent");
			assert.equal(phase().agentActive, true);

			recorder.toolExecutionStart("t", "bash");
			assert.equal(phase().activeScope, "tool");
			recorder.callerPing();
			assert.equal(phase().phase, "done");
			assert.equal(phase().latestEvent, "caller_ping");

			recorder.sessionShutdown("quit");
			assert.equal(phase().latestEvent, "session_shutdown");
			assert.equal(phase().phase, "done");
		});
	});

	it("ignores taskStart on a non-persistent recorder after done", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-n");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-n",
				activityFile,
				now: () => 1_000,
			});
			recorder.sessionStart();
			recorder.subagentDone();
			recorder.taskStart();
			recorder.agentStart();
			const read = readSubagentActivityFile(activityFile, "child-n");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "done");
		});
	});

	it("does not mark reload shutdown as the final done snapshot", () => {
		withTempDir((dir) => {
			const activityFile = getSubagentActivityFile(dir, "child-4");
			const recorder = createSubagentActivityRecorder({
				runningChildId: "child-4",
				activityFile,
				now: () => 1_000,
			});

			recorder.sessionStart();
			recorder.sessionShutdown("reload");

			const read = readSubagentActivityFile(activityFile, "child-4");
			assert.ok(read.ok);
			assert.equal(read.activity.phase, "starting");
			assert.equal(read.activity.latestEvent, "session_start");
		});
	});

	it("cancels pending throttled writes on reload shutdown", async () => {
		const dir = createTestDir();
		try {
			await new Promise<void>((resolve) => {
				let currentNow = 1_000;
				const activityFile = getSubagentActivityFile(dir, "child-5");
				const recorder = createSubagentActivityRecorder({
					runningChildId: "child-5",
					activityFile,
					now: () => currentNow,
				});

				recorder.sessionStart();
				currentNow = 1_100;
				recorder.messageUpdate("delta");
				recorder.sessionShutdown("reload");

				setTimeout(() => {
					const read = readSubagentActivityFile(activityFile, "child-5");
					assert.ok(read.ok);
					assert.equal(read.activity.phase, "starting");
					assert.equal(read.activity.latestEvent, "session_start");
					resolve();
				}, 650);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("subagent interruption", () => {
	it("captures committed and uncommitted worktree state for the parent", async () => {
		const dir = createTestDir();
		try {
			execFileSync("git", ["init", "-q"], { cwd: dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: dir,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: dir,
			});
			writeFileSync(join(dir, "tracked.txt"), "base\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
			}).trim();

			writeFileSync(join(dir, "committed.txt"), "committed\n");
			execFileSync("git", ["add", "committed.txt"], { cwd: dir });
			execFileSync("git", ["commit", "-qm", "ticket"], { cwd: dir });
			writeFileSync(join(dir, "tracked.txt"), "dirty\n");
			writeFileSync(join(dir, "untracked.txt"), "new\n");

			const handoff = await captureWorktreeHandoff({
				path: dir,
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha,
				manifestFile: join(dir, "manifest.json"),
			});

			assert.equal(handoff.baseSha, baseSha);
			assert.equal(handoff.commitsAhead, 1);
			assert.equal(handoff.clean, false);
			assert.equal(handoff.conflicted, false);
			assert.deepEqual(handoff.changedFiles, [
				"committed.txt",
				"tracked.txt",
				"untracked.txt",
			]);
			assert.deepEqual(handoff.untrackedFiles, ["untracked.txt"]);
			assert.ok(handoff.headSha);
			assert.match(handoff.headSha, /^[0-9a-f]{40}$/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks launch failures as failed while retaining explicit ownership", async () => {
		const dir = mkdtempSync(join(tmpdir(), "worktree-launch-failure-"));
		try {
			const manifestFile = join(
				dir,
				"artifacts",
				"parent",
				"worktree-runs",
				"run-1.json",
			);
			const worktree = {
				path: join(dir, "retained-worktree"),
				workspaceId: "w9",
				paneId: "w9:p1",
				branch: "ticket/123",
				baseRef: "HEAD",
				baseSha: "1111111",
				manifestFile,
			};
			writeWorktreeManifest(manifestFile, {
				state: "provisioning",
				id: "run-1",
			});

			const effects = createWorktreeOperations();
			effects.resolveGitCommit = async () => worktree.baseSha;
			effects.resolveWorktreeProvisionCwd = async (cwd) => cwd;
			await assert.rejects(
				launchPiSubagent(
					{
						kind: "fresh",
						id: "run-1",
						name: "Worker",
						task: "bounded",
						worktree: { branch: worktree.branch },
						parent: {
							cwd: dir,
							sessionFile: join(dir, "parent.jsonl"),
							sessionId: "parent",
							sessionDir: dir,
							agentDir: dir,
						},
						runtimePlan: {
							provider: "test",
							modelId: "one",
							model: "test/one",
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
					},
					{
						worktree: effects,
						createPane: () => {
							throw new Error("unexpected ordinary pane");
						},
						createWorktree: () => worktree,
						waitForShellReady: async () => {},
						runScript: (surface) => {
							throw new AcquisitionUncertainError("pane rejected command", {
								kind: "command-dispatch",
								surfaceId: surface,
							});
						},
						closePane: () => {
							throw new Error("must retain worktree");
						},
					},
				),
				/worktree retained.*pane rejected command/i,
			);

			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.kind, "worktree-run");
			assert.equal(manifest.id, "run-1");
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktree.path);
			assert.equal(manifest.acquisitionUncertain, true);
			assert.match(manifest.error, /pane rejected command/);
			assert.equal(
				manifest.gitError,
				undefined,
				"the transferred owner captures Git only at finalization",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
