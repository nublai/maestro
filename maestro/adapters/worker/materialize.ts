/**
 * A fresh, byte-exact copy of a check's subject tree (P3-10 round B, founder
 * decision 2026-11-19): the V1 accept command never runs in the child's
 * checkout. It runs in a directory this module writes from the repository's
 * object database, after recomputing every object's hash here.
 *
 * - Objects are read with `git cat-file --batch` and nothing else: no
 *   filters, no textconv, no attributes, hooks or replace objects
 *   (`--no-replace-objects`, `GIT_NO_REPLACE_OBJECTS=1`), no lazy fetch, no
 *   system or global configuration, in a synthetic environment.
 * - Each object's ID is recomputed (`<type> <size>\0<content>` under the
 *   repository's hash algorithm, SHA-1 or SHA-256 by the ID's length) before
 *   its content is used. A missing object, a hash or type mismatch, a
 *   malformed object or a commit whose tree is not the inspected tree fails
 *   closed with a typed {@link MaterializeRefusal}.
 * - Files are written exclusively into a new directory with modes 100644 or
 *   100755. Gitlinks (160000) are refused. Symbolic links (120000) are
 *   refused too: a link target is child-controlled and no lexical rule keeps
 *   a link chain inside the copy, so no safe policy writes them. Any other
 *   mode, and a name that is empty, `.`, `..`, `.git` (any case) or contains
 *   `/`, is refused.
 * - Entry, byte, depth and path-length caps and a time budget bound the copy.
 * - Finally the tree ID is recomputed from the bytes and modes on disk and
 *   must be the requested tree: the copy is the subject, nothing more.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

/** The repository's object hash algorithm. */
export type ObjectHashAlgorithm = "sha1" | "sha256";

/** Caps of one materialized copy. */
export interface MaterializeLimits {
	/** Tree entries written (files and directories). */
	maxEntries: number;
	/** Object bytes read: the commit, every tree and every blob. */
	maxBytes: number;
	/** Directory nesting below the copy's root. */
	maxDepth: number;
	/** One path's length in bytes, relative to the copy's root. */
	maxPathBytes: number;
	/** The whole materialization, reading and verifying, in milliseconds. */
	timeMs: number;
}

export const MATERIALIZE_LIMITS: Readonly<MaterializeLimits> = Object.freeze({
	maxEntries: 100_000,
	maxBytes: 1024 * 1024 * 1024,
	maxDepth: 64,
	maxPathBytes: 4096,
	timeMs: 120_000,
});

export type MaterializeRefusalCode =
	| "repository_unavailable"
	| "git_failed"
	| "object_missing"
	| "object_corrupt"
	| "object_type"
	| "object_malformed"
	| "tree_mismatch"
	| "unsupported_mode"
	| "gitlink"
	| "symlink"
	| "unsafe_name"
	| "too_many_entries"
	| "too_large"
	| "too_deep"
	| "path_too_long"
	| "time_budget"
	| "cancelled"
	| "write_failed";

/** Why a subject could not be materialized. Nothing of a refused copy is used. */
export class MaterializeRefusal extends Error {
	readonly code: MaterializeRefusalCode;
	readonly detail: string | undefined;
	constructor(code: MaterializeRefusalCode, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = "MaterializeRefusal";
		this.code = code;
		this.detail = detail;
	}
}

export interface MaterializeRequest {
	/** The Git directory whose object database holds the subject. */
	gitDir: string;
	/** The inspected commit ID and its tree ID. */
	commit: string;
	tree: string;
	/** A new directory (it must not exist): the copy's root. */
	dest: string;
	/** Git's synthetic environment ({@link materializeGitEnvironment}). */
	env: NodeJS.ProcessEnv;
	limits?: Partial<MaterializeLimits>;
	/** Aborting ends the materialization (`cancelled`). */
	signal?: AbortSignal;
	/** The Git binary. Default `git`, found on `env.PATH`. */
	git?: string;
}

/** A verified copy and what it took. */
export interface Materialized {
	commit: string;
	/** Recomputed from the bytes and modes written. */
	tree: string;
	algorithm: ObjectHashAlgorithm;
	files: number;
	directories: number;
	bytes: number;
	limits: MaterializeLimits;
	elapsedMs: number;
}

/** Writes a verified copy of `request.tree` into `request.dest`; refuses with a {@link MaterializeRefusal}. */
export type SubjectMaterializer = (
	request: MaterializeRequest,
) => Promise<Materialized>;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEADER_MAX = 256;
const SLASH = Buffer.from("/");

/**
 * Git's environment for reading objects: nothing of the caller's beyond
 * `PATH`; no system or global configuration, no replace objects, no lazy
 * fetch, no prompt; `HOME` in the check's scratch.
 */
export function materializeGitEnvironment(
	path: string | undefined,
	home: string,
): NodeJS.ProcessEnv {
	return {
		PATH: path ?? "/usr/bin:/bin",
		HOME: home,
		XDG_CONFIG_HOME: home,
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/**
 * The Git directory holding the objects of the repository whose linked
 * worktree is `root` (the parent's root): `root/.git` itself, or the
 * `gitdir:` it names and that directory's `commondir`. Plain file reads, no
 * `git` process. The child's own checkout is never consulted.
 */
export function objectsGitDir(root: string): string {
	const dotGit = join(root, ".git");
	try {
		let admin = dotGit;
		if (!statSync(dotGit).isDirectory()) {
			const named = /^gitdir: (.+?)\s*$/.exec(readFileSync(dotGit, "utf8"));
			if (!named?.[1]) throw new Error("not a gitfile");
			admin = resolve(root, named[1]);
		}
		let common = admin;
		const commondir = join(admin, "commondir");
		if (statSync(commondir, { throwIfNoEntry: false })?.isFile())
			common = resolve(admin, readFileSync(commondir, "utf8").trim());
		if (!statSync(join(common, "objects")).isDirectory())
			throw new Error("no objects directory");
		return common;
	} catch (error) {
		throw new MaterializeRefusal(
			"repository_unavailable",
			error instanceof Error ? error.message : "unreadable",
		);
	}
}

export function algorithmOf(id: string): ObjectHashAlgorithm {
	return id.length === 64 ? "sha256" : "sha1";
}

/** A Git object's ID: the hash of `<type> <size>\0<content>`. */
export function objectId(
	algorithm: ObjectHashAlgorithm,
	type: string,
	content: Buffer,
): string {
	return createHash(algorithm)
		.update(`${type} ${content.length}\0`)
		.update(content)
		.digest("hex");
}

/** `cat-file --batch` output, read by line and by length. */
class BatchReader {
	readonly #chunks: Buffer[] = [];
	#length = 0;
	#ended = false;
	#failure: Error | undefined;
	#wake: (() => void) | undefined;

	constructor(stream: Readable) {
		stream.on("data", (chunk: Buffer) => {
			this.#chunks.push(chunk);
			this.#length += chunk.length;
			this.#notify();
		});
		stream.on("end", () => {
			this.#ended = true;
			this.#notify();
		});
		stream.on("error", (error) => this.fail(error));
	}

	fail(error: Error): void {
		this.#failure ??= error;
		this.#notify();
	}

	#notify(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	async #more(): Promise<void> {
		if (this.#failure) throw this.#failure;
		if (this.#ended)
			throw new MaterializeRefusal("git_failed", "cat-file ended early");
		await new Promise<void>((resolve) => {
			this.#wake = resolve;
		});
		if (this.#failure) throw this.#failure;
	}

	#take(n: number): Buffer {
		const parts: Buffer[] = [];
		let left = n;
		while (left > 0) {
			const chunk = this.#chunks[0];
			if (!chunk) break;
			if (chunk.length <= left) {
				parts.push(chunk);
				this.#chunks.shift();
				left -= chunk.length;
			} else {
				parts.push(chunk.subarray(0, left));
				this.#chunks[0] = chunk.subarray(left);
				left = 0;
			}
		}
		this.#length -= n;
		return parts.length === 1 && parts[0] ? parts[0] : Buffer.concat(parts, n);
	}

	async line(): Promise<string> {
		for (;;) {
			let offset = 0;
			for (const chunk of this.#chunks) {
				const at = chunk.indexOf(10);
				if (at >= 0) {
					const line = this.#take(offset + at + 1);
					return line.toString("latin1", 0, line.length - 1);
				}
				offset += chunk.length;
				if (offset > HEADER_MAX) break;
			}
			if (this.#length > HEADER_MAX)
				throw new MaterializeRefusal("object_malformed", "an overlong header");
			await this.#more();
		}
	}

	async bytes(n: number): Promise<Buffer> {
		while (this.#length < n) await this.#more();
		return this.#take(n);
	}
}

interface TreeEntry {
	mode: string;
	name: Buffer;
	id: string;
}

function treeEntries(
	content: Buffer,
	rawLength: number,
	id: string,
): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let at = 0;
	while (at < content.length) {
		const space = content.indexOf(0x20, at);
		const nul = space < 0 ? -1 : content.indexOf(0, space + 1);
		if (space < 0 || nul < 0 || nul + 1 + rawLength > content.length)
			throw new MaterializeRefusal("object_malformed", `tree ${id}`);
		entries.push({
			mode: content.toString("latin1", at, space),
			name: content.subarray(space + 1, nul),
			id: content.toString("hex", nul + 1, nul + 1 + rawLength),
		});
		at = nul + 1 + rawLength;
	}
	return entries;
}

/** A tree entry's name that cannot be written as one plain path component. */
function unsafeName(name: Buffer): boolean {
	if (name.length === 0 || name.includes(0x2f) || name.includes(0)) return true;
	const text = name.toString("latin1");
	return text === "." || text === ".." || text.toLowerCase() === ".git";
}

function pathText(path: Buffer, root: Buffer): string {
	return path.subarray(root.length + 1).toString("utf8");
}

/**
 * Materializes `request.tree` (the tree of `request.commit`) into
 * `request.dest`, every object verified by its recomputed hash, and checks
 * the copy's own recomputed tree ID. Refuses with a {@link MaterializeRefusal};
 * the caller removes `dest` either way.
 */
export const materializeTree: SubjectMaterializer = async (request) => {
	const started = Date.now();
	const limits: MaterializeLimits = {
		...MATERIALIZE_LIMITS,
		...request.limits,
	};
	const deadline = started + limits.timeMs;
	if (
		!OBJECT_ID.test(request.commit) ||
		request.tree.length !== request.commit.length ||
		!OBJECT_ID.test(request.tree)
	)
		throw new MaterializeRefusal("object_malformed", "not a full object ID");
	const algorithm = algorithmOf(request.commit);
	const rawLength = request.commit.length / 2;
	if (request.signal?.aborted) throw new MaterializeRefusal("cancelled");
	const root = Buffer.from(request.dest);
	try {
		mkdirSync(root, { mode: 0o700 });
	} catch (error) {
		throw new MaterializeRefusal("write_failed", fsCode(error));
	}
	const git = spawn(
		request.git ?? "git",
		[
			"--no-replace-objects",
			`--git-dir=${request.gitDir}`,
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"cat-file",
			"--batch",
		],
		{
			cwd: dirname(request.dest),
			env: request.env,
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	const reader = new BatchReader(git.stdout);
	let failure: MaterializeRefusal | undefined;
	const fail = (refusal: MaterializeRefusal) => {
		failure ??= refusal;
		git.kill("SIGKILL");
		reader.fail(failure);
	};
	git.on("error", (error) =>
		fail(new MaterializeRefusal("git_failed", error.message)),
	);
	git.on("exit", (code, signal) => {
		if (!failure && (code !== 0 || signal))
			reader.fail(
				new MaterializeRefusal(
					"git_failed",
					`cat-file exited (${signal ?? code})`,
				),
			);
	});
	git.stdin.on("error", () => {
		/* the exit or the reader reports it */
	});
	const timer = setTimeout(
		() => fail(new MaterializeRefusal("time_budget", `${limits.timeMs} ms`)),
		Math.max(0, deadline - Date.now()),
	);
	const onAbort = () => fail(new MaterializeRefusal("cancelled"));
	request.signal?.addEventListener("abort", onAbort, { once: true });
	let bytes = 0;
	let files = 0;
	let directories = 0;
	const read = async (id: string, type: "commit" | "tree" | "blob") => {
		if (failure) throw failure;
		git.stdin.write(`${id}\n`);
		const header = await reader.line();
		if (header === `${id} missing`)
			throw new MaterializeRefusal("object_missing", id);
		const parsed = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
		const size = Number(parsed?.[3]);
		if (!parsed || parsed[1] !== id || !Number.isSafeInteger(size))
			throw new MaterializeRefusal("object_malformed", `the reply for ${id}`);
		if (bytes + size > limits.maxBytes)
			throw new MaterializeRefusal(
				"too_large",
				`more than ${limits.maxBytes} bytes`,
			);
		bytes += size;
		const content = await reader.bytes(size);
		const end = await reader.bytes(1);
		if (end[0] !== 10)
			throw new MaterializeRefusal("object_malformed", `the reply for ${id}`);
		// Verified before use: the content hashes to the ID it was asked for.
		if (objectId(algorithm, parsed[2] ?? "", content) !== id)
			throw new MaterializeRefusal("object_corrupt", id);
		if (parsed[2] !== type)
			throw new MaterializeRefusal("object_type", `${id} is not a ${type}`);
		return content;
	};
	try {
		const commit = await read(request.commit, "commit");
		const named = /^tree ([0-9a-f]+)\n/.exec(
			commit.toString("latin1", 0, Math.min(commit.length, 6 + 64 + 1)),
		);
		if (!named || named[1] !== request.tree)
			throw new MaterializeRefusal(
				"tree_mismatch",
				"the commit names another tree",
			);
		const pending: { id: string; path: Buffer; depth: number }[] = [
			{ id: request.tree, path: root, depth: 0 },
		];
		let entries = 0;
		for (let next = pending.pop(); next; next = pending.pop()) {
			const tree = await read(next.id, "tree");
			for (const entry of treeEntries(tree, rawLength, next.id)) {
				if (unsafeName(entry.name))
					throw new MaterializeRefusal("unsafe_name", `in tree ${next.id}`);
				const path = Buffer.concat([next.path, SLASH, entry.name]);
				if (path.length - root.length - 1 > limits.maxPathBytes)
					throw new MaterializeRefusal(
						"path_too_long",
						`more than ${limits.maxPathBytes} bytes`,
					);
				if (++entries > limits.maxEntries)
					throw new MaterializeRefusal(
						"too_many_entries",
						`more than ${limits.maxEntries}`,
					);
				switch (entry.mode) {
					case "40000":
						if (next.depth + 1 > limits.maxDepth)
							throw new MaterializeRefusal(
								"too_deep",
								`more than ${limits.maxDepth} levels`,
							);
						write(() => {
							mkdirSync(path, { mode: 0o755 });
							chmodSync(path, 0o755);
						});
						directories++;
						pending.push({ id: entry.id, path, depth: next.depth + 1 });
						break;
					case "100644":
					case "100755": {
						const blob = await read(entry.id, "blob");
						const mode = entry.mode === "100755" ? 0o755 : 0o644;
						write(() => {
							writeFileSync(path, blob, { flag: "wx", mode });
							chmodSync(path, mode);
						});
						files++;
						break;
					}
					case "120000":
						throw new MaterializeRefusal("symlink", pathText(path, root));
					case "160000":
						throw new MaterializeRefusal("gitlink", pathText(path, root));
					default:
						throw new MaterializeRefusal(
							"unsupported_mode",
							`${entry.mode} at ${pathText(path, root)}`,
						);
				}
				if (Date.now() > deadline)
					throw new MaterializeRefusal("time_budget", `${limits.timeMs} ms`);
			}
		}
		git.stdin.end();
		// The copy is the subject: its own tree, recomputed from disk.
		const tree = treeIdOfDirectory(
			request.dest,
			algorithm,
			deadline,
			limits.timeMs,
		);
		if (tree !== request.tree)
			throw new MaterializeRefusal(
				"tree_mismatch",
				"the copy's recomputed tree differs",
			);
		return {
			commit: request.commit,
			tree,
			algorithm,
			files,
			directories,
			bytes,
			limits,
			elapsedMs: Date.now() - started,
		};
	} catch (error) {
		// A failure the reader saw first (time budget, cancel) is the reason.
		if (failure) throw failure;
		throw error;
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", onAbort);
		if (git.exitCode === null && git.signalCode === null) git.kill("SIGKILL");
	}
};

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no static type; only an errno code is read. */
function fsCode(error: unknown): string {
	return error instanceof Error && "code" in error
		? String(error.code)
		: "unknown";
}

function write(action: () => void): void {
	try {
		action();
	} catch (error) {
		throw new MaterializeRefusal("write_failed", fsCode(error));
	}
}

/**
 * The Git tree ID of a directory as written: regular files with mode 0644 or
 * 0755 and directories only, sorted as Git sorts tree entries.
 */
export function treeIdOfDirectory(
	dir: string,
	algorithm: ObjectHashAlgorithm,
	deadline = Number.POSITIVE_INFINITY,
	timeMs = 0,
): string {
	const hash = (path: Buffer): Buffer => {
		if (Date.now() > deadline)
			throw new MaterializeRefusal("time_budget", `${timeMs} ms`);
		const entries: { key: Buffer; mode: string; name: Buffer; id: Buffer }[] =
			[];
		for (const name of readdirSync(path, { encoding: "buffer" })) {
			const child = Buffer.concat([path, SLASH, name]);
			const stat = lstatSync(child);
			if (stat.isDirectory()) {
				entries.push({
					key: Buffer.concat([name, SLASH]),
					mode: "40000",
					name,
					id: hash(child),
				});
				continue;
			}
			const perm = stat.mode & 0o7777;
			if (!stat.isFile() || (perm !== 0o644 && perm !== 0o755))
				throw new MaterializeRefusal(
					"tree_mismatch",
					"the copy holds an entry Git cannot name",
				);
			const id = objectId(algorithm, "blob", readFileSync(child));
			entries.push({
				key: name,
				mode: perm === 0o755 ? "100755" : "100644",
				name,
				id: Buffer.from(id, "hex"),
			});
		}
		entries.sort((a, b) => Buffer.compare(a.key, b.key));
		const content = Buffer.concat(
			entries.flatMap((entry) => [
				Buffer.from(`${entry.mode} `),
				entry.name,
				Buffer.from([0]),
				entry.id,
			]),
		);
		return Buffer.from(objectId(algorithm, "tree", content), "hex");
	};
	return hash(Buffer.from(dir)).toString("hex");
}

/**
 * Removes a check's scratch, even where the command left directories it made
 * unwritable.
 */
export function removeScratch(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
		return;
	} catch {
		/* made writable below, then removed again */
	}
	const writable = (dir: string) => {
		try {
			chmodSync(dir, 0o700);
			for (const entry of readdirSync(dir, { withFileTypes: true }))
				if (entry.isDirectory()) writable(join(dir, entry.name));
		} catch {
			/* best effort: rmSync reports what remains */
		}
	};
	writable(path);
	rmSync(path, { recursive: true, force: true });
}
