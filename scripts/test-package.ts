import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
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
	assert.deepEqual(readdirSync(join(installed, "dist")).sort(), [
		"index.d.ts",
		"index.d.ts.map",
		"index.js",
		"index.js.map",
	]);
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
assert.deepEqual(Object.keys(pkg.exports), [".", "./package.json"]);
assert.equal(pkg.pi, undefined);
assert.equal(pkg.dependencies, undefined);
for (const name of Object.keys(pkg.exports)) {
 const specifier = name === "." ? "@nubl/maestro" : "@nubl/maestro/" + name.slice(2);
 assert(import.meta.resolve(specifier).includes("node_modules/@nubl/maestro/"));
}
assert(!process.execArgv.some(arg => /loader|strip-types|import/.test(arg)));
`,
	);
	run(process.execPath, ["consumer.js"]);
	writeFileSync(
		join(fixture, "consumer.ts"),
		'import { version } from "@nubl/maestro";\nasync function consume(): Promise<string> { return version; }\nvoid consume();\n',
	);
	writeFileSync(
		join(fixture, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noEmit: true,
				module: "nodenext",
				target: "es2023",
				types: [],
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
		"Packed JS import, all M1 exports, peer-free strict TS consumer, maps, license and discovery allowlist: passed.",
	);
	console.log(
		"Pi factory/child/schema/asset smokes remain pending M3/M4; no such API exists in M1.",
	);
} finally {
	rmSync(fixture, { recursive: true, force: true });
}
