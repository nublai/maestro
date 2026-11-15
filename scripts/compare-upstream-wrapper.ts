import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "./check-copy-fidelity.ts";

/**
 * Local cross-repository wrapper comparison (plan M4 row; not a CI gate).
 *
 * Extracts the pinned H1 tree twice with `git archive` (the upstream checkout
 * is only read): A is the pristine H1 host; B is the same host whose terminal
 * entry imports createPiExtension from the installed Maestro tarball, with its
 * own extension.ts deleted. Both run H1's own contract probes in fresh,
 * isolated processes: the registration pin (parent and child/deny-tool), the
 * terminal presentation probe, the real Pi loader /reload probe, and the
 * tool-docs/schema check, plus a full registration capture. A and B must be
 * equal to each other and to H1's frozen fixtures.
 *
 *   node --experimental-strip-types scripts/compare-upstream-wrapper.ts \
 *     <upstream checkout> <maestro tarball> <evidence dir>
 */
const [upstream, tarball, evidence] = process.argv.slice(2);
assert(
	upstream && tarball && evidence,
	"Usage: compare-upstream-wrapper.ts <upstream> <tarball> <evidence dir>",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const { copy_sha: pin } = readManifest(
	join(root, "provenance/copy-manifest.json"),
);
mkdirSync(evidence, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "maestro wrapper compare "));

/** Real node_modules dir whose entries link to the upstream install (read-only). */
function linkModules(tree: string): void {
	const modules = join(tree, "node_modules");
	mkdirSync(modules);
	for (const entry of readdirSync(join(upstream, "node_modules")))
		if (entry !== "@nubl")
			symlinkSync(
				join(upstream, "node_modules", entry),
				join(modules, entry),
				"dir",
			);
}

function extract(name: string): string {
	const tree = join(work, name);
	mkdirSync(tree);
	const archive = execFileSync("git", ["-C", upstream, "archive", pin], {
		maxBuffer: 1 << 30,
	});
	execFileSync("tar", ["-x", "-C", tree], { input: archive });
	linkModules(tree);
	return tree;
}

const pristine = extract("A pristine");
const wrapped = extract("B package factory");
const installed = join(wrapped, "node_modules/@nubl/maestro");
mkdirSync(installed, { recursive: true });
execFileSync("tar", [
	"-xzf",
	resolve(tarball),
	"-C",
	installed,
	"--strip-components=1",
]);
// The H2 wrapper shape: retained hooks, package factory. Nothing else changes.
const entry = join(wrapped, "pi-extension/subagents/index.ts");
const original = readFileSync(entry, "utf8");
const rewritten = original.replaceAll(
	'from "./extension.ts"',
	'from "@nubl/maestro/pi/subagents/extension"',
);
assert.equal(original.split('from "./extension.ts"').length - 1, 2);
writeFileSync(entry, rewritten);
rmSync(join(wrapped, "pi-extension/subagents/extension.ts"));

const capture = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const repo = process.cwd();
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "wrapper-capture-"));
const { createMockExtensionApi } = await import(pathToFileURL(join(repo, "test/helpers/mock-extension-api.ts")).href);
const plain = (value) => JSON.parse(JSON.stringify(value, (key, v) => typeof v === "function" ? "[function " + key + "]" : v));
const out = {};
for (const scope of ["parent", "child"]) {
	if (scope === "child") Object.assign(process.env, { PI_SUBAGENT_ID: "pin-child", PI_DENY_TOOLS: "subagent,subagent_resume" });
	const module = await import(pathToFileURL(join(repo, "pi-extension/subagents/index.ts")).href + "?" + scope);
	const mock = createMockExtensionApi();
	module.default(mock.api);
	out[scope] = {
		exports: Object.keys(module).sort(),
		testSurface: Object.keys(module.__test__).sort(),
		tools: plain(mock.registeredTools),
		commands: plain(mock.registeredCommands),
		renderers: mock.registeredMessageRenderers.map((r) => r.name ?? r[0] ?? r),
		events: [...mock.eventHandlers].map(([event, handlers]) => [event, handlers.length]),
	};
	for (const handler of mock.eventHandlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, { ui: { setWidget() {} } });
}
process.stdout.write(JSON.stringify(out) + "\\n", () => process.exit(0));
`;

function run(tree: string, args: string[]) {
	const home = mkdtempSync(join(work, "home "));
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", ...args],
		{
			cwd: tree,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 1 << 28,
			// Isolated: no daily Pi config, Herdr sockets, accounts or credentials.
			env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() },
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function json(tree: string, args: string[], name: string) {
	const result = run(tree, args);
	writeFileSync(
		join(evidence, `${name}.json`),
		JSON.stringify(result, null, "\t"),
	);
	assert.equal(result.status, 0, `${name} failed: ${result.stderr}`);
	try {
		return JSON.parse(result.stdout);
	} catch (cause) {
		throw new Error(`${name} printed no JSON`, { cause });
	}
}

const fixture = (name: string) => {
	try {
		return JSON.parse(
			readFileSync(join(pristine, "test/fixtures", name), "utf8"),
		);
	} catch (cause) {
		throw new Error(`Cannot read H1 fixture ${name}`, { cause });
	}
};
const report: Record<string, string> = {};
try {
	for (const [label, tree] of [
		["A", pristine],
		["B", wrapped],
	] as const) {
		const pin = json(
			tree,
			[".pi/skills/verify-pi-herdr-agents/scripts/pin.ts"],
			`${label}-pin`,
		);
		delete pin.repo;
		assert.deepEqual(pin, fixture("h1-contract.json"), `${label} pin`);
		assert.deepEqual(
			json(
				tree,
				["test/fixtures/h1-presentation-probe.ts"],
				`${label}-presentation`,
			),
			fixture("h1-presentation.json"),
			`${label} presentation`,
		);
		assert.deepEqual(
			json(tree, ["test/fixtures/h1-reload-probe.ts"], `${label}-reload`),
			fixture("h1-reload.json"),
			`${label} real-loader reload`,
		);
		const docs = run(tree, ["scripts/update-tool-docs.ts", "--check"]);
		writeFileSync(
			join(evidence, `${label}-docs-tools-check.json`),
			JSON.stringify(docs, null, "\t"),
		);
		assert.equal(docs.status, 0, `${label} docs:tools:check: ${docs.stderr}`);
		writeFileSync(join(tree, "wrapper-capture.mjs"), capture);
		report[label] =
			"pin, presentation, real-loader reload and docs:tools:check match H1's fixtures";
	}
	const a = json(pristine, ["wrapper-capture.mjs"], "A-capture");
	const b = json(wrapped, ["wrapper-capture.mjs"], "B-capture");
	assert.deepEqual(b, a, "full registration capture differs");
	assert(existsSync(join(installed, "dist/maestro/pi.js")));
	const tools = a.parent.tools.length + a.child.tools.length;
	report.capture = `A and B registrations equal: exports, __test__ keys, ${tools} tool definitions (every JSON field, function presence), commands, message renderers and handler counts, parent and child/deny-tool scopes`;
	writeFileSync(
		join(evidence, "summary.json"),
		JSON.stringify({ pin, tarball: resolve(tarball), report }, null, "\t"),
	);
	console.log(JSON.stringify(report, null, 2));
} finally {
	rmSync(work, { recursive: true, force: true });
}
