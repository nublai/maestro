import "./clean-host-env.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	symlinkSync,
} from "node:fs";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readWorktreeManifest,
	writeWorktreeManifest,
} from "../maestro/runtime/worktree-operations.ts";
import {
	listContainedWorktrees,
	removeContainedWorktree,
	formatWorktreeInventory,
} from "../maestro/core/worktree-cleanup.ts";
import { __worktreeCleanupTest__ } from "../maestro/runtime/worktree-operations.ts";
import { cleanupFixture } from "./worktree-cleanup-fixture.ts";
import { worktreesUnsupportedOnWindows } from "./helpers/windows-scope.ts";

describe("cleanup process visibility policy", () => {
	for (const deniedDetail of ["cwd", "comm", "status", "identity"] as const) {
		for (const withHolder of [false, true]) {
			it(`warns for unreadable ${deniedDetail} and continues scanning (holder: ${withHolder})`, {
				skip: worktreesUnsupportedOnWindows,
			}, async (t) => {
				const dir = fs.realpathSync(
					mkdtempSync(join(tmpdir(), "cleanup-protected-")),
				);
				const f = cleanupFixture();
				for (const pid of ["101", "202"]) {
					mkdirSync(join(dir, pid));
					writeFileSync(join(dir, pid, "comm"), "private-process-name\n");
					writeFileSync(join(dir, pid, "status"), "State:\tS (sleeping)\n");
					symlinkSync(
						pid === "202" && withHolder ? dir : tmpdir(),
						join(dir, pid, "cwd"),
					);
				}
				if (deniedDetail === "status") rmSync(join(dir, "101", "cwd"));
				const denied = join(
					dir,
					"101",
					deniedDetail === "identity" ? "" : deniedDetail,
				);
				// cwd resolution uses the no-open helper (lstat/stat/readlink), not
				// realpathSync, so deny the lstat of the magic cwd symlink.
				const method =
					deniedDetail === "identity" || deniedDetail === "cwd"
						? "lstatSync"
						: "readFileSync";
				const original: (...args: any[]) => any = fs[method];
				const mocked = t.mock.method(fs, method, (...args: any[]) => {
					if (String(args[0]) === denied)
						throw Object.assign(new Error("private error details"), {
							code: "EACCES",
						});
					return original(...args);
				});
				syncBuiltinESMExports();
				try {
					let inspection: ReturnType<
						typeof __worktreeCleanupTest__.processHolders
					>;
					assert.doesNotThrow(() => {
						inspection = __worktreeCleanupTest__.processHolders(
							dir,
							new Set(),
							dir,
							"linux",
						);
					});
					assert.match(
						inspection!.warnings.join(),
						/same-user.*other-user.*protected process could hold the checkout undetected/i,
					);
					assert.doesNotMatch(JSON.stringify(inspection!), /private/);
					assert.match(
						inspection!.warnings.join(),
						/1 process.*101.*unreadable/,
					);
					assert.equal(inspection!.blockers.length, withHolder ? 1 : 0);
					if (withHolder)
						assert.match(inspection!.blockers.join(), /202.*holds/);
					f.operations.holders = async () => inspection!;
					const rows = await listContainedWorktrees(f.input);
					assert.equal(
						rows[0].classification,
						withHolder ? "blocked" : "eligible",
					);
					assert.deepEqual(rows[0].warnings, inspection!.warnings);
					assert.match(formatWorktreeInventory(rows), /Warning:.*unreadable/);
					const result = await removeContainedWorktree(f.input);
					assert.equal(result.status, withHolder ? "blocked" : "removed");
					assert.deepEqual(result.warnings, inspection!.warnings);
					assert.match(result.message, /Warning:.*unreadable/);
					if (withHolder) assert.deepEqual(f.calls, []);
				} finally {
					mocked.mock.restore();
					syncBuiltinESMExports();
					rmSync(dir, { recursive: true });
				}
			});
		}
	}

	it("does not lose a holder when its own command name is unreadable", {
		skip: worktreesUnsupportedOnWindows,
	}, (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-hidden-command-"));
		mkdirSync(join(dir, "101"));
		symlinkSync(dir, join(dir, "101", "cwd"));
		const original: (...args: any[]) => any = fs.readFileSync;
		const mocked = t.mock.method(fs, "readFileSync", (...args: any[]) => {
			if (String(args[0]) === join(dir, "101", "comm"))
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set([101]),
				dir,
				"linux",
			);
			assert.match(result.blockers.join(), /101.*holds/);
			assert.match(result.warnings.join(), /101.*unreadable/);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});

	for (const kind of ["enumeration", "platform"] as const) {
		// Only the platform case calls the uid-based inspection that Windows
		// lacks; the enumeration case stays covered there.
		it(`blocks ${kind} failure rather than warning`, {
			skip: kind === "platform" && worktreesUnsupportedOnWindows,
		}, async () => {
			const f = cleanupFixture();
			f.operations.holders = async () =>
				__worktreeCleanupTest__.processHolders(
					"/unused",
					new Set(),
					"/missing-proc-root",
					kind === "platform" ? "win32" : "linux",
				);
			const result = await removeContainedWorktree(f.input);
			assert.equal(result.status, "blocked");
			assert.match(
				result.message,
				kind === "platform" ? /unsupported/ : /ENOENT/,
			);
			assert.deepEqual(f.calls, []);
		});
	}

	it("keeps disappeared and zombie processes harmless and only exempts observed idle shells", {
		skip: worktreesUnsupportedOnWindows,
	}, () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-idle-shell-"));
		try {
			mkdirSync(join(dir, "101"));
			writeFileSync(join(dir, "101", "comm"), "bash\n");
			symlinkSync(dir, join(dir, "101", "cwd"));
			assert.equal(
				__worktreeCleanupTest__.processHolders(dir, new Set(), dir, "linux")
					.blockers.length,
				1,
			);
			assert.deepEqual(
				__worktreeCleanupTest__.processHolders(
					dir,
					new Set([101]),
					dir,
					"linux",
				).blockers,
				[],
			);
			rmSync(join(dir, "101", "cwd"));
			writeFileSync(join(dir, "101", "status"), "State:\tZ (zombie)\n");
			symlinkSync(join(dir, "absent"), join(dir, "202"));
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				dir,
				"linux",
			);
			assert.deepEqual(result.blockers, []);
			assert.doesNotMatch(result.warnings.join(), /unreadable/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	for (const kind of [
		"removed",
		"preserved",
		"preserve-failed",
		"reinspect-blocked",
		"remove-failed",
		"ambiguous",
	] as const) {
		it(`retains process warnings in ${kind} reporting`, async () => {
			const f = cleanupFixture();
			const warnings = [
				"Incomplete process inspection: protected process could hold the checkout undetected.",
			];
			let pass = 0;
			f.operations.holders = async () => ({
				blockers: [],
				warnings: ++pass === 1 ? warnings : [],
			});
			if (kind.startsWith("preserv") || kind === "reinspect-blocked")
				f.state.dirtyFiles = 1;
			if (kind === "preserve-failed")
				f.operations.preserve = () => {
					throw new Error("commit refused");
				};
			if (kind === "remove-failed")
				f.operations.removeCheckout = () => {
					throw new Error("remove refused");
				};
			if (kind === "reinspect-blocked") {
				const preserve = f.operations.preserve;
				f.operations.preserve = (entry) => {
					const sha = preserve(entry);
					f.state.locked = true;
					return sha;
				};
			}
			if (kind === "ambiguous")
				f.operations.scan = () => ["/managed/repo/task", "/managed/other/task"];
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.equal(
				result.status,
				kind.endsWith("failed")
					? "failed"
					: kind === "ambiguous" || kind === "reinspect-blocked"
						? "blocked"
						: "removed",
			);
			assert.deepEqual(result.warnings, warnings);
			assert.match(result.message, /Warning:.*protected process/);
		});
	}

	it("resolves Darwin cwd records without opening them", {
		skip: worktreesUnsupportedOnWindows,
	}, (t) => {
		// Bun's realpathSync opens the path; open() can block forever on a
		// protected macOS directory, such as another app's sandbox container.
		const dir = mkdtempSync(join(tmpdir(), "cleanup-darwin-open-"));
		const checkout = join(dir, "checkout");
		const protectedDir = join(dir, "protected");
		const link = join(dir, "link");
		mkdirSync(checkout);
		mkdirSync(protectedDir);
		symlinkSync("checkout", link);
		const realpath = fs.realpathSync;
		const opened: string[] = [];
		const refuseProtected = (path: fs.PathLike) => {
			if (String(path).startsWith(protectedDir)) {
				opened.push(String(path));
				throw new Error("would block on open");
			}
		};
		const mocks = [
			t.mock.method(
				childProcess,
				"execFileSync",
				() => `p101
czsh
n${protectedDir}
p202
cnode
n${link}
`,
			),
			t.mock.method(fs, "realpathSync", (path: string) => {
				refuseProtected(path);
				return realpath(path);
			}),
			t.mock.method(fs, "openSync", refuseProtected),
			t.mock.method(fs, "opendirSync", refuseProtected),
		];
		syncBuiltinESMExports();
		try {
			const result = __worktreeCleanupTest__.processHolders(
				checkout,
				new Set(),
				"/proc",
				"darwin",
			);
			assert.deepEqual(opened, []);
			assert.deepEqual(result.blockers, [
				"Live process 202 holds the checkout",
			]);
			assert.doesNotMatch(result.warnings.join(), /unreadable/);
		} finally {
			for (const mock of mocks) mock.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});

	it("resolves symbolic links without opening paths like realpathSync", () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-realpath-"));
		const { realpathWithoutOpening } = __worktreeCleanupTest__;
		try {
			mkdirSync(join(dir, "a", "b"), { recursive: true });
			symlinkSync(join(dir, "a"), join(dir, "absolute"));
			symlinkSync("a/b", join(dir, "relative"));
			symlinkSync("relative", join(dir, "chained"));
			symlinkSync("..", join(dir, "a", "b", "up"));
			symlinkSync("loop-b", join(dir, "loop-a"));
			symlinkSync("loop-a", join(dir, "loop-b"));
			symlinkSync("missing/../a", join(dir, "through-missing"));
			symlinkSync(".", join(dir, "self"));
			for (const path of [
				dir,
				join(dir, "a", "b"),
				join(dir, "absolute", "b"),
				join(dir, "relative"),
				join(dir, "chained"),
				join(dir, "chained", "up", "b"),
				// Unnormalized input: `..` is lexical, as in Node's realpathSync.
				// `relative` -> `a/b`, so a physical parent would be `a`, not `dir`.
				`${dir}/relative/../relative`,
				// Valid repeated traversals are not loops.
				join(dir, ...Array(41).fill("self"), "a"),
			])
				assert.equal(realpathWithoutOpening(path), fs.realpathSync(path));
			for (const [name, code] of [
				["missing", "ENOENT"],
				["through-missing", "ENOENT"],
				["loop-a", "ELOOP"],
			] as const) {
				// Windows Node may lexically collapse `missing/../a` and not throw.
				let hostCode: string | undefined;
				try {
					fs.realpathSync(join(dir, name));
				} catch (error) {
					hostCode =
						error instanceof Error && "code" in error
							? String(error.code)
							: undefined;
				}
				if (hostCode === undefined) {
					assert.equal(
						realpathWithoutOpening(join(dir, name)),
						fs.realpathSync(join(dir, name)),
					);
					continue;
				}
				assert.equal(hostCode, code);
				assert.throws(() => realpathWithoutOpening(join(dir, name)), { code });
			}
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("continues past unreadable Darwin cwd records but blocks a failed global lsof", {
		skip: worktreesUnsupportedOnWindows,
	}, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-darwin-"));
		const mocked = t.mock.method(
			childProcess,
			"execFileSync",
			() => `p101\ncprivate\np202\ncprivate\nn${dir}\n`,
		);
		syncBuiltinESMExports();
		try {
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				"/proc",
				"darwin",
			);
			assert.match(result.warnings.join(), /101.*unreadable/);
			assert.match(result.blockers.join(), /202.*holds/);
			assert.doesNotMatch(JSON.stringify(result), /private/);
			mocked.mock.mockImplementation(() => {
				throw Object.assign(new Error("lsof failed: private command output"), {
					stdout: `p202\ncprivate\nn${dir}\n`,
					status: 1,
				});
			});
			const f = cleanupFixture();
			f.operations.holders = async () =>
				__worktreeCleanupTest__.processHolders(
					dir,
					new Set(),
					"/proc",
					"darwin",
				);
			const refused = await removeContainedWorktree(f.input);
			assert.equal(refused.status, "blocked");
			assert.match(refused.message, /lsof failed/);
			assert.doesNotMatch(refused.message, /private/);
			assert.deepEqual(f.calls, []);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true });
		}
	});
});

describe("cleanup operating-system probes", () => {
	it("detects a real node-MainThread process through /proc, not a runtime allowlist", {
		skip: process.platform !== "linux",
	}, async () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-proc-"));
		const checkout = join(dir, "checkout");
		const procRoot = join(dir, "proc");
		mkdirSync(checkout);
		mkdirSync(procRoot);
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.title="node-MainThread"; console.log("ready"); setInterval(() => {}, 1000)',
			],
			{ cwd: checkout, stdio: ["ignore", "pipe", "pipe"] },
		);
		try {
			await once(child.stdout!, "data");
			symlinkSync(`/proc/${child.pid}`, join(procRoot, String(child.pid)));
			assert.equal(
				readFileSync(`/proc/${child.pid}/comm`, "utf8").trim(),
				"node-MainThread",
			);
			for (const idleShellPids of [new Set<number>(), new Set([child.pid!])]) {
				assert.match(
					__worktreeCleanupTest__
						.processHolders(checkout, idleShellPids, procRoot)
						.blockers.join(),
					new RegExp(`${child.pid} holds the checkout`),
				);
			}
		} finally {
			child.kill();
			await once(child, "exit");
			rmSync(dir, { recursive: true });
		}
	});

	it("blocks non-runtime holders but warns about unverifiable live process cwd", {
		skip: process.platform !== "linux",
	}, () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-proc-"));
		try {
			mkdirSync(join(dir, "123"));
			writeFileSync(join(dir, "123", "comm"), "python3\n");
			writeFileSync(join(dir, "123", "status"), "State:\tS (sleeping)\n");
			symlinkSync(dir, join(dir, "123", "cwd"));
			assert.match(
				__worktreeCleanupTest__
					.processHolders(dir, new Set(), dir)
					.blockers.join(),
				/123.*holds/,
			);
			rmSync(join(dir, "123", "cwd"));
			const result = __worktreeCleanupTest__.processHolders(
				dir,
				new Set(),
				dir,
			);
			assert.deepEqual(result.blockers, []);
			assert.match(result.warnings.join(), /123.*unreadable/);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("explicit worktree cleanup", () => {
	for (const [name, patch, blocker] of [
		["dirty", { dirtyFiles: 1 }, /Dirty/],
		["untracked", { untrackedFiles: 1 }, /untracked/],
		["conflicted", { conflicts: 1 }, /conflicted/],
		["submodules", { submodules: true }, /deinitialize/],
		["locked", { locked: true }, /locked/],
		["detached", { branch: "" }, /Detached/],
		["residue", { registered: false }, /unknown residue/],
	] as const) {
		it(`blocks ${name} without any removal effects`, async () => {
			const f = cleanupFixture();
			Object.assign(f.state, patch);
			const result = await removeContainedWorktree({
				...f.input,
				target: "/managed/repo/task",
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, blocker);
			assert.deepEqual(f.calls, []);
		});
	}

	for (const dirty of [false, true]) {
		it(`blocks detached HEAD with preserve requested (dirty: ${dirty})`, async () => {
			const f = cleanupFixture();
			Object.assign(f.state, {
				branch: "",
				dirtyFiles: dirty ? 1 : 0,
				untrackedFiles: dirty ? 1 : 0,
			});
			const before = { ...f.state };
			const target = "/managed/repo/task";
			const result = await removeContainedWorktree({
				...f.input,
				target,
				preserve: true,
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, /Detached HEAD: no retained branch/);
			assert.equal(result.entry?.path, target);
			assert.deepEqual(f.calls, [], "must neither preserve nor remove");
			assert.equal(f.operations.exists(target), true);
			assert.deepEqual(f.state, before);
		});
	}

	for (const probe of [
		"inspectGit",
		"listWorktrees",
		"holders",
		"resolveSource",
		"realpath",
	] as const) {
		it(`reports unknown when ${probe} fails`, async () => {
			const f = cleanupFixture();
			f.operations[probe] = () => {
				throw new Error("probe unavailable");
			};
			const [row] = await listContainedWorktrees(f.input);
			assert.equal(row.classification, "unknown");
			assert.match(row.blockers.join(), /probe unavailable/);
			assert.equal(
				(
					await removeContainedWorktree({
						...f.input,
						target: row.path,
						preserve: true,
					})
				).status,
				"blocked",
			);
			assert.deepEqual(f.calls, []);
		});
	}

	for (const holder of [
		"Live child holds the worktree",
		"Persistent-specialist lease holds the worktree",
	]) {
		it(`blocks ${holder}`, async () => {
			const f = cleanupFixture();
			f.operations.holders = async () => ({ blockers: [holder], warnings: [] });
			const result = await removeContainedWorktree({
				...f.input,
				preserve: true,
			});
			assert.equal(result.status, "blocked");
			assert.match(result.message, new RegExp(holder));
			assert.deepEqual(f.calls, []);
		});
	}

	for (const source of ["Herdr", "manifest"]) {
		it(`blocks ${source} identity disagreements`, async () => {
			const f = cleanupFixture();
			if (source === "Herdr")
				f.operations.listWorktrees = () => [
					{
						path: "/managed/repo/task",
						branch: "other",
						isLinkedWorktree: true,
					},
				];
			else
				f.operations.readManifests = () => [
					{
						file: "/manifest",
						value: { path: "/managed/repo/task", branch: "other" },
					},
				];
			const result = await removeContainedWorktree(f.input);
			assert.equal(result.status, "blocked");
			assert.match(result.message, /identity disagree/);
			assert.deepEqual(f.calls, []);
		});
	}

	for (const kind of ["herdr", "git", "checkout-present", "prune"] as const) {
		it(`reports ${kind} failure without marking manifests removed`, async () => {
			const f = cleanupFixture();
			const fail = () => {
				throw new Error("refused");
			};
			if (kind === "herdr") {
				f.operations.listWorktrees = () => [
					{
						path: "/managed/repo/task",
						branch: "task",
						isLinkedWorktree: true,
						workspaceId: "w1",
					},
				];
				f.operations.removeWorkspace = fail;
			}
			if (kind === "git") f.operations.removeCheckout = fail;
			if (kind === "checkout-present") f.operations.removeCheckout = () => {};
			if (kind === "prune") f.operations.prune = fail;
			f.operations.readManifests = () => [
				{
					file: "/manifest.json",
					value: { path: "/managed/repo/task", branch: "task" },
				},
			];
			assert.equal((await removeContainedWorktree(f.input)).status, "failed");
			assert.equal(
				f.calls.some((call) => call.startsWith("manifest:")),
				false,
			);
			if (kind !== "prune")
				assert.equal(
					f.calls.some((call) => call.startsWith("prune:")),
					false,
				);
		});
	}

	it("manifest read/merge-write round-trip retains metadata and skips invalid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "cleanup-manifest-"));
		const file = join(dir, "manifest.json");
		try {
			writeWorktreeManifest(file, {
				branch: "task",
				state: "running",
				baseSha: "base",
			});
			writeWorktreeManifest(file, {
				state: "removed",
				workspaceRemovedAt: 123,
			});
			assert.equal(readWorktreeManifest(file)?.state, "removed");
			assert.equal(readWorktreeManifest(file)?.baseSha, "base");
			assert.equal(
				JSON.parse(readFileSync(file, "utf8")).workspaceRemovedAt,
				123,
			);
			writeFileSync(file, "{");
			assert.equal(readWorktreeManifest(file), undefined);
			writeFileSync(file, JSON.stringify({ owner: "foreign" }));
			assert.equal(readWorktreeManifest(file), undefined);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
