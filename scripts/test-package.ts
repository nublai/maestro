import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "maestro packed consumer "));
// Never inherit operator Pi config, loader hooks, SDK account paths or credentials.
const env = {
	PATH: process.env.PATH,
	HOME: fixture,
	TMPDIR: fixture,
	npm_config_cache: join(fixture, "npm-cache"),
};
function run(binary: string, args: string[], cwd = fixture): string {
	return execFileSync(binary, args, {
		cwd,
		env,
		encoding: "utf8",
		timeout: 120_000,
	});
}
/** Bare host-peer specifiers reachable through an emitted file's relative imports. */
function peerImports(file: string, seen = new Set<string>()): Set<string> {
	const peers = new Set<string>();
	if (seen.has(file)) return peers;
	seen.add(file);
	const text = readFileSync(file, "utf8");
	for (const { fileName } of ts.preProcessFile(text, true, true)
		.importedFiles) {
		if (/^@earendil-works\/pi-|^@sinclair\/typebox/.test(fileName))
			peers.add(fileName);
		else if (fileName.startsWith("."))
			for (const peer of peerImports(resolve(dirname(file), fileName), seen))
				peers.add(peer);
	}
	return peers;
}

/**
 * A host that provides the optional peers (its own node_modules holds Pi and
 * TypeBox, as Pi's install does) loads every Pi entry from the installed JS,
 * composes the run session through a HostSurfaceBinding and launches with the
 * emitted protocol-only child entry, whose registrations equal the source entry's.
 */
function piConsumer(
	fixture: string,
	tarball: string,
	piExports: string[],
): void {
	const host = join(fixture, "pi host");
	const consumer = join(host, "consumer");
	mkdirSync(consumer, { recursive: true });
	symlinkSync(join(root, "node_modules"), join(host, "node_modules"), "dir");
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--omit=peer",
			"--offline",
			"--no-audit",
			"--no-fund",
			tarball,
		],
		consumer,
	);
	assert(!existsSync(join(consumer, "node_modules/@earendil-works")));
	assert(!existsSync(join(consumer, "node_modules/@sinclair")));
	const installedEntry = join(
		consumer,
		"node_modules/@nubl/maestro/dist/maestro/adapters/pi/child/entry.js",
	);
	writeFileSync(join(consumer, "pi-exports.json"), JSON.stringify(piExports));
	cpSync(
		join(root, "config.json.example"),
		join(consumer, "config.json.example"),
	);
	writeFileSync(
		join(consumer, "capture-child-entry.mjs"),
		stripTypeScriptTypes(
			readFileSync(join(root, "scripts/capture-child-entry.ts"), "utf8"),
		),
	);
	writeFileSync(
		join(consumer, "pi-consumer.js"),
		`
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import piExports from "./pi-exports.json" with { type: "json" };
assert(!process.execArgv.some(arg => /loader|strip-types|import/.test(arg)));
for (const name of piExports) {
 const specifier = "@nubl/maestro/" + name.slice(2);
 assert(import.meta.resolve(specifier).includes("node_modules/@nubl/maestro/dist/"));
 await import(specifier);
}
const { DEFAULT_CHILD_ENTRY_PATH } = await import("@nubl/maestro/adapters/pi/launch-command");
const entry = fileURLToPath(import.meta.resolve("@nubl/maestro/pi/child"));
assert.equal(DEFAULT_CHILD_ENTRY_PATH, entry);
assert.equal(entry, ${JSON.stringify(installedEntry)});
assert(existsSync(entry) && entry.includes(" "));
assert.equal(typeof (await import("@nubl/maestro/pi/child")).default, "function");
const { createDefaultRunSession } = await import("@nubl/maestro/runtime");
const { FakeSurfaceProvider } = await import("@nubl/maestro/testing");
const dir = join(process.cwd(), "run dir");
mkdirSync(join(dir, "sessions"), { recursive: true });
const parent = join(dir, "parent.jsonl");
writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\\n");
const paneConfig = { mode: "tab", direction: "right", maxPerTab: 4 };
const snapshot = {
 parent: { cwd: dir, invocationCwd: dir, sessionFile: parent, sessionId: "parent", sessionDir: join(dir, "sessions"), agentDir: dir },
 parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
 paneConfig,
 modelRegistry: { find: (p, id) => ({ provider: p, id, reasoning: true }), available: () => [], hasConfiguredAuth: () => true, supportedThinkingLevels: () => ["off", "high"], clampThinkingLevel: (_m, level) => level },
};
const base = {
 configDir: dir, configExamplePath: join(process.cwd(), "config.json.example"), forcePolling: false, roles: [],
 getLaunchSnapshot: () => snapshot, hooks: { onSettled() {} },
 persistent: { send: () => ({ error: "fixture" }), stop: () => ({ error: "fixture" }), drain() {} },
};
assert.throws(() => createDefaultRunSession(base), /^Error: Pi run session requires a host surface binding$/);
const launches = [];
let owners = 0;
const hostSurface = {
 resolve: () => ({ backend: "legacy" }),
 createProvider: () => { owners++; return new FakeSurfaceProvider(); },
 createLaunchProvider: () => { const provider = new FakeSurfaceProvider(); launches.push(provider); return provider; },
};
const session = createDefaultRunSession({ ...base, hostSurface, platform: "linux" });
const plan = { provider: "test", modelId: "one", model: "test/one", thinking: "high", modelSource: "request", thinkingSource: "parent" };
const handle = await session.spawnPi({
 task: { id: "smoke", name: "child", prompt: "bounded", role: "", cwd: dir, behavior: { autoExit: true, persistent: false } },
 role: { name: "", version: "1", description: "fixture", systemPrompt: "", allowedTools: [] },
 plans: [plan], resolved: {},
 identity: { id: "public-smoke", logicalId: "logical-smoke", generationId: "generation-smoke", taskId: "inbox-smoke" },
});
assert.equal(owners, 1);
assert.equal(launches.length, 1);
const [command] = launches[0].commands(handle.surfaceId);
assert(command.includes(" -e '" + DEFAULT_CHILD_ENTRY_PATH + "' "), command);
assert.equal((await session.cancel("smoke")).status, "confirmed");
await session.shutdown("quit");
`,
	);
	run(process.execPath, ["pi-consumer.js"], consumer);
	for (const variant of [
		{},
		{ PI_SUBAGENT_AUTO_EXIT: "1" },
		{ PI_SUBAGENT_PERSISTENT: "1", PI_SUBAGENT_NOTIFY: "1" },
	]) {
		const capture = (args: string[], cwd: string) => {
			const output = execFileSync(process.execPath, args, {
				cwd,
				env: { ...env, ...variant },
				encoding: "utf8",
				timeout: 120_000,
			});
			try {
				return JSON.parse(output);
			} catch (cause) {
				throw new Error(
					`Child capture printed no registration JSON: ${output}`,
					{
						cause,
					},
				);
			}
		};
		const installed = capture(
			["capture-child-entry.mjs", installedEntry],
			consumer,
		);
		const source = capture(
			[
				"--experimental-strip-types",
				"--no-warnings",
				join(root, "scripts/capture-child-entry.ts"),
				join(root, "maestro/adapters/pi/child/entry.ts"),
			],
			root,
		);
		assert.deepEqual(installed, source);
		const names = installed.tools.map((tool: { name: string }) => tool.name);
		assert(names.includes("caller_ping"));
		assert.equal(
			names.includes("caller_notify"),
			"PI_SUBAGENT_NOTIFY" in variant,
		);
		assert.equal(
			names.includes("subagent_done"),
			!("PI_SUBAGENT_AUTO_EXIT" in variant),
		);
	}
	writeFileSync(
		join(consumer, "consumer.ts"),
		piExports
			.map(
				(name, index) =>
					`import * as pi${index} from ${JSON.stringify("@nubl/maestro/" + name.slice(2))};\nvoid pi${index};`,
			)
			.join("\n") +
			'\nimport type { HostSurfaceBinding } from "@nubl/maestro/runtime/host-surface-binding";\nimport { FakeSurfaceProvider } from "@nubl/maestro/testing";\nconst binding: HostSurfaceBinding = { resolve: () => ({ backend: "legacy" }), createProvider: () => new FakeSurfaceProvider(), createLaunchProvider: () => new FakeSurfaceProvider() };\nvoid binding;\n',
	);
	writeFileSync(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				module: "nodenext",
				target: "es2023",
				types: ["node"],
				skipLibCheck: true,
			},
			files: ["consumer.ts"],
		}),
	);
	run(
		process.execPath,
		[join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
		consumer,
	);
	console.log(
		`Installed Pi entries with host peers: ${piExports.length} exports load from emitted JS, HostSurfaceBinding composition is enforced, launches load the emitted child entry by its installed path (with spaces), and its registrations equal the source child in 3 env variants; declarations typecheck against the peers.`,
	);
}

try {
	const candidate = process.argv[2] ? resolve(process.argv[2]) : undefined;
	if (candidate)
		writeFileSync(join(fixture, basename(candidate)), readFileSync(candidate));
	else run("npm", ["pack", "--pack-destination", fixture, "--silent"], root);
	const tarballs = readdirSync(fixture).filter((path) => path.endsWith(".tgz"));
	assert.equal(tarballs.length, 1);
	writeFileSync(
		join(fixture, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	run("npm", [
		"install",
		"--ignore-scripts",
		"--omit=peer",
		"--offline",
		"--no-audit",
		"--no-fund",
		join(fixture, tarballs[0]),
	]);
	const installed = join(fixture, "node_modules/@nubl/maestro");
	assert(!existsSync(join(fixture, "node_modules/@earendil-works")));
	assert(!existsSync(join(fixture, "node_modules/@sinclair")));
	assert.equal(
		readFileSync(join(installed, "LICENSE"), "utf8"),
		readFileSync(join(root, "LICENSE"), "utf8"),
	);
	assert.deepEqual(readdirSync(installed).sort(), [
		"LICENSE",
		"README.md",
		"dist",
		"package.json",
	]);
	assert(existsSync(join(installed, "dist/maestro/engine.js")));
	assert(!existsSync(join(installed, "test")));
	const sourceMap = JSON.parse(
		readFileSync(join(installed, "dist/index.js.map"), "utf8"),
	);
	assert.deepEqual(sourceMap.sources, ["../index.js"]);
	assert.deepEqual(sourceMap.sourcesContent, [
		readFileSync(join(root, "index.js"), "utf8"),
	]);
	assert.match(
		readFileSync(join(installed, "dist/index.d.ts"), "utf8"),
		/export (?:declare )?const version: string;/,
	);
	// Exports whose emitted closure imports a host-provided Pi/TypeBox peer.
	const installedPkg = JSON.parse(
		readFileSync(join(installed, "package.json"), "utf8"),
	);
	const piExports = Object.keys(installedPkg.exports).filter(
		(name) =>
			name !== "./package.json" &&
			peerImports(join(installed, installedPkg.exports[name].import)).size > 0,
	);
	assert(piExports.includes("./runtime"));
	assert(piExports.includes("./pi/child"));
	assert(!piExports.includes("."));
	assert(!piExports.includes("./engine"));
	assert(!piExports.includes("./testing"));
	writeFileSync(join(fixture, "pi-exports.json"), JSON.stringify(piExports));
	writeFileSync(
		join(fixture, "consumer.js"),
		`
import assert from "node:assert/strict";
import piExports from "./pi-exports.json" with { type: "json" };
import { version } from "@nubl/maestro";
import pkg from "@nubl/maestro/package.json" with { type: "json" };
assert.equal(version, pkg.version);
assert(pkg.exports["./engine"]);
assert(pkg.exports["./testing"]);
assert(!Object.keys(pkg.exports).some(name => name.includes("*")));
assert.equal(pkg.pi, undefined);
assert.equal(pkg.dependencies, undefined);
for (const name of Object.keys(pkg.exports)) {
 const specifier = name === "." ? "@nubl/maestro" : "@nubl/maestro/" + name.slice(2);
 assert(import.meta.resolve(specifier).includes("node_modules/@nubl/maestro/"));
 if (piExports.includes(name)) {
  // Pi entries require the optional host peers; the engine-only install has none.
  await assert.rejects(import(specifier), (error) => error.code === "ERR_MODULE_NOT_FOUND" && /@earendil-works[/]pi-|@sinclair[/]typebox/.test(error.message));
  continue;
 }
 await import(specifier, name === "./package.json" ? { with: { type: "json" } } : undefined);
}
assert(!process.execArgv.some(arg => /loader|strip-types|import/.test(arg)));
const { createRunSession, defaultRetainSurface } = await import("@nubl/maestro/engine");
const { FakeHarnessAdapter, FakeSurfaceProvider, registerHarnessAdapterConformance, registerSurfaceProviderConformance } = await import("@nubl/maestro/testing");
assert.equal(typeof defaultRetainSurface, "function");
assert.equal(typeof registerHarnessAdapterConformance, "function");
assert.equal(typeof registerSurfaceProviderConformance, "function");
assert.equal(new FakeSurfaceProvider().isAvailable(), true);
const adapter = new FakeHarnessAdapter();
const role = { name: "fixture", version: "1", description: "fixture", systemPrompt: "fixture", allowedTools: [] };
const task = { id: "fixture", name: "fixture", prompt: "fixture", role: "fixture", cwd: process.cwd() };
const session = createRunSession({ adapter, roles: [role], cwd: process.cwd() });
const handle = await session.spawn(task);
const completion = session.supervise(handle, task);
adapter.complete(handle.id, { reason: "done", exitCode: 0 });
assert.equal((await completion).outcome, "completed");
`,
	);
	run(process.execPath, ["consumer.js"]);
	// Explicit development-only Node types; no Pi peers or source TS fallbacks.
	mkdirSync(join(fixture, "node_modules/@types"), { recursive: true });
	cpSync(
		join(root, "node_modules/@types/node"),
		join(fixture, "node_modules/@types/node"),
		{ recursive: true },
	);
	cpSync(
		join(root, "node_modules/undici-types"),
		join(fixture, "node_modules/undici-types"),
		{ recursive: true },
	);
	const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	const imports = Object.keys(pkg.exports)
		.filter((name) => name !== "./package.json" && !piExports.includes(name))
		.map(
			(name, index) =>
				`import * as entry${index} from ${JSON.stringify(name === "." ? "@nubl/maestro" : "@nubl/maestro/" + name.slice(2))};\nvoid entry${index};`,
		)
		.join("\n");
	writeFileSync(
		join(fixture, "consumer.ts"),
		imports +
			'\nimport { createRunSession, type RunSession, type RunResult } from "@nubl/maestro/engine";\nimport { FakeHarnessAdapter } from "@nubl/maestro/testing";\nconst role = { name: "fixture", version: "1", description: "fixture", systemPrompt: "fixture", allowedTools: [] };\nconst session: RunSession = createRunSession({ adapter: new FakeHarnessAdapter(), roles: [role], cwd: "/fixture" });\nasync function consume(): Promise<RunResult> { const task = { id: "fixture", name: "fixture", prompt: "fixture", role: "fixture", cwd: "/fixture" }; return session.supervise(await session.spawn(task), task); }\nvoid consume;\n',
	);
	writeFileSync(
		join(fixture, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				module: "nodenext",
				target: "es2023",
				types: ["node"],
				skipLibCheck: false,
			},
			files: ["consumer.ts"],
		}),
	);
	run(process.execPath, [
		join(root, "node_modules/typescript/bin/tsc"),
		"-p",
		"tsconfig.json",
	]);
	console.log(
		`Packed JS generic-owner lifecycle, ${Object.keys(pkg.exports).length} finite exports (${piExports.length} Pi entries refuse without peers), peer-free strict Promise consumer (Node dev types supplied), maps, license and discovery allowlist: passed.`,
	);
	piConsumer(fixture, join(fixture, tarballs[0]), piExports);
	console.log(
		"Pi factory/schema/config-asset smokes remain pending M4; no such API exists in M3.",
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
