/**
 * P3-10 round B: the accept command's fresh, byte-exact copy of the subject
 * tree, read from a real repository's object database with every object's
 * hash recomputed. Each refusal is typed; nothing of a refused copy is used.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	MATERIALIZE_LIMITS,
	type Materialized,
	type MaterializeRefusalCode,
	type MaterializeRequest,
	MaterializeRefusal,
	materializeGitEnvironment,
	materializeTree,
	objectId,
	objectsGitDir,
	removeScratch,
	treeIdOfDirectory,
} from "../../maestro/adapters/worker/materialize.ts";
import { gitAt, makeRepo, type TestRepo } from "../helpers/git-objects.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "materialize-unit-"));
after(() => removeScratch(SCRATCH));
let serial = 0;

function fresh(name: string): string {
	return join(SCRATCH, `${name}-${++serial}`);
}

function repo(options?: Parameters<typeof makeRepo>[1]): TestRepo {
	return makeRepo(fresh("repo"), options);
}

function request(
	r: TestRepo,
	commit: string,
	change: Partial<MaterializeRequest> = {},
): MaterializeRequest {
	const home = fresh("home");
	mkdirSync(home);
	return {
		gitDir: r.gitDir,
		commit,
		tree: r.treeOf(commit),
		dest: fresh("copy"),
		env: materializeGitEnvironment("/usr/bin:/bin", home),
		...change,
	};
}

async function refused(
	made: MaterializeRequest,
	code: MaterializeRefusalCode,
): Promise<void> {
	await assert.rejects(materializeTree(made), (error: Error) => {
		assert.ok(error instanceof MaterializeRefusal, "a typed refusal");
		assert.equal(error.code, code);
		return true;
	});
}

/** A copy that must succeed: an unexpected refusal fails by AssertionError. */
async function copied(made: MaterializeRequest): Promise<Materialized> {
	let copy: Materialized | undefined;
	await assert.doesNotReject(async () => {
		copy = await materializeTree(made);
	}, "an unexpected refusal");
	assert.ok(copy);
	return copy;
}

/** A tree object written as raw bytes (Git's own tools would refuse it). */
function rawTree(
	r: TestRepo,
	entries: { mode: string; name: string; id: string }[],
): string {
	const content = Buffer.concat(
		entries.flatMap((entry) => [
			Buffer.from(`${entry.mode} ${entry.name}\0`),
			Buffer.from(entry.id, "hex"),
		]),
	);
	return r.gitInput(
		content,
		"hash-object",
		"-t",
		"tree",
		"-w",
		"--literally",
		"--stdin",
	);
}

function blob(r: TestRepo, text: string): string {
	return r.gitInput(text, "hash-object", "-w", "--stdin");
}

function commitOf(r: TestRepo, tree: string): string {
	return r.git("commit-tree", tree, "-m", "crafted");
}

describe("verified copy: a byte-exact copy of the commit's tree", () => {
	it("writes every file with its bytes and mode, nested directories included; the copy's recomputed tree is the commit's", async () => {
		const r = repo();
		writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(r.dir, "run.sh"), 0o755);
		const commit = r.commit({
			note: "base\n",
			"a/b/c.txt": "deep\n",
			"bin.dat": "\u0000\u0001\u00ff",
		});
		const made = request(r, commit);
		const copy = await copied(made);
		assert.equal(copy.tree, r.treeOf(commit));
		assert.equal(copy.commit, commit);
		assert.equal(copy.algorithm, "sha1");
		assert.equal(copy.files, 4);
		assert.equal(copy.directories, 2);
		assert.deepEqual(copy.limits, { ...MATERIALIZE_LIMITS });
		assert.equal(readFileSync(join(made.dest, "a/b/c.txt"), "utf8"), "deep\n");
		assert.equal(statSync(join(made.dest, "run.sh")).mode & 0o777, 0o755);
		assert.equal(statSync(join(made.dest, "note")).mode & 0o777, 0o644);
		assert.equal(existsSync(join(made.dest, ".git")), false, "files only");
		assert.equal(treeIdOfDirectory(made.dest, "sha1"), r.treeOf(commit));
	});

	it("a replace ref does not change the copy: objects are read with replace objects disabled", async () => {
		const r = repo();
		const commit = r.commit({ "feature.txt": "original\n" });
		const original = r.git("rev-parse", `${commit}:feature.txt`);
		r.git("replace", original, blob(r, "replaced\n"));
		assert.equal(
			r.git("cat-file", "blob", original),
			"replaced",
			"Git serves it",
		);
		const made = request(r, commit);
		await copied(made);
		assert.equal(
			readFileSync(join(made.dest, "feature.txt"), "utf8"),
			"original\n",
		);
	});

	it("a SHA-256 repository is verified under SHA-256", async () => {
		const r = repo({ objectFormat: "sha256" });
		const commit = r.commit({ note: "sha256\n" });
		assert.equal(commit.length, 64);
		const made = request(r, commit);
		const copy = await copied(made);
		assert.equal(copy.algorithm, "sha256");
		assert.equal(copy.tree, r.treeOf(commit));
	});

	it("a committed .gitignore and an ignored file in the checkout: the copy holds the commit only", async () => {
		const r = repo();
		const commit = r.commit({ ".gitignore": "hidden.txt\n", note: "x\n" });
		writeFileSync(join(r.dir, "hidden.txt"), "child output\n");
		assert.equal(r.git("status", "--porcelain"), "", "Git calls it clean");
		const made = request(r, commit);
		await copied(made);
		assert.equal(existsSync(join(made.dest, "hidden.txt")), false);
		assert.equal(existsSync(join(made.dest, ".gitignore")), true);
	});

	it("the ident attribute with changed working bytes: the copy holds the committed bytes", async () => {
		const r = repo();
		const commit = r.commit({
			".gitattributes": "feature.txt ident\n",
			"feature.txt": "value=$Id$\n",
		});
		writeFileSync(
			join(r.dir, "feature.txt"),
			`value=$Id: ${"a".repeat(40)} $\n`,
		);
		// Git's ident normalization maps the changed bytes to the committed blob.
		assert.equal(
			r.git("hash-object", "feature.txt"),
			r.git("rev-parse", `${commit}:feature.txt`),
			"Git calls them the committed blob",
		);
		const made = request(r, commit);
		await copied(made);
		assert.equal(
			readFileSync(join(made.dest, "feature.txt"), "utf8"),
			"value=$Id$\n",
		);
	});
});

describe("verified copy: refusals, typed and fail closed", () => {
	it("a loose object corrupted under its old ID is object_corrupt", async () => {
		const r = repo();
		const commit = r.commit({ "feature.txt": "original\n" });
		const id = r.git("rev-parse", `${commit}:feature.txt`);
		r.corrupt(id, "blob", "forged!!!\n");
		assert.equal(r.git("cat-file", "blob", id), "forged!!!", "Git serves it");
		await refused(request(r, commit), "object_corrupt");
	});

	it("a corrupted tree and a corrupted commit are object_corrupt too", async () => {
		const r = repo();
		const commit = r.commit({ note: "x\n" });
		const tree = r.treeOf(commit);
		const made = request(r, commit);
		r.corrupt(tree, "tree", "");
		await refused(made, "object_corrupt");
		const s = repo();
		const other = s.commit({ note: "y\n" });
		const madeOther = request(s, other);
		s.corrupt(other, "commit", `tree ${s.treeOf(other)}\n\nforged\n`);
		await refused(madeOther, "object_corrupt");
	});

	it("a missing blob is object_missing", async () => {
		const r = repo();
		const commit = r.commit({ "feature.txt": "x\n" });
		const id = r.git("rev-parse", `${commit}:feature.txt`);
		rmSync(join(r.gitDir, "objects", id.slice(0, 2), id.slice(2)));
		await refused(request(r, commit), "object_missing");
	});

	it("a gitlink is refused", async () => {
		const r = repo();
		const base = r.commit({ note: "x\n" });
		r.git("update-index", "--add", "--cacheinfo", `160000,${base},sub`);
		r.git("commit", "-qm", "gitlink");
		await refused(request(r, r.git("rev-parse", "HEAD")), "gitlink");
	});

	it("a symbolic link is refused", async () => {
		const r = repo();
		r.commit({ note: "x\n" });
		symlinkSync("/etc", join(r.dir, "link"));
		const commit = r.commit({});
		await refused(request(r, commit), "symlink");
	});

	it("any other mode is unsupported_mode", async () => {
		const r = repo();
		const tree = rawTree(r, [
			{ mode: "100664", name: "old", id: blob(r, "x\n") },
		]);
		const commit = commitOf(r, tree);
		await refused(request(r, commit), "unsupported_mode");
	});

	it("a .git entry (any case) is unsafe_name", async () => {
		const r = repo();
		const tree = rawTree(r, [
			{ mode: "100644", name: ".GIT", id: blob(r, "x\n") },
		]);
		await refused(request(r, commitOf(r, tree)), "unsafe_name");
	});

	it("a tree with an entry twice cannot be written twice", async () => {
		const r = repo();
		const id = blob(r, "x\n");
		const tree = rawTree(r, [
			{ mode: "100644", name: "a", id },
			{ mode: "100644", name: "a", id },
		]);
		await refused(request(r, commitOf(r, tree)), "write_failed");
	});

	it("a tree out of Git's order is written but its recomputed copy is not that tree", async () => {
		const r = repo();
		const id = blob(r, "x\n");
		const tree = rawTree(r, [
			{ mode: "100644", name: "b", id },
			{ mode: "100644", name: "a", id },
		]);
		await refused(request(r, commitOf(r, tree)), "tree_mismatch");
	});

	it("a commit whose tree is not the inspected tree is tree_mismatch", async () => {
		const r = repo();
		const first = r.commit({ note: "1\n" });
		const second = r.commit({ note: "2\n" });
		await refused(
			request(r, second, { tree: r.treeOf(first) }),
			"tree_mismatch",
		);
	});

	it("a blob named as the commit is object_type", async () => {
		const r = repo();
		const commit = r.commit({ note: "x\n" });
		const id = r.git("rev-parse", `${commit}:note`);
		await refused(request(r, commit, { commit: id }), "object_type");
	});

	it("oversize: more bytes than the cap", async () => {
		const r = repo();
		const commit = r.commit({ big: "x".repeat(4096) });
		await refused(
			request(r, commit, { limits: { maxBytes: 1024 } }),
			"too_large",
		);
	});

	it("too many entries, too deep, a path too long", async () => {
		const r = repo();
		const commit = r.commit({ a: "1", b: "2", "c/d/e/f": "3" });
		await refused(
			request(r, commit, { limits: { maxEntries: 2 } }),
			"too_many_entries",
		);
		await refused(request(r, commit, { limits: { maxDepth: 2 } }), "too_deep");
		await refused(
			request(r, commit, { limits: { maxPathBytes: 4 } }),
			"path_too_long",
		);
	});

	it("the time budget", async () => {
		const r = repo();
		const commit = r.commit({ note: "x\n" });
		await refused(request(r, commit, { limits: { timeMs: 0 } }), "time_budget");
	});

	it("a cancel", async () => {
		const r = repo();
		const commit = r.commit({ note: "x\n" });
		const signal = AbortSignal.abort();
		await refused(request(r, commit, { signal }), "cancelled");
	});

	it("no repository, or an unreadable one", async () => {
		const r = repo();
		const commit = r.commit({ note: "x\n" });
		await refused(
			request(r, commit, { gitDir: fresh("nowhere") }),
			"git_failed",
		);
		assert.throws(
			() => objectsGitDir(fresh("nowhere")),
			(error: Error) =>
				error instanceof MaterializeRefusal &&
				error.code === "repository_unavailable",
		);
	});
});

describe("verified copy: the repository of a linked worktree", () => {
	it("is its common directory, read from the gitfile and commondir; the copy reads the worktree's commits from there", async () => {
		const r = repo();
		const base = r.commit({ note: "x\n" });
		const linked = fresh("linked");
		r.git("worktree", "add", "-q", "-b", "side", linked, base);
		assert.equal(objectsGitDir(linked), r.gitDir);
		assert.equal(objectsGitDir(r.dir), r.gitDir);
		writeFileSync(join(linked, "side.txt"), "side\n");
		const side = gitAt(linked);
		side("add", "-A");
		side("commit", "-qm", "side");
		const commit = side("rev-parse", "HEAD");
		const made = request(r, commit, { gitDir: objectsGitDir(linked) });
		await copied(made);
		assert.deepEqual(readdirSync(made.dest).sort(), ["note", "side.txt"]);
	});
});

describe("verified copy: object IDs", () => {
	it("are Git's: `<type> <size>\\0<content>` under the repository's algorithm", () => {
		const r = repo();
		assert.equal(objectId("sha1", "blob", Buffer.from("x\n")), blob(r, "x\n"));
	});
});
