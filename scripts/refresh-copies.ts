import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	gitBlob,
	normalizeImports,
	readManifest,
} from "./check-copy-fidelity.ts";
import { anchorEntry, readTestMap, TEST_MAPS } from "./check-test-migration.ts";

/**
 * Mechanically re-copy every manifest entry from the pinned upstream revision.
 * Production/support copies are rewritten from `git show <copy_sha>:<source>`
 * plus the declared import mappings only. Migrated test selections are
 * re-anchored by exact text; a selection whose text changed upstream fails
 * instead of being silently refreshed.
 */
export function refreshCopies(root: string, upstream: string): void {
	const manifestPath = resolve(root, "provenance/copy-manifest.json");
	const manifest = readManifest(manifestPath);
	const show = (path: string): Buffer =>
		execFileSync("git", [
			"-C",
			upstream,
			"show",
			`${manifest.copy_sha}:${path}`,
		]);
	const write = (path: string, bytes: Buffer | string): void => {
		mkdirSync(dirname(resolve(root, path)), { recursive: true });
		writeFileSync(resolve(root, path), bytes);
	};
	const files = execFileSync(
		"git",
		["-C", upstream, "ls-tree", "-r", manifest.copy_sha],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [meta, path] = line.split("\t");
			return { path, blob: meta.split(" ")[2] };
		});
	const archives = new Map<string, Buffer>();
	const maps = TEST_MAPS.filter((name) =>
		existsSync(resolve(root, "provenance", name)),
	).map((name) => {
		const path = resolve(root, "provenance", name);
		const map = readTestMap(path);
		for (const entry of map.files) {
			const before = readFileSync(resolve(root, entry.archive), "utf8");
			const after = show(entry.source);
			const text = after.toString("utf8");
			let cursor = 0;
			for (const range of [...entry.selections, ...entry.helpers]) {
				const slice = before.slice(range.start, range.end);
				const matches: number[] = [];
				for (
					let index = text.indexOf(slice);
					index !== -1;
					index = text.indexOf(slice, index + 1)
				)
					matches.push(index);
				assert(
					matches.length,
					`Migrated test text changed upstream: ${entry.source}:${range.line ?? range.start}`,
				);
				// Prefer the occurrence at or after the previous selection, as originally ordered.
				const start =
					matches.find(
						(index) => index >= cursor && range.line !== undefined,
					) ?? matches[0];
				if (range.line !== undefined) cursor = start + slice.length;
				range.start = start;
				range.end = start + slice.length;
				if (range.line !== undefined)
					range.line = text.slice(0, start).split("\n").length;
			}
			entry.blob = gitBlob(after);
			archives.set(entry.archive, after);
			assert(map.identity_sha, `${name} lacks identity_sha`);
			let baseline: Buffer | undefined;
			try {
				baseline = execFileSync(
					"git",
					["-C", upstream, "show", `${map.identity_sha}:${entry.source}`],
					{ stdio: ["ignore", "pipe", "ignore"] },
				);
			} catch {
				baseline = undefined;
			}
			anchorEntry(root, entry, text, baseline);
		}
		map.copy_sha = manifest.copy_sha;
		return { path, map };
	});
	for (const entry of manifest.entries) {
		if (entry.kind !== "copy") continue;
		const original = show(entry.source);
		entry.blob = gitBlob(original);
		if (entry.archive) archives.set(entry.archive, original);
		write(
			entry.destination,
			/\.[cm]?[jt]sx?$/.test(entry.source)
				? normalizeImports(
						original.toString("utf8"),
						entry.source,
						manifest.mappings,
					)
				: original,
		);
	}
	for (const [path, bytes] of archives) write(path, bytes);
	for (const { path, map } of maps)
		writeFileSync(path, JSON.stringify(map, null, "\t") + "\n");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
	writeFileSync(
		resolve(root, "provenance/upstream-tree.json"),
		JSON.stringify({ copy_sha: manifest.copy_sha, files }, null, "\t") + "\n",
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	assert(process.argv[2], "Usage: refresh-copies.ts <upstream-repository>");
	refreshCopies(
		fileURLToPath(new URL("../", import.meta.url)),
		resolve(process.argv[2]),
	);
	console.log("Refreshed copies, archives and test anchors from the pin.");
}
