import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as accept from "../maestro/core/accept.ts";
import { isSubagentActivityScope } from "../maestro/core/activity.ts";
import { isChildBusy, CHILD_BUSY_CHANNEL } from "../maestro/core/child-busy.ts";
import * as host from "../maestro/core/host-text.ts";
import * as notice from "../maestro/core/specialist-notice.ts";
import * as worktree from "../maestro/core/worktree.ts";
import { hasUndeliveredChildren } from "../maestro/core/undelivered-children.ts";
import { WorktreeProvisioningError } from "../maestro/core/surface-provider.ts";
import * as herdr from "../maestro/core/config/herdr-config.ts";
import { loadGuidelinesConfig } from "../maestro/core/config/guidelines-config.ts";
import {
	loadOutcomeLedgerConfig,
	parseOutcomeLedgerConfig,
} from "../maestro/core/config/outcome-ledger-config.ts";
import {
	loadSpawningConfig,
	parseSpawningConfig,
} from "../maestro/core/config/spawning-config.ts";
import * as approval from "../maestro/core/config/task-model-init.ts";

test("core accept command outcomes retain closed verdicts, bounded evidence and child provenance", () => {
	const spec = accept.normalizeAcceptSpec({ run: "fixture", paths: ["./"] });
	assert.equal(spec.paths[0], ".");
	assert.equal(accept.parseChildAcceptReport(null), undefined);
	assert.equal(
		accept.parseChildAcceptReport({ tries: 0, childVerdict: "passed" }),
		undefined,
	);
	const child = accept.parseChildAcceptReport({
		tries: 2,
		childVerdict: "failed",
		lastExitCode: 3,
		timedOut: true,
	});
	assert.deepEqual(child, {
		tries: 2,
		childVerdict: "failed",
		lastExitCode: 3,
		timedOut: true,
	});
	assert.equal(accept.outputTail("abc", 2), "bc");
	assert.equal(accept.outputTail("a", 2), "a");
	const commands: accept.AcceptCommandResult[] = [
		{ kind: "exit", exitCode: 0, output: "passed" },
		{ kind: "exit", exitCode: 1, output: "failed" },
		{ kind: "aborted", output: "" },
		{ kind: "timeout", output: "timeout" },
		{ kind: "signal", signal: "SIGTERM", output: "signal" },
		{ kind: "cwd-missing", output: "" },
		{ kind: "spawn-error", error: "fixture refusal", output: "" },
	];
	assert.deepEqual(
		commands.map(
			(command) => accept.verdictFromCommand(command, spec, child).verdict,
		),
		["accepted", "rejected", "skipped", "error", "error", "error", "error"],
	);
	assert.equal(
		accept.verdictFromCommand(commands[0], spec, undefined).tries,
		undefined,
	);
	assert.match(
		accept.describeAcceptVerdict(
			accept.verdictFromCommand(commands[0], spec, child),
		),
		/child reported a failure/,
	);
	assert.equal(
		accept.describeAcceptVerdict({ verdict: "accepted" }),
		"accepted",
	);
	assert.equal(
		accept.describeAcceptVerdict({ verdict: "rejected", exitCode: 1 }),
		"rejected (exit 1)",
	);
	assert.equal(accept.describeAcceptVerdict({ verdict: "error" }), "error");
	assert.match(
		accept.describeAcceptVerdict({
			verdict: "rejected",
			childVerdict: "passed",
			exitCode: 1,
		}),
		/child reported a pass/,
	);
	assert.equal(accept.skippedOutcome(spec, "cancelled").reason, "cancelled");
	assert.deepEqual(accept.changedCheckFiles([], ["a"]), []);
	const line = accept.buildOutcomeLedgerLine({
		at: 0,
		runId: "r",
		attempt: 1,
		role: "worker",
		requestedModel: "task:BUILD",
		model: "fixture/model",
		thinking: "high",
		elapsedSec: 1,
		outcome: "completed",
		accept: accept.verdictFromCommand(commands[0], spec, child),
	});
	assert.equal(line.category, "build");
	assert.equal(line.checkTries, 2);
	assert.match(line.checkHash!, /^sha256:/);
});

test("core child-busy, notice budgets and undelivered-child policy are independent of Pi", () => {
	assert.equal(isSubagentActivityScope("turn"), true);
	assert.equal(isSubagentActivityScope(null), false);
	assert.equal(isChildBusy(undefined), false);
	assert.equal(
		isChildBusy({
			emit(channel, probe) {
				assert.equal(channel, CHILD_BUSY_CHANNEL);
				probe.busy = true;
			},
		}),
		true,
	);
	assert.match(
		notice.notifyLaunchRefusal({ persistent: false, notify: true })!,
		/persistent/,
	);
	assert.equal(
		notice.notifyLaunchRefusal({ persistent: true, notify: true }),
		undefined,
	);
	assert.equal(
		notice.admitNotice({ delivered: 50, unreported: 0 }, 0),
		"capped",
	);
	assert.equal(
		notice.admitNotice({ delivered: 0, unreported: 0 }, 0),
		"deliver",
	);
	assert.equal(
		notice.admitNotice({ delivered: 1, unreported: 0, lastAt: 1 }, 2),
		"rate-limited",
	);
	assert.equal(
		notice.admitNotice({ delivered: 1, unreported: 0, lastAt: 1 }, 15_001),
		"deliver",
	);
	assert.match(notice.childNoticeRefusal({ sent: 50 }, 0)!, /cap/);
	assert.equal(notice.childNoticeRefusal({ sent: 0 }, 0), undefined);
	assert.equal(
		notice.childNoticeRefusal({ sent: 0, lastAt: NaN }, 0),
		undefined,
	);
	assert.match(
		notice.childNoticeRefusal({ sent: 1, lastAt: 0 }, 1)!,
		/30 seconds/,
	);
	assert.equal(
		notice.childNoticeRefusal({ sent: 1, lastAt: 0 }, 30_000),
		undefined,
	);
	assert.equal(
		hasUndeliveredChildren({
			runningSubagents: new Map([
				["persistent", { persistent: true }],
				["suppressed", { lifecycle: { delivery: "suppressed" } }],
			]),
		}),
		false,
	);
	assert.equal(
		hasUndeliveredChildren({ runningSubagents: new Map([["ordinary", {}]]) }),
		true,
	);
});

test("core host values are bounded, executable arguments are lossless and display controls are visible", () => {
	assert.equal(host.abbreviateMiddle("abcdef", 3, "-"), "a-f");
	assert.equal(host.abbreviateMiddle("abcdef", 0, "-"), "-");
	assert.equal(host.abbreviateMiddle("😀abc😀", 5, "-"), "😀-😀");
	assert.equal(
		host.encodeHostValue("<subagent_report>\u0085\u202e"),
		"&lt;subagent_report>\\u0085\\u202e",
	);
	assert.equal(host.oneLine("a\nb"), "a\\u000ab");
	const value = "<a>\u2028\u202e";
	assert.equal(JSON.parse(host.jsonArgument(value)), value);
	assert.equal(host.shellArgument("abc"), "abc");
	assert.equal(host.shellArgument("a b"), "'a b'");
	assert.equal(host.shellArgument(""), undefined);
	assert.equal(host.shellArgument("a\nb"), undefined);
	assert.equal(host.shellArgument("<subagent_report>"), undefined);
	assert.deepEqual(host.displayLines("a\r\nb\u0085c\u001b\t"), [
		"a",
		"b",
		"c\\u001b\t",
	]);
});

test("core worktree manifests preserve branding and choose terminal result states", () => {
	const value = worktree.mergeWorktreeManifest(
		{ retained: true },
		{ state: "running" },
		1,
	);
	assert.equal(value.retained, true);
	assert.equal(value.updatedAt, 1);
	assert.equal(worktree.isWorktreeManifest(value), true);
	assert.equal(worktree.isWorktreeManifest({}), false);
	assert.deepEqual(
		[
			worktree.worktreeResultState(0, false),
			worktree.worktreeResultState(1, false),
			worktree.worktreeResultState(0, true),
		],
		["ready_for_review", "failed", "needs_help"],
	);
	const error = new WorktreeProvisioningError("fixture", {
		path: "/fixture",
		branch: "fixture",
	});
	assert.equal(error.name, "WorktreeProvisioningError");
	assert.equal(error.recoveredWorktree.path, "/fixture");
});

test("legacy Herdr DTO parsing and reload-binding validation remain core policy, without a provider", () => {
	for (const raw of [
		null,
		{ herdr: null },
		{ herdr: { unknown: true } },
		{ herdr: { backend: "other" } },
	])
		assert.throws(() => herdr.parseHerdrConfig(raw), /Invalid Herdr config/);
	assert.equal(herdr.parseHerdrConfig({}), "auto");
	assert.equal(herdr.parseHerdrConfig({ herdr: {} }), "auto");
	for (const backend of ["auto", "legacy", "core"] as const)
		assert.equal(herdr.parseHerdrConfig({ herdr: { backend } }), backend);
	assert.deepEqual(herdr.selectHerdrBinding("auto", {}), { backend: "legacy" });
	assert.throws(
		() => herdr.selectHerdrBinding("core", {}, "linux"),
		/requires a native/,
	);
	assert.throws(
		() => herdr.selectHerdrBinding("auto", { HC_TERMINAL_ID: "t1" }, "win32"),
		/Windows/,
	);
	const binding = herdr.selectHerdrBinding(
		"core",
		{ HC_TERMINAL_ID: "t1", HC_SOCKET: "/fixture.sock" },
		"linux",
	);
	assert.deepEqual(binding, {
		backend: "core",
		parentTerminal: "t1",
		socket: "/fixture.sock",
	});
	herdr.assertSameHerdrBinding(binding, binding);
	assert.throws(
		() => herdr.assertSameHerdrBinding(binding, { backend: "legacy" }),
		/restart Pi/,
	);
});

test("core configuration loaders preserve fallback, invalid JSON, missing and non-file errors", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "maestro-config-policy-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const example = join(dir, "example.json"),
		config = join(dir, "config.json");
	for (const load of [loadGuidelinesConfig, loadSpawningConfig])
		assert.throws(() => load(dir, example), /Missing/);
	assert.deepEqual(loadOutcomeLedgerConfig(dir, example), { enabled: true });
	writeFileSync(example, "{}");
	for (const load of [
		loadGuidelinesConfig,
		loadSpawningConfig,
		loadOutcomeLedgerConfig,
		herdr.loadHerdrConfig,
	]) {
		assert.ok(load(dir, example));
		writeFileSync(config, "{");
		assert.throws(() => load(dir, example), /JSON|Cannot load/);
		writeFileSync(
			config,
			'{"spawning":{"extra":true},"outcomeLedger":"x","guidelines":null,"herdr":null}',
		);
		assert.throws(() => load(dir, example), /Invalid|Cannot load/);
		rmSync(config);
	}
	assert.equal(
		parseOutcomeLedgerConfig({ outcomeLedger: false }).enabled,
		false,
	);
	assert.throws(() => parseOutcomeLedgerConfig(null), /root must be an object/);
	assert.equal(
		parseSpawningConfig({ spawning: {} }).maxDepth,
		parseSpawningConfig({}).maxDepth,
	);
	mkdirSync(config);
	for (const load of [
		loadGuidelinesConfig,
		loadSpawningConfig,
		loadOutcomeLedgerConfig,
		herdr.loadHerdrConfig,
	])
		assert.throws(() => load(dir, example), /EISDIR/);
	rmSync(config, { recursive: true });
	rmSync(example);
	mkdirSync(example);
	for (const load of [
		loadGuidelinesConfig,
		loadSpawningConfig,
		loadOutcomeLedgerConfig,
		herdr.loadHerdrConfig,
	])
		assert.throws(() => load(dir, example), /EISDIR/);
});

test("core approval offers refuse malformed and asynchronous owners and preserve receivers on cleanup", async () => {
	let late: approval.OfferCallback | undefined;
	const bad = approval.collectApprovalOffers((offer) => {
		late = offer;
		for (const value of [null, {}, { owner: "owner" }])
			assert.equal(offer(value), "recorded");
	});
	assert.equal(late!({}), "closed");
	assert.equal(approval.selectApprovalRoute(bad).kind, "refused");
	assert.equal(
		approval.selectApprovalRoute({
			offers: [
				{ owner: "b", open() {} },
				{ owner: "a", open() {} },
			],
			problems: [],
		}).kind,
		"refused",
	);
	assert.equal(
		approval.openApprovalOffer({
			owner: "fixture",
			open() {
				throw "refusal";
			},
		}).kind,
		"blocked",
	);
	assert.equal(
		approval.openApprovalOffer({
			owner: "fixture",
			open() {
				return Promise.reject(new Error("fixture"));
			},
		}).kind,
		"blocked",
	);
	for (const value of [
		null,
		{ kind: "blocked", reason: " refusal " },
		{ kind: "blocked" },
	])
		assert.equal(
			approval.openApprovalOffer({ owner: "fixture", open: () => value }).kind,
			"blocked",
		);
	const result = {
		kind: "ready",
		destination: { toolName: "fixture", instructions: " instructions " },
		cancel() {
			assert.equal(this, result);
			throw "cannot close";
		},
	};
	const opened = approval.openApprovalOffer({
		owner: "fixture",
		open: () => result,
	});
	assert.equal(opened.kind, "ready");
	if (opened.kind === "ready") {
		assert.equal(opened.destination.instructions, "instructions");
		assert.match(opened.cancel()!, /cannot close/);
	}
	await Promise.resolve();
});
