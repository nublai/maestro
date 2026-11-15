import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createPiScriptShellResolver,
	piHasProjectTrustGating,
	piScriptShellDeps,
	resolveProjectTrusted,
} from "../../maestro/adapters/pi/script-shell.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

const CJK_BASH = "D:\\工具 箱\\王小明's Git\\bin\\bash.exe";

describe("createPiScriptShellResolver", () => {
	const context = { cwd: "C:\\proj", projectTrusted: true };

	it("resolves through Pi's shellPath setting for the launch context", () => {
		const seen: unknown[] = [];
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: (c) => {
				seen.push(c);
				return CJK_BASH;
			},
			resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
			baseDir: () => "/unused",
		});
		assert.equal(resolve(), CJK_BASH);
		assert.deepEqual(seen, [context]);
	});

	it("makes a relative shellPath absolute against the directory Pi resolves it from", () => {
		const base = mkdtempSync(join(tmpdir(), "script-shell-base-"));
		try {
			const resolve = createPiScriptShellResolver(context, {
				readShellPath: () => join("tools", "bash"),
				resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
				baseDir: () => base,
			});
			assert.equal(resolve(), join(base, "tools", "bash"));
			// Pi's own default base is the process cwd.
			assert.equal(piScriptShellDeps.baseDir(), process.cwd());
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("leaves absolute Windows and POSIX paths untouched", () => {
		for (const shell of [GIT_BASH, CJK_BASH, "/usr/bin/bash"]) {
			const resolve = createPiScriptShellResolver(context, {
				readShellPath: () => shell,
				resolveShell: (shellPath) => ({ shell: shellPath ?? "" }),
				baseDir: () => "/elsewhere",
			});
			assert.equal(resolve(), shell);
		}
	});

	it("falls back to Pi's own discovery when shellPath is unset", () => {
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: () => undefined,
			resolveShell: (shellPath) => {
				assert.equal(shellPath, undefined);
				return { shell: GIT_BASH };
			},
			baseDir: () => "/unused",
		});
		assert.equal(resolve(), GIT_BASH);
	});

	it("lets Pi's error through when no bash exists", () => {
		const resolve = createPiScriptShellResolver(context, {
			readShellPath: () => undefined,
			resolveShell: () => {
				throw new Error("No bash shell found.");
			},
			baseDir: () => "/unused",
		});
		assert.throws(resolve, /No bash shell found/);
	});
});

async function withSettingsFixture<T>(
	run: (fixture: {
		project: string;
		globalBash: string;
		projectBash: string;
	}) => T,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "script-shell-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		const globalBash = join(root, "global-bash");
		const projectBash = join(root, "project-bash");
		writeFileSync(globalBash, "");
		writeFileSync(projectBash, "");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ shellPath: globalBash }),
		);
		writeFileSync(
			join(project, ".pi", "settings.json"),
			JSON.stringify({ shellPath: projectBash }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return await run({ project, globalBash, projectBash });
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("Pi shellPath settings and project trust", () => {
	const deps = {
		...piScriptShellDeps,
		resolveShell: (shellPath?: string) => ({
			shell: shellPath ?? "pi-discovery",
		}),
	};

	it("uses the project's shellPath only when the project is trusted", async () => {
		await withSettingsFixture(({ project, globalBash, projectBash }) => {
			assert.equal(
				createPiScriptShellResolver(
					{ cwd: project, projectTrusted: true },
					deps,
				)(),
				projectBash,
			);
			assert.equal(
				createPiScriptShellResolver(
					{ cwd: project, projectTrusted: false },
					deps,
				)(),
				globalBash,
			);
		});
	});

	it("reads the launching session's cwd, not the process cwd", async () => {
		await withSettingsFixture(({ project, globalBash, projectBash }) => {
			const elsewhere = mkdtempSync(join(tmpdir(), "script-shell-else-"));
			try {
				assert.equal(
					createPiScriptShellResolver(
						{ cwd: elsewhere, projectTrusted: true },
						deps,
					)(),
					globalBash,
				);
				assert.equal(
					createPiScriptShellResolver(
						{ cwd: project, projectTrusted: true },
						deps,
					)(),
					projectBash,
				);
			} finally {
				rmSync(elsewhere, { recursive: true, force: true });
			}
		});
	});
});

describe("launch composition on Windows", () => {
	it("treats an unreported trust decision as untrusted wherever Pi gates project settings", () => {
		// pi 0.79.0: the gate exists, `ctx.isProjectTrusted` does not.
		assert.equal(resolveProjectTrusted(undefined, true), false);
		// pi 0.74 to 0.78: no trust concept, project settings always load.
		assert.equal(resolveProjectTrusted(undefined, false), true);
		// A reported decision always wins.
		for (const gating of [true, false]) {
			assert.equal(resolveProjectTrusted(true, gating), true);
			assert.equal(resolveProjectTrusted(false, gating), false);
		}
	});

	it("detects trust gating from the installed Pi SDK", () => {
		assert.equal(piHasProjectTrustGating(), true);
	});
});
