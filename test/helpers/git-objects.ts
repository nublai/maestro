/**
 * Real Git repositories for the verified-copy tests (P3-10 round B), made
 * with a synthetic environment: never the user's configuration.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** Git's environment in these tests: no user, system or global configuration. */
export function gitEnv(home: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		HOME: home,
		LANG: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	};
}

/** Git in an existing checkout (a linked worktree), synthetic environment. */
export function gitAt(dir: string) {
	const env = gitEnv(dir);
	return (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
}

export interface TestRepo {
	dir: string;
	gitDir: string;
	git(...args: string[]): string;
	/** `git` with `input` on stdin; output raw. */
	gitInput(input: Buffer | string, ...args: string[]): string;
	/** Writes `files` (relative path to text) and commits everything; returns the commit. */
	commit(files: Record<string, string>, message?: string): string;
	treeOf(commit: string): string;
	/** Replaces a loose object's content with `forged` under its existing ID. */
	corrupt(id: string, type: string, forged: Buffer | string): void;
}

export function makeRepo(
	dir: string,
	options: { objectFormat?: "sha1" | "sha256" } = {},
): TestRepo {
	mkdirSync(dir, { recursive: true });
	const env = gitEnv(dir);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
	const gitInput = (input: Buffer | string, ...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], {
			encoding: "utf8",
			env,
			input,
		}).trim();
	git(
		"init",
		"-q",
		"-b",
		"main",
		`--object-format=${options.objectFormat ?? "sha1"}`,
	);
	const gitDir = join(dir, ".git");
	return {
		dir,
		gitDir,
		git,
		gitInput,
		commit(files, message = "commit") {
			for (const [path, text] of Object.entries(files)) {
				const file = join(dir, path);
				mkdirSync(join(file, ".."), { recursive: true });
				writeFileSync(file, text);
			}
			git("add", "-A");
			git("commit", "-q", "--allow-empty", "-m", message);
			return git("rev-parse", "HEAD");
		},
		treeOf: (commit) => git("rev-parse", `${commit}^{tree}`),
		corrupt(id, type, forged) {
			const content = Buffer.from(forged);
			const path = join(gitDir, "objects", id.slice(0, 2), id.slice(2));
			chmodSync(path, 0o644);
			writeFileSync(
				path,
				deflateSync(
					Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]),
				),
			);
		},
	};
}
