import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as model from "../maestro/core/config/model-config.ts";
import {
	buildTaskModelBrief,
	buildTaskModelInitPrompt,
	DIRECT_WRITER_DESTINATION,
} from "../maestro/core/config/task-model-init.ts";

test("core ranking basis validates research evidence without performing network calls", () => {
	assert.deepEqual(
		model.parseRankingBasis({ kind: "registry-only" }, "registry-only"),
		{ kind: "registry-only" },
	);
	const basis = {
		kind: "research",
		sources: [
			{ url: "https://example.com/reference", influence: "fixture evidence" },
		],
		uncertainty: "fixture uncertainty",
	};
	assert.deepEqual(model.parseRankingBasis(basis, "research"), basis);
	for (const invalid of [
		null,
		{ kind: "other" },
		{ kind: "research", extra: true },
		{ kind: "research", sources: [] },
		{ ...basis, sources: [null] },
		{ ...basis, sources: [{ url: "file:///fixture", influence: "x" }] },
		{ ...basis, sources: [{ url: "https://example.com", influence: "" }] },
		{ ...basis, uncertainty: "" },
	])
		assert.throws(
			() => model.parseRankingBasis(invalid, "research"),
			/Invalid ranking basis/,
		);
	assert.throws(
		() =>
			model.parseRankingBasis(
				{ kind: "registry-only", extra: true },
				"registry-only",
			),
		/no other fields/,
	);
	assert.throws(
		() => model.parseModelConfig({ models: { extra: true } }),
		/unsupported key/,
	);
	const brief = buildTaskModelBrief({
		models: [
			{
				ref: "fixture/model",
				provider: "fixture",
				id: "model",
				auth: { configured: true },
				reasoning: false,
				supportedThinkingLevels: ["off"],
			},
		],
		current: { agents: {} },
		configRevision: "missing",
		preferences: " fixture ",
	});
	assert.equal(brief.operatorPreferences, "fixture");
	const prompt = buildTaskModelInitPrompt(brief, DIRECT_WRITER_DESTINATION);
	assert.match(prompt, /1 models/);
	assert.match(prompt, /Registry brief/);
	assert.match(prompt, /subagents_write_task_models/);
});

test("approved core config writes compare bytes and directory identity, and report publication uncertainty honestly", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "maestro-approved-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const config = join(dir, "nested", "config.json");
	const tasksMeta = {
		generatedAt: "2026-11-15T00:00:00Z",
		method: "registry-only" as const,
	};
	const candidate: model.ModelConfig = {
		agents: {},
		tasks: { coding: ["fixture/model"] },
		tasksThinking: { coding: "low" },
		tasksMeta,
	};
	const approved = model.prepareTaskModelWrite(config, candidate, "missing");
	assert.equal(approved.newFile, true);
	assert.equal(approved.after.tasksThinking?.coding, "low");
	assert.match(model.describeTaskModelWriteFailure(approved), /not replaced/);
	const result = model.writeTaskModelConfig(
		config,
		"unused",
		candidate.tasks!,
		tasksMeta,
		() => true,
		{ approvedWrite: approved, tasksThinking: candidate.tasksThinking },
	);
	assert.equal(result.tasksThinking?.coding, "low");
	assert.match(
		model.describeTaskModelWriteFailure(approved),
		/matches the approved/,
	);
	const next = model.prepareTaskModelWrite(config, candidate);
	assert.equal(next.newFile, false);
	assert.throws(
		() =>
			model.writeTaskModelConfig(
				config,
				"unused",
				{ coding: ["fixture/different"] },
				tasksMeta,
				() => true,
				{ approvedWrite: next, tasksThinking: candidate.tasksThinking },
			),
		/bytes differ/,
	);
	writeFileSync(config, "{}");
	assert.match(
		model.describeTaskModelWriteFailure(approved),
		/changed to revision/,
	);
	rmSync(config);
	mkdirSync(config);
	assert.match(
		model.describeTaskModelWriteFailure(approved),
		/could not be re-read/,
	);
	rmSync(config, { recursive: true });
	const first = join(dir, "first"),
		second = join(dir, "second"),
		alias = join(dir, "alias");
	mkdirSync(first);
	mkdirSync(second);
	symlinkSync(first, alias);
	const aliasFile = join(alias, "config.json");
	const aliasApproval = model.prepareTaskModelWrite(aliasFile, candidate);
	unlinkSync(alias);
	symlinkSync(second, alias);
	assert.throws(
		() =>
			model.writeTaskModelConfig(
				aliasFile,
				"unused",
				candidate.tasks!,
				tasksMeta,
				() => true,
				{ approvedWrite: aliasApproval },
			),
		/directory changed/,
	);
	mkdirSync(join(dir, "malformed"));
	writeFileSync(join(dir, "malformed", "config.json"), "{");
	assert.throws(
		() =>
			model.prepareTaskModelWrite(
				join(dir, "malformed", "config.json"),
				candidate,
			),
		/Invalid JSON/,
	);
	assert.equal(
		readFileSync(join(dir, "malformed", "config.json"), "utf8"),
		"{",
	);
});
