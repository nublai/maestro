import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { checkTestMigration } from "./check-test-migration.ts";

interface Identity {
	type: string;
	kind: string;
	file: string;
	line: number;
	name: string;
	nesting: number;
	testId: number;
	parentId: number;
	skip: boolean | string;
	todo: boolean | string;
	titles?: string[];
}
interface CoverageFile {
	path: string;
	lines: { line: number; count: number }[];
}
interface ReportEvent extends Identity {
	files?: CoverageFile[];
	data?: {
		file?: string;
		success: boolean;
		counts: { tests: number; passed: number; failed: number; skipped: number };
	};
}
interface OriginalFile {
	source: string;
	population: string;
	line: number;
	total_lines: number;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const coverage = process.argv.includes("--coverage");
const migration = checkTestMigration(root);
let manifest: { maestro_unit_entries: string[] };
try {
	manifest = JSON.parse(
		readFileSync(
			new URL("../provenance/test-manifest.json", import.meta.url),
			"utf8",
		),
	);
} catch (cause) {
	throw new Error("Cannot read unit-entry manifest", { cause });
}
mkdirSync(join(root, "evidence"), { recursive: true });
assert(
	manifest.maestro_unit_entries.length ===
		new Set(manifest.maestro_unit_entries).size,
);
const evidence = mkdtempSync(join(root, "evidence/m2-run-"));
const home = mkdtempSync(join(tmpdir(), "maestro-unit-home-"));
const args = ["--experimental-strip-types", "--enable-source-maps"];
if (coverage)
	args.push(
		"--experimental-test-coverage",
		"--test-coverage-include=maestro/**",
	);
args.push(
	"--test",
	"--test-reporter=tap",
	`--test-reporter-destination=${join(evidence, "tests.tap")}`,
	"--test-reporter=./scripts/baseline-reporter.ts",
	`--test-reporter-destination=${join(evidence, "events.jsonl")}`,
	...manifest.maestro_unit_entries,
);
try {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: tmpdir(),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		npm_config_cache: join(home, "npm-cache"),
	};
	if (coverage) env.NODE_V8_COVERAGE = join(evidence, "v8");
	const result = spawnSync(process.execPath, args, {
		cwd: root,
		env,
		encoding: "utf8",
	});
	writeFileSync(join(evidence, "stderr.log"), result.stderr ?? "");
	writeFileSync(
		join(evidence, "exit.json"),
		JSON.stringify(
			{
				node: process.version,
				status: result.status,
				error: result.error?.message,
				coverage,
				entries: manifest.maestro_unit_entries,
			},
			null,
			"\t",
		) + "\n",
	);
	assert.equal(
		result.status,
		0,
		`Unit tests failed; see ${evidence}/tests.tap and stderr.log`,
	);
	const events: ReportEvent[] = readFileSync(
		join(evidence, "events.jsonl"),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const summary = events.find(
		(e) => e.type === "test:summary" && !e.data?.file,
	)?.data;
	assert(summary?.success);
	const baseline: Identity[] = JSON.parse(
		gunzipSync(
			readFileSync(
				new URL(
					"../provenance/baseline/test-identities.json.gz",
					import.meta.url,
				),
			),
		).toString("utf8"),
	);
	const observed = events.filter(
		(e) => e.type === "test:pass" || e.type === "test:fail",
	);
	const byId = new Map(
		observed.map((e) => [JSON.stringify([e.file, e.testId]), e]),
	);
	for (const event of observed) {
		const titles: string[] = [];
		let current: Identity | undefined = event;
		while (current) {
			titles.unshift(current.name);
			current = current.parentId
				? byId.get(JSON.stringify([current.file, current.parentId]))
				: undefined;
		}
		assert.equal(
			titles.length,
			event.nesting + 1,
			`Incomplete lineage: ${event.file}:${event.line}`,
		);
		event.titles = titles;
	}
	const expectedLeaves = baseline.filter((event) => {
		if (event.kind === "suite") return false;
		if (event.file.endsWith(".conformance.ts"))
			return event.titles?.[0].startsWith("Fake");
		const entry = migration.files.find((entry) => entry.source === event.file);
		if (!entry) return false;
		const original = readFileSync(resolve(root, entry.archive), "utf8");
		const position = original
			.split("\n")
			.slice(0, event.line - 1)
			.reduce((n, line) => n + line.length + 1, 0);
		return entry.selections.some(
			(range) =>
				position >= original.lastIndexOf("\n", range.start - 1) + 1 &&
				position < range.end,
		);
	});
	const sourceFor = new Map(
		migration.files.map((e) => [e.destination, e.source]),
	);
	sourceFor.set(
		"maestro/testing/harness-adapter.conformance.ts",
		"test/maestro/harness-adapter.conformance.ts",
	);
	sourceFor.set(
		"maestro/testing/surface-provider.conformance.ts",
		"test/maestro/surface-provider.conformance.ts",
	);
	const key = (e: Identity, file = e.file) =>
		JSON.stringify([file, e.titles, e.skip, e.todo]);
	const expectedKeys = expectedLeaves.map((e) => key(e)).sort();
	const migrated = observed.filter(
		(e) => e.kind !== "suite" && sourceFor.has(e.file),
	);
	assert.deepEqual(
		migrated.map((e) => key(e, sourceFor.get(e.file))).sort(),
		expectedKeys,
		"Migrated identities/titles/skip statuses differ from pinned original cohort",
	);
	const selected = new Set(expectedKeys);
	const identities = baseline.map((event) => {
		const counterpart =
			event.kind !== "suite" && selected.has(key(event))
				? migrated.find((e) => key(e, sourceFor.get(e.file)) === key(event))
				: undefined;
		return {
			...event,
			owner: counterpart ? "@nubl/maestro" : "pi-herdr-agents",
			destination: counterpart?.file ?? event.file,
			migration_status: counterpart ? "verified" : "retained",
			counterpart: counterpart
				? {
						file: counterpart.file,
						line: counterpart.line,
						outcome: counterpart.type,
					}
				: undefined,
		};
	});
	writeFileSync(
		join(evidence, "identities.json.gz"),
		gzipSync(JSON.stringify(identities)),
	);
	console.log(
		`Unit tests: ${summary.counts.passed}/${summary.counts.tests} passed, ${summary.counts.skipped} skipped. ${migrated.length} original test identities preserved; ${1769 - migrated.length} remain upstream.`,
	);
	if (coverage) {
		const baselineCoverage: { original_files: OriginalFile[] } = JSON.parse(
			readFileSync(
				new URL("../provenance/coverage-manifest.json", import.meta.url),
				"utf8",
			),
		);
		const copies: {
			entries: { kind: string; source?: string; destination: string }[];
		} = JSON.parse(
			readFileSync(
				new URL("../provenance/copy-manifest.json", import.meta.url),
				"utf8",
			),
		);
		const sourcePaths = new Set(
			copies.entries
				.filter((e) => e.kind === "copy" && e.source?.startsWith("maestro/"))
				.map((e) => e.source),
		);
		const files = events.find((e) => e.type === "test:coverage")?.files;
		assert(files);
		const reports = baselineCoverage.original_files
			.filter((f) => sourcePaths.has(f.source))
			.map((original) => {
				const variants = files.filter((f) => f.path === original.source);
				assert(variants.length, `Missing coverage: ${original.source}`);
				const lines = new Map<number, number>();
				for (const variant of variants)
					for (const line of variant.lines)
						lines.set(
							line.line,
							Math.max(lines.get(line.line) ?? 0, line.count),
						);
				assert.equal(
					lines.size,
					original.total_lines,
					`Original line population changed: ${original.source}`,
				);
				const covered = [...lines.values()].filter((count) => count > 0).length;
				const percent = (100 * covered) / lines.size;
				assert(
					percent >= original.line,
					`${original.source}: ${percent}% < original-file floor ${original.line}%`,
				);
				return {
					source: original.source,
					population: original.population,
					covered,
					total: lines.size,
					line: percent,
					floor: original.line,
				};
			});
		assert.equal(
			reports.length,
			40,
			"M2 must account for all 40 measured original files (three additional copied core modules are type-only)",
		);
		const populations = [...new Set(reports.map((f) => f.population))].map(
			(population) => {
				const cohort = reports.filter((f) => f.population === population);
				return {
					population,
					files: cohort.length,
					arithmetic_line_mean:
						cohort.reduce((n, f) => n + f.line, 0) / cohort.length,
					subset_floor_line_mean:
						cohort.reduce((n, f) => n + f.floor, 0) / cohort.length,
					weighted_line_percent:
						(100 * cohort.reduce((n, f) => n + f.covered, 0)) /
						cohort.reduce((n, f) => n + f.total, 0),
				};
			},
		);
		const report = {
			base_main_sha: migration.copy_sha,
			copy_sha: migration.copy_sha,
			node: process.version,
			counts: summary.counts,
			migrated_tests: migrated.length,
			method:
				"Original-file line-hit union; per-file non-regression; arithmetic means and weighted ratios reported. Full runtime/surfaces combined gates remain M6/H2.",
			files: reports,
			populations,
		};
		writeFileSync(
			join(evidence, "coverage.json"),
			JSON.stringify(report, null, "\t") + "\n",
		);
		writeFileSync(
			join(evidence, "coverage.json.gz"),
			gzipSync(JSON.stringify(files)),
		);
		console.log(JSON.stringify(populations, null, 2));
	}
	console.log(`Evidence: ${evidence}`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
