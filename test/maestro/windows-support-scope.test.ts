import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectHerdrBinding } from "../../maestro/core/config/herdr-config.ts";
import {
	HERDR_CORE_UNSUPPORTED_ON_WINDOWS,
	MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	assertManagedWorktreesSupported,
	managedWorktreeRefusal,
} from "../../maestro/core/platform-support.ts";

const escaped = (text: string) =>
	new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const coreRefusal = escaped(HERDR_CORE_UNSUPPORTED_ON_WINDOWS);

test("the managed-worktree predicate refuses only win32", () => {
	assert.equal(
		managedWorktreeRefusal("win32"),
		MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	);
	assert.throws(() => assertManagedWorktreesSupported("win32"), {
		message: MANAGED_WORKTREES_UNSUPPORTED_ON_WINDOWS,
	});
	for (const platform of ["linux", "darwin"] as const) {
		assert.equal(managedWorktreeRefusal(platform), undefined);
		assertManagedWorktreesSupported(platform);
	}
});

test("Herdr Core selection fails on win32 with the Windows message; legacy is unchanged", () => {
	const core = { HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/run/core.sock" };
	const pipe = { HC_TERMINAL_ID: "t1", HC_SOCKET: "\\\\.\\pipe\\herdr-core" };
	for (const env of [core, pipe]) {
		// Explicit Core, and auto in a Core terminal: auto never falls back to
		// legacy when Core context is present, so it fails the same way.
		for (const backend of ["core", "auto"] as const)
			assert.throws(() => selectHerdrBinding(backend, env, "win32"), {
				message: HERDR_CORE_UNSUPPORTED_ON_WINDOWS,
			});
	}
	assert.throws(() => selectHerdrBinding("core", {}, "win32"), coreRefusal);
	assert.deepEqual(selectHerdrBinding("legacy", core, "win32"), {
		backend: "legacy",
	});
	assert.deepEqual(
		selectHerdrBinding(
			"auto",
			{ HC_SOCKET: "/socket", HERDR_ENV: "1" },
			"win32",
		),
		{ backend: "legacy" },
	);
	for (const platform of ["linux", "darwin"] as const) {
		assert.deepEqual(selectHerdrBinding("auto", core, platform), {
			backend: "core",
			socket: "/run/core.sock",
			parentTerminal: "t1",
		});
		// The socket check is not widened: a named pipe stays malformed.
		assert.throws(
			() => selectHerdrBinding("core", pipe, platform),
			/Restart Pi in a local Core terminal/,
		);
	}
});
