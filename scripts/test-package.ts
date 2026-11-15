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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
	writeFileSync(
		join(fixture, "consumer.js"),
		`
import assert from "node:assert/strict";
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
		.filter((name) => name !== "./package.json")
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
		"Packed JS generic-owner lifecycle, all 45 finite exports and declarations, peer-free strict Promise consumer (Node dev types supplied), maps, license and discovery allowlist: passed.",
	);
	console.log(
		"Pi factory/child/schema/asset smokes remain pending M3/M4; no such API exists in M2.",
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
