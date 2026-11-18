/**
 * P3-7 grant closure: Maestro's worker method profile is exactly what the
 * provider calls (plus the child's report method as its ceiling), never `*`,
 * never owner reconciliation, steering or follow-up, and the child's launch
 * spec carries its report method only.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import {
	MAESTRO_WORKER_CHILD_METHODS,
	MAESTRO_WORKER_EXCLUDED_METHODS,
	MAESTRO_WORKER_MUTATION_METHODS,
	MAESTRO_WORKER_PARENT_METHODS,
	MAESTRO_WORKER_READ_METHODS,
} from "../../maestro/adapters/worker/grant-profile.ts";
import { WORKER_EXEC_CAPABILITIES } from "../../maestro/adapters/worker/worker-exec-provider.ts";

const PROVIDER = readFileSync(
	new URL(
		"../../maestro/adapters/worker/worker-exec-provider.ts",
		import.meta.url,
	),
	"utf8",
);
/** P3-9's parent admission: the same grant, the same client. */
const ADMISSION = readFileSync(
	new URL("../../maestro/adapters/worker/parent-admission.ts", import.meta.url),
	"utf8",
);

/** The B2 operations a module reaches through the client. */
function operationsOf(source: string): string[] {
	const calls = [...source.matchAll(/\.call\(\s*"([a-z_.]+)"/g)].map(
		(m) => m[1]!,
	);
	if (/\.hello\(\)/.test(source)) calls.push("hello");
	// The Observer subscribes to events and reconciles pending commands by receipt.
	if (/new Observer\(/.test(source))
		calls.push("events.subscribe", "receipts.get");
	if (/\breconcile\(this\.#client/.test(source)) calls.push("receipts.get");
	return [...new Set(calls)].sort();
}

/** The B2 operations the provider and its parent admission reach. */
function providerOperations(): string[] {
	return [
		...new Set([...operationsOf(PROVIDER), ...operationsOf(ADMISSION)]),
	].sort();
}

describe("Maestro worker grant profile", () => {
	it("is exactly the provider's own calls plus children.report, with no wildcard", () => {
		assert.deepEqual(
			providerOperations(),
			MAESTRO_WORKER_PARENT_METHODS.filter(
				(m) => m !== "children.report",
			).sort(),
		);
		assert.deepEqual(
			[...MAESTRO_WORKER_PARENT_METHODS].sort(),
			[
				...MAESTRO_WORKER_READ_METHODS,
				...MAESTRO_WORKER_MUTATION_METHODS,
				"children.report",
			].sort(),
		);
		for (const method of MAESTRO_WORKER_EXCLUDED_METHODS)
			assert.equal(
				MAESTRO_WORKER_PARENT_METHODS.includes(method),
				false,
				method,
			);
		assert.equal(
			new Set(MAESTRO_WORKER_PARENT_METHODS).size,
			MAESTRO_WORKER_PARENT_METHODS.length,
		);
	});

	it("a typed child gets its report method only, a subset of its parent's", () => {
		assert.deepEqual([...MAESTRO_WORKER_CHILD_METHODS], ["children.report"]);
		for (const method of MAESTRO_WORKER_CHILD_METHODS)
			assert.ok(MAESTRO_WORKER_PARENT_METHODS.includes(method));
	});

	for (const [name, source, rejects] of [
		["provider", PROVIDER, 2],
		["parent admission", ADMISSION, 1],
	] as const)
		it(`the ${name} never uses first_prompt, follow-up, steering, owner reconciliation or the untyped child route`, () => {
			// Code only: comments may name what the module deliberately avoids.
			const printer = ts.createPrinter({ removeComments: true });
			const code = printer.printFile(
				ts.createSourceFile("p.ts", source, ts.ScriptTarget.Latest, true),
			);
			assert.doesNotMatch(code, /first_prompt/);
			for (const forbidden of [
				"sessions.follow_up",
				"sessions.steer",
				"children.launch",
				"sessions.resolve_unknown",
				"workers.relaunch",
			])
				assert.equal(code.includes(`"${forbidden}"`), false, forbidden);
			assert.equal([...source.matchAll(/if_busy: "reject"/g)].length, rejects);
			assert.doesNotMatch(code, /if_busy: "(steer|follow_up)"/);
		});

	it("advertises receipt-backed parent admission (P3-9) and only isolated fan-out", () => {
		assert.equal(WORKER_EXEC_CAPABILITIES.parentAdmission, "receipt");
		assert.equal(WORKER_EXEC_CAPABILITIES.resume, false);
		assert.equal(WORKER_EXEC_CAPABILITIES.sharedCheckout, false);
		assert.equal(WORKER_EXEC_CAPABILITIES.worktree, true);
	});
});
