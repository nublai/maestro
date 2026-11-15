import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkTestMigration, tokens } from "../scripts/check-test-migration.ts";
import { gitBlob } from "../scripts/check-copy-fidelity.ts";
import {
	checkChildClosure,
	checkEngineClosure,
} from "../scripts/check-boundaries.ts";

test("test migration accepts only trivia changes, never changed assertions or literal contents", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-test-fidelity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "provenance"));
	const original =
		'import assert from "node:assert/strict";\ntest("case", () => { assert.equal(1, 1); });';
	const blob = gitBlob(Buffer.from(original));
	writeFileSync(join(root, "original.ts"), original);
	writeFileSync(join(root, "migrated.ts"), original);
	writeFileSync(
		join(root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: "fixture",
			files: [{ path: "source.ts", blob }],
		}),
	);
	writeFileSync(
		join(root, "provenance/m2-test-map.json"),
		JSON.stringify({
			copy_sha: "fixture",
			files: [
				{
					source: "source.ts",
					destination: "migrated.ts",
					archive: "original.ts",
					blob,
					whole: true,
					selections: [
						{ start: original.indexOf('test("case"'), end: original.length },
					],
					helpers: [],
				},
			],
		}),
	);
	assert.equal(checkTestMigration(root).files.length, 1);
	writeFileSync(join(root, "migrated.ts"), original.replace("1, 1", "1, 2"));
	assert.throws(() => checkTestMigration(root), /Changed or missing/);
	writeFileSync(
		join(root, "migrated.ts"),
		original.replace("node:assert/strict", "./noop.ts"),
	);
	assert.throws(() => checkTestMigration(root), /Unmapped test import/);
	assert.notEqual(
		tokens("`prefix ${value} a b`"),
		tokens("`prefix ${value} ab`"),
	);
	writeFileSync(join(root, "engine.ts"), 'export * from "./inner.ts";');
	writeFileSync(
		join(root, "inner.ts"),
		'import type { Model } from "@earendil-works/pi-ai";',
	);
	assert.throws(
		() => checkEngineClosure(join(root, "engine.ts")),
		/Pi dependency in engine closure/,
	);
	assert.notEqual(
		tokens('assert.equal("a b", "a b")'),
		tokens('assert.equal("ab", "a b")'),
	);
	assert.equal(
		tokens("assert.equal(1, 1)"),
		tokens("assert . equal ( 1,\n1 )"),
	);
});

test("the child entry closure rejects parent runtime, launch, provider and terminal imports", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-child-closure-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "child"));
	writeFileSync(join(root, "child/entry.ts"), 'export * from "./protocol.ts";');
	writeFileSync(
		join(root, "child/protocol.ts"),
		'import { isString } from "../guards.ts";\nvoid isString;',
	);
	writeFileSync(join(root, "guards.ts"), "export const isString = 1;");
	checkChildClosure(join(root, "child/entry.ts"));
	for (const specifier of [
		"../../../runtime/pi-run-session.ts",
		"../launch.ts",
		"../pi-harness-adapter.ts",
		"../../../../pi-extension/subagents/child-widget.ts",
		"@earendil-works/pi-tui",
	]) {
		writeFileSync(
			join(root, "guards.ts"),
			`import ${JSON.stringify(specifier)};`,
		);
		assert.throws(
			() => checkChildClosure(join(root, "child/entry.ts")),
			/Parent\/provider dependency in child closure/,
		);
	}
});
