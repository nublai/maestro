import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { gitBlob, readManifest } from "../scripts/check-copy-fidelity.ts";
import { checkBoundaryText } from "../scripts/check-boundaries.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));

interface ToolingFile {
	path: string;
	blob: string;
}
interface ToolingManifest {
	files: ToolingFile[];
}
interface OriginalFile {
	source: string;
	population: string;
	line: number;
}
interface Identity {
	kind: string;
	file: string;
	line: number;
	titles: string[];
	nesting: number;
	skip: boolean | string;
}

test("placeholder package has emitted-only exports and optional host peers, no SDK runtime dependencies", () => {
	assert.equal(pkg.version, "0.0.1");
	assert.equal(pkg.engines.node, ">=26.12.1");
	assert.equal(pkg.main, "./dist/index.js");
	assert.equal(pkg.types, "./dist/index.d.ts");
	assert(pkg.exports["./engine"]);
	assert(pkg.exports["./testing"]);
	assert(!Object.keys(pkg.exports).some((name) => name.includes("*")));
	assert.equal(pkg.exports["."].import, pkg.main);
	assert.equal(pkg.exports["."].default, pkg.main);
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.pi, undefined);
	assert.deepEqual(pkg.files, ["dist/", "LICENSE"]);
	for (const name of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"@sinclair/typebox",
	]) {
		assert.equal(pkg.peerDependencies[name], "*");
		assert.equal(pkg.peerDependenciesMeta[name].optional, true);
		assert(pkg.devDependencies[name]);
	}
	assert.equal(pkg.devDependencies["@types/node"], "26.6.4");
	for (const path of ["extensions", "skills", "prompts", "themes"])
		assert(!existsSync(new URL(path, root)));
	// M4: the tool surface moved; the terminal entry, its host composition and
	// all terminal presentation stay upstream (§2.3), so nothing here registers
	// widgets/renderers or loads itself as a second Pi extension.
	for (const path of [
		"index.ts",
		"widgets.ts",
		"renderers.ts",
		"tool-renderers.ts",
		"host-surface.ts",
		"marker-transport.ts",
		"child.ts",
		"child-widget.ts",
	])
		assert(!existsSync(new URL(`pi-extension/subagents/${path}`, root)), path);
});

test("lint plugin closure is pinned byte-for-byte, including module-mocking and assertion rules", () => {
	const tooling: ToolingManifest = JSON.parse(read("provenance/tooling.json"));
	for (const entry of tooling.files) {
		if (entry.path === "biome.json") continue; // Only formatter ownership includes are adapted.
		assert.equal(
			gitBlob(Buffer.from(read(entry.path))),
			entry.blob,
			entry.path,
		);
	}
	assert(
		tooling.files.some((entry: ToolingFile) =>
			entry.path.endsWith("no-module-mocking.ts"),
		),
	);
	assert(
		tooling.files.some((entry: ToolingFile) =>
			entry.path.endsWith("require-safety-comment-for-type-assertion.ts"),
		),
	);
	assert(
		!tooling.files.some((entry: ToolingFile) =>
			entry.path.includes("/effect/"),
		),
	);
	const biome = JSON.parse(read("biome.json"));
	assert.deepEqual(biome.formatter, { enabled: true });
	assert.deepEqual(biome.linter, { enabled: false });
	assert.deepEqual(biome.assist, { enabled: false });
});

test("the actual lint CLI rejects module mocking and unsafe assertions in tests", (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "maestro-lint-fixture-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	writeFileSync(
		join(fixture, "unsafe.test.ts"),
		'import { vi } from "vitest";\nvi.mock("example");\nconst value = "x" as string;\nvoid value;\n',
	);
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("node_modules/oxlint/bin/oxlint", root)),
			"--config",
			fileURLToPath(new URL("oxlint.config.ts", root)),
			"unsafe.test.ts",
		],
		{
			cwd: fixture,
			env: { PATH: process.env.PATH, HOME: fixture },
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 1, result.error);
	const output = result.stdout + result.stderr;
	assert.match(output, /anti-slop\(no-module-mocking\)/);
	assert.match(
		output,
		/anti-slop\(require-safety-comment-for-type-assertion\)/,
	);
});

test("M6 closes the drift ledger and records the Pi adapter/runtime and tool-surface copies from the H1 pin", () => {
	const copies = readManifest(new URL("provenance/copy-manifest.json", root));
	const drift = JSON.parse(read("provenance/drift-ledger.json"));
	const inventory = JSON.parse(read("provenance/inventory.json"));
	const tests = JSON.parse(read("provenance/test-manifest.json"));
	assert.equal(drift.status, "closed");
	assert.equal(drift.step, "M6");
	assert.equal(copies.base_main_sha, drift.base_main_sha);
	assert.equal(copies.copy_sha, drift.copy_sha);
	// Main did not move in M4 or M6: an empty range, so no touching commits.
	// M6 recopies from one more local H1 commit (type-only exports).
	assert.equal(drift.previous_pin, drift.base_main_sha);
	assert.deepEqual(drift.touching_commits, []);
	const m4 = drift.history.find(
		(entry: { step: string }) => entry.step === "M4",
	);
	assert.equal(m4.status, "closed");
	assert.notEqual(m4.copy_sha, drift.copy_sha);
	assert.equal(
		drift.copy_source_commits.at(-1).sha,
		drift.copy_sha.slice(0, 7),
	);
	const m3 = drift.history.find(
		(entry: { step: string }) => entry.step === "M3",
	);
	assert.equal(m3.status, "closed");
	assert.notEqual(m3.previous_pin, m3.base_main_sha);
	assert.equal(m3.base_main_sha, drift.base_main_sha);
	assert.equal(
		copies.entries.filter(
			(entry) => entry.kind === "copy" && entry.source.startsWith("maestro/"),
		).length,
		72,
	);
	assert.equal(
		copies.entries.filter(
			(entry) =>
				entry.kind === "copy" && entry.source.startsWith("pi-extension/"),
		).length,
		18,
	);
	for (const commit of drift.touching_commits)
		assert.match(commit.disposition, /^(?:carried|no-impact)$/);
	assert(
		!copies.entries.some(
			(entry) =>
				entry.destination === "maestro/adapters/pi/child/subagent-done.ts",
		),
		"the legacy terminal child forwarder stays upstream",
	);
	assert.equal(inventory.production.length, 98);
	assert.equal(tests.original_test_tree.length, 110);
	assert.equal(tests.original_unit_entries.length, 67);
	assert(tests.original_unit_entries.includes("test/test.ts"));
	assert.deepEqual(tests.retained_unit_entries, tests.original_unit_entries);
	assert(tests.migrated.length > 0);
});

test("baseline preserves nested identities, locations, skip status and original-file coverage populations", () => {
	const identities: Identity[] = JSON.parse(
		gunzipSync(
			readFileSync(
				new URL("provenance/baseline/test-identities.json.gz", root),
			),
		).toString("utf8"),
	);
	const leaves = identities.filter((identity) => identity.kind !== "suite");
	assert.equal(leaves.length, 1769);
	assert.equal(leaves.filter((identity) => identity.skip).length, 1);
	for (const identity of identities) {
		assert.equal(identity.titles.length, identity.nesting + 1);
		assert(identity.line > 0);
		assert(identity.file.startsWith("test/"));
	}
	const coverage = JSON.parse(read("provenance/coverage-manifest.json"));
	const files: OriginalFile[] = coverage.original_files;
	assert.equal(new Set(files.map((file) => file.source)).size, files.length);
	assert.equal(coverage.counts.failed, 0);
	assert.equal(coverage.counts.passed, 1768);
	for (const [name, population, floor] of [
		["core", 36, 98.0485953725156],
		["runtime", 10, 98.94096225077136],
		["surfaces", 9, 91.19073215228121],
	] as const) {
		const cohort = files.filter((file) => file.population === name);
		assert.equal(cohort.length, population);
		assert.equal(coverage.metrics[name].floor_line_mean, floor);
		const computed =
			cohort.reduce((sum, file) => sum + file.line, 0) / cohort.length;
		// Allow arithmetic rounding, never a floor discount.
		assert(
			Math.abs(
				coverage.metrics[name].observed_arithmetic_line_mean - computed,
			) <=
				Number.EPSILON * cohort.length * 100,
		);
		assert(coverage.metrics[name].observed_arithmetic_line_mean >= floor);
	}
});

for (const statement of [
	'import "pi-herdr-agents";',
	'export * from "pi-herdr-agents";',
	'type T = import("pi-herdr-agents").T;',
	"import(`pi-herdr-agents`);",
	"require(`pi-herdr-agents`);",
	'createRequire(import.meta.url)("pi-herdr-agents");',
	'createRequire("pi-herdr-agents");',
	"import.meta.resolve(`@earendil-works/pi-tui`);",
	'import { createRequire as cr } from "node:module"; const load = cr(import.meta.url); load("effect/Context");',
	'import * as module from "node:module"; module.createRequire(import.meta.url)("pi-herdr-agents");',
]) {
	test(`boundary gate rejects ${statement}`, () => {
		assert.throws(
			() => checkBoundaryText(statement, "fixture.mjs"),
			/Forbidden import/,
		);
	});
}

test("boundary gate permits legitimate template loads and module utilities", () => {
	checkBoundaryText(
		'import(`node:fs`); const require = createRequire(import.meta.url); require("node:path"); import.meta.resolve("@nubl/maestro");',
		"fixture.ts",
	);
});

test("capture expands the monolith and glob entries without executing the source shell script", (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "maestro-capture-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	mkdirSync(join(fixture, "test"));
	writeFileSync(join(fixture, "test/test.ts"), "");
	writeFileSync(join(fixture, "test/example.test.ts"), "");
	writeFileSync(
		join(fixture, "package.json"),
		JSON.stringify({
			scripts: { test: "node --test test/test.ts test/*.test.ts" },
		}),
	);
	const output = execFileSync(
		"python3",
		[
			"-c",
			'import importlib.util,json,pathlib,sys; s=importlib.util.spec_from_file_location("capture",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.expand_entries(pathlib.Path(sys.argv[2]))))',
			fileURLToPath(new URL("scripts/capture-baseline.py", root)),
			fixture,
		],
		{
			encoding: "utf8",
			env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
		},
	);
	assert.deepEqual(JSON.parse(output), [
		"test/test.ts",
		"test/example.test.ts",
	]);
});

test("publish validates the exact tarball checksum and its embedded version", (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "maestro-candidate-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	mkdirSync(join(fixture, "candidate"));
	mkdirSync(join(fixture, "package"));
	writeFileSync(
		join(fixture, "package/package.json"),
		JSON.stringify({ version: "0.1.0-rc.1" }),
	);
	execFileSync(
		"tar",
		["-czf", "candidate/maestro.tgz", "package/package.json"],
		{ cwd: fixture },
	);
	const tarball = join(fixture, "candidate/maestro.tgz");
	const hash = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	writeFileSync(
		join(fixture, "candidate/SHA256SUMS"),
		`${hash}  maestro.tgz\n`,
	);
	const workflow = read(".github/workflows/publish.yml");
	const script = workflow
		.split(
			"      - name: Verify candidate hash and tag version\n        run: |\n",
		)[1]
		.split("      - name:")[0]
		.replace(/^          /gm, "");
	const verify = (tag: string) =>
		spawnSync("bash", ["-euc", script], {
			cwd: fixture,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: fixture, GITHUB_REF_NAME: tag },
		});
	assert.equal(verify("v0.1.0-rc.1").status, 0);
	assert.notEqual(verify("v0.1.0").status, 0);
	writeFileSync(tarball, "tampered");
	assert.notEqual(verify("v0.1.0-rc.1").status, 0);
});

test("committed derivation reproduces coverage populations and identity lineage", (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "maestro-derive-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	execFileSync(
		"python3",
		[
			fileURLToPath(new URL("scripts/derive-baseline.py", root)),
			"--coverage-report",
			fileURLToPath(new URL("provenance/baseline/coverage.json.gz", root)),
			"--identity-report",
			fileURLToPath(
				new URL("provenance/baseline/test-identities.json.gz", root),
			),
			"--manifest",
			fileURLToPath(new URL("provenance/coverage-manifest.json", root)),
			"--output",
			join(fixture, "derived"),
			"--pin-floors",
		],
		{ env: { PATH: process.env.PATH, HOME: fixture, TMPDIR: fixture } },
	);
	assert.deepEqual(
		JSON.parse(
			readFileSync(join(fixture, "derived/coverage-manifest.json"), "utf8"),
		),
		JSON.parse(read("provenance/coverage-manifest.json")),
	);
	assert.deepEqual(
		JSON.parse(
			gunzipSync(
				readFileSync(join(fixture, "derived/test-identities.json.gz")),
			).toString(),
		),
		JSON.parse(
			gunzipSync(
				readFileSync(
					new URL("provenance/baseline/test-identities.json.gz", root),
				),
			).toString(),
		),
	);
});

test("CI and publishing retain OIDC/version guards and execute M1 gates on minimum Node", () => {
	for (const path of [
		".github/workflows/ci.yml",
		".github/workflows/publish.yml",
	]) {
		const workflow = read(path);
		assert(workflow.includes("node-version: 26.12.1"));
		for (const command of [
			"npm ci --ignore-scripts",
			"npm run format:check",
			"npm run lint",
			"npm run typecheck",
			"npm test",
			"npm run test:fidelity",
			"npm run build",
			"npm run check:copy-fidelity",
			"npm run check:boundaries",
			"npm pack --dry-run",
		])
			assert(workflow.includes(`- run: ${command}`));
	}
	const publish = read(".github/workflows/publish.yml");
	const [buildJob, publishJob] = publish.split("  publish:\n");
	assert(!buildJob.includes("id-token: write"));
	assert(publishJob.includes("needs: build"));
	assert(!/checkout@|npm (?:ci|install)|cache: npm/.test(publishJob));
	assert(publishJob.includes("sha256sum --check SHA256SUMS"));
	assert(buildJob.includes('npm run test:package -- "$PWD"/candidate/*.tgz'));
	assert(publish.includes("id-token: write"));
	assert(publish.includes("environment: npm-publish"));
	assert(publish.includes('test "v$v" = "$GITHUB_REF_NAME"'));
	const script = publish
		.split(
			"      - name: Publish stable to latest or prerelease to next\n        run: |\n",
		)[1]
		.split("\n")
		.map((line) => line.replace(/^          /, ""))
		.join("\n");
	const fixture = mkdtempSync(join(tmpdir(), "maestro-publish-test-"));
	try {
		mkdirSync(join(fixture, "candidate"));
		writeFileSync(join(fixture, "candidate/maestro.tgz"), "fixture");
		for (const [version, expected] of [
			["0.1.0", "publish ./maestro.tgz --ignore-scripts --access public"],
			[
				"0.1.0-rc.1",
				"publish ./maestro.tgz --ignore-scripts --access public --tag next",
			],
			[
				"0.1.0-beta.2+build",
				"publish ./maestro.tgz --ignore-scripts --access public --tag next",
			],
			[
				"0.1.0+build-with-hyphen",
				"publish ./maestro.tgz --ignore-scripts --access public",
			],
		]) {
			writeFileSync(
				join(fixture, "candidate/package.json"),
				JSON.stringify({ version }),
			);
			// Execute the exact workflow dispatch with a shell function in place of npm.
			const result = execFileSync(
				"bash",
				["-euc", `npm() { printf '%s\\n' "$*"; };\n${script}`],
				{
					cwd: fixture,
					env: { PATH: process.env.PATH, HOME: fixture },
					encoding: "utf8",
				},
			).trim();
			assert.equal(result, expected, version);
		}
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
