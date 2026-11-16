import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

test("rejects redirected mapping into unlisted changed logic", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-redirect-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "maestro"));
	mkdirSync(join(root, "provenance"));
	writeFileSync(
		join(root, "provenance/inventory.json"),
		JSON.stringify({ production: [{ source: "maestro/a.ts", fate: "move" }] }),
	);
	const original = 'import value from "./b.ts";\n';
	writeFileSync(
		join(root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: "a".repeat(40),
			files: [{ path: "maestro/a.ts", blob: gitBlob(Buffer.from(original)) }],
		}),
	);
	writeFileSync(join(root, "original.ts"), original);
	writeFileSync(
		join(root, "maestro/a.ts"),
		original.replace("./b.ts", "./b-evil.ts"),
	);
	writeFileSync(join(root, "maestro/b-evil.ts"), 'export default "evil";\n');
	assert.throws(
		() =>
			checkCopyFidelity(
				{
					base_main_sha: "a".repeat(40),
					copy_sha: "a".repeat(40),
					mappings: [{ from: "./b.ts", to: "./b-evil.ts" }],
					entries: [
						{
							kind: "copy",
							source: "maestro/a.ts",
							destination: "maestro/a.ts",
							archive: "original.ts",
							blob: gitBlob(Buffer.from(original)),
						},
					],
				},
				root,
			),
		/Unlisted destination/,
	);
});

test("rejects relabelled upstream module as new despite changed content", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-relabel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "maestro"));
	mkdirSync(join(root, "provenance"));
	writeFileSync(join(root, "maestro/a.ts"), 'export default "evil";\n');
	writeFileSync(
		join(root, "provenance/inventory.json"),
		JSON.stringify({ production: [{ source: "maestro/a.ts", fate: "move" }] }),
	);
	writeFileSync(
		join(root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: "a".repeat(40),
			files: [
				{
					path: "maestro/a.ts",
					blob: gitBlob(Buffer.from('export default "original";\n')),
				},
			],
		}),
	);
	assert.throws(
		() =>
			checkCopyFidelity(
				{
					base_main_sha: "a".repeat(40),
					copy_sha: "a".repeat(40),
					mappings: [],
					entries: [
						{ kind: "new", destination: "maestro/a.ts", reason: "facade" },
					],
				},
				root,
			),
		/upstream origin/,
	);
});

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
const mappings = [{ from: "../old.ts", to: "./destination.ts" }];
const expected = source.replace(
	/(from |import\()["'`]\.\.\/old\.ts["'`]/g,
	(match) => match.replace("../old.ts", "./destination.ts"),
);

interface FidelityFixture {
	root: string;
	manifest: CopyManifest;
	dispose: () => void;
}

function fixture(): FidelityFixture {
	const root = mkdtempSync(join(tmpdir(), "maestro-fidelity-"));
	mkdirSync(join(root, "provenance"));
	writeFileSync(
		join(root, "provenance/inventory.json"),
		JSON.stringify({ production: [] }),
	);
	writeFileSync(
		join(root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: "a".repeat(40),
			files: [{ path: "original.ts", blob: gitBlob(Buffer.from(source)) }],
		}),
	);
	writeFileSync(join(root, "original.ts"), source);
	writeFileSync(join(root, "destination.ts"), expected);
	return {
		root,
		manifest: {
			base_main_sha: "a".repeat(40),
			copy_sha: "a".repeat(40),
			mappings: mappings.map((mapping) => ({ ...mapping })),
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
	assert(expected.includes("import(`./destination.ts`)"));
	assert.equal(normalizeImports(source, "original.ts", []), source);
});

test("declaration imports and CRLF/unicode text stay byte-preserving", () => {
	const text = '// café\r\nexport type T = import("../old.ts").T;\r\n';
	assert.equal(
		normalizeImports(text, "entry.d.ts", mappings),
		text.replace("../old.ts", "./destination.ts"),
	);
});

test("non-code assets are compared as bytes, never normalized", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const bytes = Buffer.from([0, 255, 13, 10, 128]);
	f.manifest.mappings = [];
	writeFileSync(
		join(f.root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: f.manifest.copy_sha,
			files: [{ path: "source.bin", blob: gitBlob(bytes) }],
		}),
	);
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
	["unlisted specifier", expected.replace("./destination.ts", "other")],
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
	f.manifest.mappings = [];
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

test("rejects unused mappings and mappings to new rather than copied files", (t) => {
	const f = fixture();
	t.after(f.dispose);
	f.manifest.mappings.push({ from: "unused", to: "./destination.ts" });
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/Unused import mapping/,
	);
	f.manifest.mappings = [{ from: "../old.ts", to: "./facade.ts" }];
	writeFileSync(join(f.root, "facade.ts"), "export {};");
	f.manifest.entries.push({
		kind: "new",
		destination: "facade.ts",
		reason: "fixture",
	});
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/not a copy destination/,
	);
});

test("rejects renamed new files with upstream bytes and unclassified splits", (t) => {
	const f = fixture();
	t.after(f.dispose);
	f.manifest.mappings = [];
	writeFileSync(join(f.root, "destination.ts"), source);
	f.manifest.entries = [
		{ kind: "new", destination: "destination.ts", reason: "renamed" },
	];
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /upstream origin/);
	const entry = {
		kind: "copy",
		source: "original.ts",
		destination: "destination.ts",
		blob: gitBlob(Buffer.from(source)),
		archive: "original.ts",
	} as const;
	f.manifest.entries = [entry];
	writeFileSync(
		join(f.root, "provenance/inventory.json"),
		JSON.stringify({ production: [{ source: "original.ts", fate: "split" }] }),
	);
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/split classification/,
	);
	f.manifest.entries = [{ ...entry, classification: "split" }];
	assert.equal(checkCopyFidelity(f.manifest, f.root), 1);
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
	writeFileSync(
		join(f.root, "provenance/upstream-tree.json"),
		JSON.stringify({
			copy_sha: f.manifest.copy_sha,
			files: [{ path: "original.ts", blob: gitBlob(Buffer.from(source)) }],
		}),
	);
	assert.equal(checkCopyFidelity(f.manifest, f.root, f.root), 1);
	writeFileSync(join(f.root, "original.ts"), "tampered");
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root, f.root),
		/Archive differs/,
	);
	assert.equal(readFileSync(join(f.root, "destination.ts"), "utf8"), expected);
});

test("an owned change after H2 must match its recorded blob and keep its pin", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const entry = f.manifest.entries[0];
	assert(entry.kind === "copy");
	const fixed = `${expected}// #149 fix\n`;
	writeFileSync(join(f.root, "destination.ts"), fixed);
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /Copy differs/);
	entry.owned_change = { reason: "#149", blob: gitBlob(Buffer.from(fixed)) };
	assert.equal(checkCopyFidelity(f.manifest, f.root), 1);
	// Any further edit is unrecorded, and the pinned original is still verified.
	writeFileSync(join(f.root, "destination.ts"), `${fixed}// more\n`);
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/Unrecorded change/,
	);
	writeFileSync(join(f.root, "destination.ts"), fixed);
	writeFileSync(join(f.root, "original.ts"), `${source}// drift\n`);
	assert.throws(() => checkCopyFidelity(f.manifest, f.root), /Blob mismatch/);
	writeFileSync(join(f.root, "original.ts"), source);
	// A record on an unchanged copy is stale.
	writeFileSync(join(f.root, "destination.ts"), expected);
	entry.owned_change = { reason: "#149", blob: gitBlob(Buffer.from(expected)) };
	assert.throws(
		() => checkCopyFidelity(f.manifest, f.root),
		/Stale owned change/,
	);
});
