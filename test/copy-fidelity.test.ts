import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkCopyFidelity,
	gitBlob,
	normalizeImports,
	readManifest,
	type CopyManifest,
} from "../scripts/check-copy-fidelity.ts";

const source = `// Keep ../old.ts exactly, including whitespace.
import value from "../old.ts";
import type { T } from '../old.ts';
export { value } from "../old.ts";
export * from '../old.ts';
type I = import("../old.ts").T;
const load = () => import('../old.ts');
const text = "../old.ts";
const literalTemplate = () => import(\`../old.ts\`);
const computed = () => import(\`../\${part}.ts\`);
`;
const mappings = [{ from: "../old.ts", to: "@nubl/maestro/core/old" }];
const expected = source.replace(
	/(from |import\()["'`]\.\.\/old\.ts["'`]/g,
	(match) => match.replace("../old.ts", "@nubl/maestro/core/old"),
);

interface FidelityFixture {
	root: string;
	manifest: CopyManifest;
	dispose: () => void;
}

function fixture(): FidelityFixture {
	const root = mkdtempSync(join(tmpdir(), "maestro-fidelity-"));
	writeFileSync(join(root, "original.ts"), source);
	writeFileSync(join(root, "destination.ts"), expected);
	return {
		root,
		manifest: {
			base_main_sha: "a".repeat(40),
			copy_sha: "a".repeat(40),
			mappings,
			entries: [
				{
					kind: "copy",
					source: "original.ts",
					destination: "destination.ts",
					archive: "original.ts",
					blob: gitBlob(Buffer.from(source)),
				},
			],
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("normalizes only static, re-export, import-type and literal dynamic specifiers", () => {
	assert.equal(normalizeImports(source, "original.ts", mappings), expected);
	assert(expected.includes('const text = "../old.ts"'));
	assert(expected.includes("// Keep ../old.ts exactly"));
	assert(expected.includes("import(`../${part}.ts`)"));
	assert(expected.includes("import(`@nubl/maestro/core/old`)"));
	assert.equal(normalizeImports(source, "original.ts", []), source);
});

test("declaration imports and CRLF/unicode text stay byte-preserving", () => {
	const text = '// café\r\nexport type T = import("../old.ts").T;\r\n';
	assert.equal(
		normalizeImports(text, "entry.d.ts", mappings),
		text.replace("../old.ts", "@nubl/maestro/core/old"),
	);
});

test("non-code assets are compared as bytes, never normalized", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const bytes = Buffer.from([0, 255, 13, 10, 128]);
	writeFileSync(join(f.root, "source.bin"), bytes);
	writeFileSync(join(f.root, "asset.bin"), bytes);
	f.manifest.entries = [
		{
			kind: "copy",
			source: "source.bin",
			destination: "asset.bin",
			archive: "source.bin",
			blob: gitBlob(bytes),
		},
	];
	assert.equal(checkCopyFidelity(f.manifest, f.root), 1);
	writeFileSync(join(f.root, "asset.bin"), bytes.subarray(1));
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /Copy differs/);
});

test("missing upstream/archive provenance is an error", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const entry = f.manifest.entries[0];
	assert(entry.kind === "copy");
	delete entry.archive;
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/No upstream repository or archive/,
	);
});

test("archived copy verifies pinned Git blob and declared rewrites", (t) => {
	const f = fixture();
	t.after(f.dispose);
	assert.equal(checkCopyFidelity(f.manifest, f.root), 1);
	writeFileSync(join(f.root, "manifest.json"), JSON.stringify(f.manifest));
	assert.deepEqual(readManifest(join(f.root, "manifest.json")), f.manifest);
});

for (const [name, change] of [
	["comment", expected.replace("Keep", "Change")],
	["whitespace", `${expected}\n`],
	[
		"ordinary literal",
		expected.replace('const text = "../old.ts"', 'const text = "rewritten"'),
	],
	["unlisted specifier", expected.replace("@nubl/maestro/core/old", "other")],
	[
		"computed import",
		expected.replace("import(`../${part}.ts`)", "import(`other`)"),
	],
] as const) {
	test(`rejects changed ${name}`, (t) => {
		const f = fixture();
		t.after(f.dispose);
		writeFileSync(join(f.root, "destination.ts"), change);
		assert.throws(() => checkCopyFidelity(f.manifest, f.root));
	});
}

test("rejects missing files, unpinned archives, duplicate mappings and invalid syntax", (t) => {
	const f = fixture();
	t.after(f.dispose);
	assert.throws(
		() => normalizeImports("import {", "broken.ts", mappings),
		/parse/,
	);
	assert.throws(
		() => normalizeImports(source, "original.ts", [...mappings, ...mappings]),
		/Duplicate/,
	);
	writeFileSync(join(f.root, "original.ts"), "tampered");
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /Blob mismatch/);
	rmSync(join(f.root, "destination.ts"));
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /ENOENT/);
});

test("explicit new-file entries require a file and a reason", (t) => {
	const f = fixture();
	t.after(f.dispose);
	f.manifest.entries = [
		{ kind: "new", destination: "destination.ts", reason: "M1 fixture facade" },
	];
	assert.equal(checkCopyFidelity(f.manifest, f.root), 0);
	writeFileSync(
		join(f.root, "manifest.json"),
		JSON.stringify({
			...f.manifest,
			entries: [{ kind: "new", destination: "destination.ts", reason: "" }],
		}),
	);
	assert.throws(() => readManifest(join(f.root, "manifest.json")), /Invalid/);
	writeFileSync(join(f.root, "manifest.json"), "{");
	assert.throws(
		() => readManifest(join(f.root, "manifest.json")),
		/Invalid copy manifest/,
	);
	f.manifest.entries.push(f.manifest.entries[0]);
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/Duplicate destination/,
	);
});

test("local git source and archived blobs must agree", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", f.root, ...args], {
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				HOME: f.root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		}).trim();
	git("init", "--quiet");
	git("add", "original.ts");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--quiet",
		"-m",
		"fixture",
	);
	f.manifest.copy_sha = git("rev-parse", "HEAD");
	assert.equal(checkCopyFidelity(f.manifest, f.root, f.root), 1);
	writeFileSync(join(f.root, "original.ts"), "tampered");
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root, f.root),
		/Archive differs/,
	);
	assert.equal(readFileSync(join(f.root, "destination.ts"), "utf8"), expected);
});
