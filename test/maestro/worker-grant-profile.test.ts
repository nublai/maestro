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

/** The B2 operations the provider module reaches through the client. */
function providerOperations(): string[] {
	const calls = [...PROVIDER.matchAll(/\.call\(\s*"([a-z_.]+)"/g)].map(
		(m) => m[1]!,
	);
	if (/\.hello\(\)/.test(PROVIDER)) calls.push("hello");
	// The Observer subscribes to events and reconciles pending commands by receipt.
	if (/new Observer\(/.test(PROVIDER))
		calls.push("events.subscribe", "receipts.get");
	if (/\breconcile\(this\.#client/.test(PROVIDER)) calls.push("receipts.get");
	return [...new Set(calls)].sort();
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

	it("the provider never uses first_prompt, follow-up, steering or the untyped child route", () => {
		// Code only: comments may name what the provider deliberately avoids.
		const printer = ts.createPrinter({ removeComments: true });
		const code = printer.printFile(
			ts.createSourceFile("p.ts", PROVIDER, ts.ScriptTarget.Latest, true),
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
		assert.equal([...PROVIDER.matchAll(/if_busy: "reject"/g)].length, 2);
	});

	it("never advertises receipt-backed parent admission before P3-9 proves it", () => {
		assert.equal(WORKER_EXEC_CAPABILITIES.parentAdmission, "best-effort");
		assert.equal(WORKER_EXEC_CAPABILITIES.resume, false);
		assert.equal(WORKER_EXEC_CAPABILITIES.sharedCheckout, false);
		assert.equal(WORKER_EXEC_CAPABILITIES.worktree, true);
	});
});
