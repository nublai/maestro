import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commonLineRanges, type LineRange } from "./map-coverage-lines.ts";

/**
 * M6/H2 combined original-population coverage gate (plan §5). Unions raw
 * line hits from two cohorts that ran against the same candidate:
 *
 * - the package cohort (`npm run test:coverage` here: source TS paths);
 * - the retained-host cohort (the upstream unit entries from the H2 checkout,
 *   with the installed tarball). Installed `dist/*.js` hits are mapped back to
 *   package source lines through the shipped source maps; retained host files
 *   keep their own paths.
 *
 * Every original file maps through coverage-manifest's split_line_map (package
 * copies) and, for lines that left the package or never moved, through an
 * indentation-insensitive line diff against the retained host files that own
 * them now. The M1 baseline's own raw V8 files are read with the same
 * algorithm, so floors and results share one method: a file is held to its
 * baseline when every original line maps, and otherwise to the baseline hit
 * rate on the same mapped lines; each population's arithmetic per-file mean
 * must reach both the baseline's and the pinned M1 floor (Node's merged
 * summary; see rawLineHits for why that summary is not reused per file).
 */

interface OriginalFile {
	source: string;
	population: string;
	line: number;
	total_lines: number;
	current_owner: string;
	split_line_map: LineRange[];
}
interface Pair {
	source: number;
	destination: string;
	line: number;
}

const HOST = "host:";
const PACKAGE_PREFIX = "node_modules/@nubl/maestro/";

/**
 * Retained host files that now hold an original file's lines that did not
 * move into the package (H1 split them out, or the file never moved).
 */
const HOST_DESTINATIONS = new Map<string, string[]>([
	[
		"maestro/runtime/herdr-backend.ts",
		["pi-extension/subagents/host-surface.ts"],
	],
	[
		"maestro/runtime/pi-run-session.ts",
		["pi-extension/subagents/host-surface.ts"],
	],
	[
		"maestro/runtime/delegated-marker.ts",
		["pi-extension/subagents/marker-transport.ts"],
	],
	[
		"maestro/adapters/pi/child/subagent-done.ts",
		[
			"maestro/adapters/pi/child/subagent-done.ts",
			"pi-extension/subagents/child.ts",
			"pi-extension/subagents/child-widget.ts",
		],
	],
	[
		"pi-extension/subagents/index.ts",
		["pi-extension/subagents/index.ts", "pi-extension/subagents/widgets.ts"],
	],
	[
		"pi-extension/subagents/control-tools.ts",
		["pi-extension/subagents/tool-renderers.ts"],
	],
	[
		"pi-extension/subagents/launch-tools.ts",
		["pi-extension/subagents/tool-renderers.ts"],
	],
	[
		"pi-extension/subagents/renderers.ts",
		[
			"pi-extension/subagents/renderers.ts",
			"pi-extension/subagents/tool-renderers.ts",
		],
	],
]);

const BASE64 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode one source-map `mappings` string into per-generated-line segments. */
export function decodeMappings(
	mappings: string,
): { source: number; line: number }[][] {
	const result: { source: number; line: number }[][] = [];
	let source = 0;
	let line = 0;
	for (const generated of mappings.split(";")) {
		const segments: { source: number; line: number }[] = [];
		for (const segment of generated.split(",")) {
			if (!segment) continue;
			const values: number[] = [];
			let value = 0;
			let shift = 0;
			for (const char of segment) {
				const digit = BASE64.indexOf(char);
				assert(digit >= 0, `Invalid source-map character ${char}`);
				value += (digit & 31) << shift;
				if (digit & 32) shift += 5;
				else {
					values.push(value & 1 ? -(value >>> 1) : value >>> 1);
					value = 0;
					shift = 0;
				}
			}
			if (values.length >= 4) {
				source += values[1];
				line += values[2];
				segments.push({ source, line: line + 1 });
			}
		}
		result.push(segments);
	}
	return result;
}

function readJson<T>(path: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new Error(`Cannot read ${path}`, { cause });
	}
}

interface V8Range {
	startOffset: number;
	endOffset: number;
	count: number;
}
interface V8Script {
	url: string;
	functions: { ranges: V8Range[] }[];
}

/**
 * Per-line hit counts from raw `NODE_V8_COVERAGE` process files, unioned (max)
 * across processes and reload-query variants, for files under `root` whose
 * relative path `include` accepts. Each line takes the count of the innermost
 * V8 range that fully contains it, as Node's own line report does. Strip-types
 * keeps TypeScript offsets, so source lines are the file's own lines.
 *
 * Node 26.13's merged `--experimental-test-coverage` summary under-reports
 * files loaded by many test processes (a pristine H1 run reports herdr-cli.ts
 * at 27% against the 92% M1 baseline), so this gate merges raw hits itself.
 */
export function rawLineHits(
	v8Dir: string,
	root: string,
	include: (path: string) => boolean,
	sourceRoot = root,
): Map<string, Map<number, number>> {
	const result = new Map<string, Map<number, number>>();
	const offsets = new Map<string, { start: number; end: number }[]>();
	for (const name of readdirSync(v8Dir).filter((file) =>
		file.endsWith(".json"),
	)) {
		const scripts = readJson<{ result: V8Script[] }>(join(v8Dir, name)).result;
		for (const script of scripts) {
			if (!script.url.startsWith("file://")) continue;
			const path = relative(
				root,
				fileURLToPath(script.url.replace(/[?#].*$/, "")),
			);
			if (path.startsWith("..") || !include(path)) continue;
			let lines = offsets.get(path);
			if (!lines) {
				lines = [];
				let start = 0;
				for (const text of readFileSync(join(sourceRoot, path), "utf8")
					.replace(/\n$/, "")
					.split("\n")) {
					lines.push({ start, end: start + text.length });
					start += text.length + 1;
				}
				offsets.set(path, lines);
			}
			const counts: number[] = Array.from({ length: lines.length }, () => 0);
			for (const fn of script.functions)
				for (const range of fn.ranges)
					for (const [index, line] of lines.entries())
						if (range.startOffset <= line.start && range.endOffset >= line.end)
							counts[index] = range.count;
			const merged = result.get(path) ?? new Map<number, number>();
			for (const [index, count] of counts.entries())
				merged.set(index + 1, Math.max(merged.get(index + 1) ?? 0, count));
			result.set(path, merged);
		}
	}
	return result;
}

/**
 * Host cohort hits keyed by destination: installed package JS is mapped to
 * package source paths through its source maps; host files get `host:`.
 */
export function hostHits(
	hostRoot: string,
	raw: Map<string, Map<number, number>>,
): Map<string, Map<number, number>> {
	const result = new Map<string, Map<number, number>>();
	const add = (path: string, line: number, count: number) => {
		const lines = result.get(path) ?? new Map<number, number>();
		lines.set(line, Math.max(lines.get(line) ?? 0, count));
		result.set(path, lines);
	};
	for (const [path, lines] of raw) {
		if (!path.startsWith(PACKAGE_PREFIX)) {
			for (const [line, count] of lines) add(HOST + path, line, count);
			continue;
		}
		const generated = resolve(hostRoot, path);
		const map = readJson<{ sources: string[]; mappings: string }>(
			`${generated}.map`,
		);
		const packageRoot = resolve(hostRoot, PACKAGE_PREFIX);
		const sources = map.sources.map((source) =>
			relative(packageRoot, resolve(dirname(generated), source)),
		);
		const decoded = decodeMappings(map.mappings);
		for (const [line, count] of lines)
			for (const segment of decoded[line - 1] ?? [])
				add(sources[segment.source], segment.line, count);
	}
	return result;
}

/** Indentation-insensitive, as M3/M4's line maps. */
const trimmed = (text: string) =>
	text
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => line.trim());

/**
 * Map original lines that no package copy holds onto a retained host file.
 * A run of matched lines counts only when it is at least three lines long or
 * contains a substantive line, so stray braces never borrow coverage.
 */
function hostPairs(
	original: string[],
	unmapped: number[],
	hostRoot: string,
	destination: string,
): Pair[] {
	const path = resolve(hostRoot, destination);
	if (!existsSync(path)) return [];
	const subsequence = unmapped.map((line) => original[line - 1]);
	const ranges = commonLineRanges(
		subsequence,
		trimmed(readFileSync(path, "utf8")),
		HOST + destination,
	);
	const pairs: Pair[] = [];
	for (const range of ranges) {
		const length = range.source_end - range.source_start + 1;
		const lines = Array.from(
			{ length },
			(_, offset) => subsequence[range.source_start - 1 + offset],
		);
		if (length < 3 && !lines.some((line) => line.length >= 12)) continue;
		for (let offset = 0; offset < length; offset++)
			pairs.push({
				source: unmapped[range.source_start - 1 + offset],
				destination: range.destination,
				line: range.destination_start + offset,
			});
	}
	return pairs;
}

export interface CombinedCoverageInputs {
	/** This repository (coverage manifest, copy manifest). */
	root: string;
	/** Upstream repository holding the coverage baseline revision. */
	upstream: string;
	/** The H2 checkout the host cohort ran in. */
	hostRoot: string;
	/** Raw V8 directories of the M1 baseline, package and host runs. */
	baselineV8: string;
	packageV8: string;
	hostV8: string;
	/** The checkout path the baseline run's script URLs name. */
	baselineUrlRoot: string;
}

const ORIGINAL_ROOTS = /^(?:maestro|pi-extension)\//;

export function combinedCoverage(inputs: CombinedCoverageInputs) {
	const { root, upstream, hostRoot } = inputs;
	const manifest = readJson<{
		base_main_sha: string;
		original_files: OriginalFile[];
		metrics: Record<string, { floor_line_mean: number }>;
	}>(join(root, "provenance/coverage-manifest.json"));
	const copies = readJson<{
		entries: { kind: string; source?: string }[];
	}>(join(root, "provenance/copy-manifest.json"));
	const baselineSource = mkdtempSync(join(tmpdir(), "maestro-baseline-src-"));
	try {
		execFileSync(
			"sh",
			[
				"-c",
				'git -C "$1" archive "$2" | tar -x -C "$3"',
				"archive",
				upstream,
				manifest.base_main_sha,
				baselineSource,
			],
			{ stdio: ["ignore", "ignore", "inherit"] },
		);
		const baseline = rawLineHits(
			inputs.baselineV8,
			inputs.baselineUrlRoot,
			(path) => ORIGINAL_ROOTS.test(path),
			baselineSource,
		);
		const packageHits = rawLineHits(inputs.packageV8, root, (path) =>
			ORIGINAL_ROOTS.test(path),
		);
		const hostRaw = rawLineHits(
			inputs.hostV8,
			hostRoot,
			(path) =>
				ORIGINAL_ROOTS.test(path) || path.startsWith(`${PACKAGE_PREFIX}dist/`),
		);
		const failures: string[] = [];
		// One engine: the host never loads its local copy of a moved module.
		for (const entry of copies.entries)
			if (
				entry.kind === "copy" &&
				entry.source &&
				ORIGINAL_ROOTS.test(entry.source) &&
				hostRaw.has(entry.source)
			)
				failures.push(`host loaded its local moved copy ${entry.source}`);
		const host = hostHits(hostRoot, hostRaw);
		const hits = (destination: string, line: number) =>
			destination.startsWith(HOST)
				? (host.get(destination)?.get(line) ?? 0)
				: Math.max(
						packageHits.get(destination)?.get(line) ?? 0,
						host.get(destination)?.get(line) ?? 0,
					);
		const files = manifest.original_files.map((original) => {
			const before = baseline.get(original.source);
			assert(before?.size === original.total_lines, original.source);
			const baselineLine =
				(100 * [...before.values()].filter((count) => count > 0).length) /
				before.size;
			const pairs: Pair[] = original.split_line_map.flatMap((range) =>
				Array.from(
					{ length: range.source_end - range.source_start + 1 },
					(_, offset) => ({
						source: range.source_start + offset,
						destination: range.destination,
						line: range.destination_start + offset,
					}),
				),
			);
			const text = trimmed(
				readFileSync(join(baselineSource, original.source), "utf8"),
			);
			assert.equal(text.length, original.total_lines, original.source);
			const candidates =
				HOST_DESTINATIONS.get(original.source) ??
				(original.current_owner === "pi-herdr-agents" ? [original.source] : []);
			for (const destination of candidates) {
				const mapped = new Set(pairs.map((pair) => pair.source));
				const unmapped = Array.from(
					{ length: original.total_lines },
					(_, index) => index + 1,
				).filter((line) => !mapped.has(line));
				if (!unmapped.length) break;
				pairs.push(...hostPairs(text, unmapped, hostRoot, destination));
			}
			assert(pairs.length, `No line map: ${original.source}`);
			const destinations = [...new Set(pairs.map((pair) => pair.destination))];
			for (const destination of destinations)
				if (
					!(destination.startsWith(HOST)
						? host.has(destination)
						: packageHits.has(destination) || host.has(destination))
				)
					failures.push(`${original.source}: no coverage for ${destination}`);
			const covered = pairs.filter(
				(pair) => hits(pair.destination, pair.line) > 0,
			).length;
			const line = (100 * covered) / pairs.length;
			const floor =
				pairs.length === original.total_lines
					? baselineLine
					: (100 *
							pairs.filter((pair) => (before.get(pair.source) ?? 0) > 0)
								.length) /
						pairs.length;
			if (line < floor)
				failures.push(`${original.source}: ${line}% < floor ${floor}%`);
			return {
				source: original.source,
				population: original.population,
				line,
				floor,
				baseline_line: baselineLine,
				pinned_node_summary_line: original.line,
				covered,
				total: pairs.length,
				mapped_lines: `${pairs.length}/${original.total_lines}`,
				destinations,
			};
		});
		const populations = [...new Set(files.map((file) => file.population))].map(
			(population) => {
				const cohort = files.filter((file) => file.population === population);
				const mean = (values: number[]) =>
					values.reduce((n, value) => n + value, 0) / values.length;
				const arithmetic = mean(cohort.map((file) => file.line));
				const baselineMean = mean(cohort.map((file) => file.baseline_line));
				if (arithmetic < baselineMean)
					failures.push(
						`${population}: mean ${arithmetic}% < baseline mean ${baselineMean}%`,
					);
				// The pinned M1 floors (Node's merged summary) must hold as well.
				const pinned = manifest.metrics[population]?.floor_line_mean;
				if (pinned !== undefined && arithmetic < pinned)
					failures.push(
						`${population}: mean ${arithmetic}% < pinned floor ${pinned}%`,
					);
				return {
					population,
					files: cohort.length,
					arithmetic_line_mean: arithmetic,
					baseline_line_mean: baselineMean,
					subset_floor_line_mean: mean(cohort.map((file) => file.floor)),
					pinned_node_summary_floor: pinned ?? null,
					weighted_line_percent:
						(100 * cohort.reduce((n, f) => n + f.covered, 0)) /
						cohort.reduce((n, f) => n + f.total, 0),
				};
			},
		);
		return { files, populations, failures };
	} finally {
		rmSync(baselineSource, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [baselineV8, baselineUrlRoot, packageV8, hostV8, hostRoot, upstream] =
		process.argv.slice(2);
	const output = process.argv[8];
	assert(
		baselineV8 &&
			baselineUrlRoot &&
			packageV8 &&
			hostV8 &&
			hostRoot &&
			upstream,
		"Usage: combined-coverage.ts <baseline-v8> <baseline-url-root> <package-v8> <host-v8> <host-checkout> <upstream-repository> [report.json]",
	);
	const report = combinedCoverage({
		root: fileURLToPath(new URL("../", import.meta.url)),
		upstream: resolve(upstream),
		hostRoot: resolve(hostRoot),
		baselineV8: resolve(baselineV8),
		baselineUrlRoot,
		packageV8: resolve(packageV8),
		hostV8: resolve(hostV8),
	});
	if (output) writeFileSync(output, JSON.stringify(report, null, "\t") + "\n");
	console.log(JSON.stringify(report.populations, null, 2));
	assert.deepEqual(report.failures, [], "Combined coverage gate failed");
	console.log(
		`Combined coverage: all ${report.files.length} original files meet their floors; population means reach the baseline.`,
	);
}
