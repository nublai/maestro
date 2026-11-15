import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import ts from "typescript";

const CopyEntry = Type.Object(
	{
		kind: Type.Literal("copy"),
		source: Type.String(),
		destination: Type.String(),
		blob: Type.String({ pattern: "^[a-f0-9]{40}$" }),
		archive: Type.Optional(Type.String()),
		classification: Type.Optional(Type.Literal("split")),
	},
	{ additionalProperties: false },
);
const NewEntry = Type.Object(
	{
		kind: Type.Literal("new"),
		destination: Type.String(),
		reason: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const Manifest = Type.Object({
	base_main_sha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	copy_sha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	mappings: Type.Array(
		Type.Object({
			from: Type.String(),
			to: Type.String(),
			source: Type.Optional(Type.String()),
		}),
	),
	entries: Type.Array(Type.Union([CopyEntry, NewEntry])),
});
export type CopyManifest = Static<typeof Manifest>;

export function readManifest(path: string | URL): CopyManifest {
	try {
		const input: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Value.Check(Manifest, input))
			throw new Error("Copy manifest schema mismatch");
		return input;
	} catch (cause) {
		throw new Error(`Invalid copy manifest: ${path}`, { cause });
	}
}

/** Change only AST-identified module specifier contents, never printed AST text. */
export function normalizeImports(
	text: string,
	file: string,
	mappings: CopyManifest["mappings"],
	onMapping?: (mapping: CopyManifest["mappings"][number]) => void,
): string {
	if (!/\.[cm]?[jt]sx?$/.test(file)) return text;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	// Syntactic diagnostics do not emit or resolve imports (and support .d.ts).
	const diagnostics = ts
		.createProgram([], { noLib: true, noResolve: true })
		.getSyntacticDiagnostics(source);
	if (
		diagnostics.some(
			(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
		)
	) {
		throw new Error(`Cannot parse ${file}`);
	}
	const replacements: { start: number; end: number; value: string }[] = [];
	const mapping = new Map<string, CopyManifest["mappings"][number]>();
	for (const entry of mappings) {
		if (entry.source && entry.source !== file) continue;
		if (mapping.has(entry.from))
			throw new Error(`Duplicate import mapping: ${entry.from}`);
		mapping.set(entry.from, entry);
	}
	function specifier(node: ts.Node | undefined): void {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const entry = mapping.get(node.text);
		if (entry === undefined) return;
		onMapping?.(entry);
		const replacement = entry.to;
		const start = node.getStart(source) + 1;
		const quote = text[start - 1];
		const value = JSON.stringify(replacement)
			.slice(1, -1)
			.replace(/'/g, quote === "'" ? "\\'" : "'")
			.replace(/`/g, quote === "`" ? "\\`" : "`")
			.replace(/\$\{/g, quote === "`" ? "\\${" : "${");
		replacements.push({ start, end: node.getEnd() - 1, value });
	}
	function visit(node: ts.Node): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			specifier(node.moduleSpecifier);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			specifier(node.argument.literal);
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		)
			specifier(node.arguments[0]);
		ts.forEachChild(node, visit);
	}
	visit(source);
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		text =
			text.slice(0, replacement.start) +
			replacement.value +
			text.slice(replacement.end);
	}
	return text;
}

export function gitBlob(bytes: Buffer): string {
	return createHash("sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

function readJson<T extends TSchema>(path: string, schema: T): Static<T> {
	try {
		const input: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Value.Check(schema, input)) throw new Error("Schema mismatch");
		return input;
	} catch (cause) {
		throw new Error(`Invalid provenance JSON: ${path}`, { cause });
	}
}

const TreeSchema = Type.Object({
	copy_sha: Type.String(),
	files: Type.Array(Type.Object({ path: Type.String(), blob: Type.String() })),
});
const InventorySchema = Type.Object({
	production: Type.Array(
		Type.Object({ source: Type.String(), fate: Type.String() }),
	),
	support: Type.Optional(
		Type.Array(Type.Object({ source: Type.String(), fate: Type.String() })),
	),
});

interface UpstreamTree {
	copy_sha: string;
	files: { path: string; blob: string }[];
}
interface Inventory {
	production: { source: string; fate: string }[];
	support?: { source: string; fate: string }[];
}

function filesUnder(root: string, directory: string): string[] {
	const path = resolve(root, directory);
	if (!existsSync(path)) return [];
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(root, file) : [file];
	});
}

export function checkCopyFidelity(
	manifest: CopyManifest,
	root: string,
	upstream?: string,
): number {
	const tree: UpstreamTree = readJson(
		resolve(root, "provenance/upstream-tree.json"),
		TreeSchema,
	);
	if (tree.copy_sha !== manifest.copy_sha)
		throw new Error("Upstream tree pin mismatch");
	const upstreamPaths = new Map(
		tree.files.map((file) => [file.path, file.blob]),
	);
	const upstreamBlobs = new Set(tree.files.map((file) => file.blob));
	if (upstream) {
		const actual = execFileSync(
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
		if (JSON.stringify(actual) !== JSON.stringify(tree.files))
			throw new Error("Upstream tree differs from pin");
	}
	const inventory: Inventory = readJson(
		resolve(root, "provenance/inventory.json"),
		InventorySchema,
	);
	const moving = new Map(
		[...inventory.production, ...(inventory.support ?? [])]
			.filter((entry) => entry.fate === "move" || entry.fate === "split")
			.map((entry) => [entry.source, entry.fate]),
	);
	const destinations = new Set<string>();
	for (const entry of manifest.entries) {
		if (
			posix.normalize(entry.destination) !== entry.destination ||
			entry.destination.startsWith("../") ||
			posix.isAbsolute(entry.destination)
		)
			throw new Error(`Invalid destination: ${entry.destination}`);
		if (destinations.has(entry.destination))
			throw new Error(`Duplicate destination: ${entry.destination}`);
		destinations.add(entry.destination);
	}
	for (const file of [
		...filesUnder(root, "maestro"),
		...filesUnder(root, "pi-extension"),
	]) {
		if (!destinations.has(file))
			throw new Error(`Unlisted destination: ${file}`);
	}
	const copyDestinations = new Set(
		manifest.entries
			.filter((entry) => entry.kind === "copy")
			.map((entry) => entry.destination),
	);
	const used = new Set<CopyManifest["mappings"][number]>();
	let copies = 0;
	for (const entry of manifest.entries) {
		const destination = readFileSync(resolve(root, entry.destination));
		if (entry.kind === "new") {
			if (
				upstreamPaths.has(entry.destination) ||
				moving.has(entry.destination) ||
				upstreamBlobs.has(gitBlob(destination))
			)
				throw new Error(`New file has upstream origin: ${entry.destination}`);
			continue;
		}
		if (upstreamPaths.get(entry.source) !== entry.blob)
			throw new Error(`Source not in pinned upstream tree: ${entry.source}`);
		if (
			moving.get(entry.source) === "split" &&
			entry.classification !== "split"
		)
			throw new Error(`Missing split classification: ${entry.source}`);
		let original: Buffer;
		if (upstream) {
			original = execFileSync("git", [
				"-C",
				upstream,
				"show",
				`${manifest.copy_sha}:${entry.source}`,
			]);
			if (
				entry.archive &&
				!original.equals(readFileSync(resolve(root, entry.archive)))
			) {
				throw new Error(`Archive differs from upstream: ${entry.source}`);
			}
		} else {
			if (!entry.archive)
				throw new Error(`No upstream repository or archive: ${entry.source}`);
			original = readFileSync(resolve(root, entry.archive));
		}
		if (gitBlob(original) !== entry.blob)
			throw new Error(`Blob mismatch: ${entry.source}`);
		const expected = /\.[cm]?[jt]sx?$/.test(entry.source)
			? Buffer.from(
					normalizeImports(
						original.toString("utf8"),
						entry.source,
						manifest.mappings,
						(mapping) => {
							const target = posix.normalize(
								posix.join(posix.dirname(entry.destination), mapping.to),
							);
							// Relative emitted .js imports may address copied .ts source files.
							const candidates = [
								target,
								target.replace(/\.js$/, ".ts"),
								target.replace(/\.mjs$/, ".mts"),
								target.replace(/\.cjs$/, ".cts"),
							];
							if (
								!mapping.to.startsWith(".") ||
								!candidates.some((path) => copyDestinations.has(path))
							)
								throw new Error(
									`Mapping target is not a copy destination: ${mapping.to}`,
								);
							used.add(mapping);
						},
					),
				)
			: original;
		// Parse the destination too, but never normalize an undeclared destination rewrite away.
		normalizeImports(destination.toString("utf8"), entry.destination, []);
		if (!expected.equals(destination))
			throw new Error(`Copy differs: ${entry.destination}`);
		copies++;
	}
	for (const mapping of manifest.mappings) {
		if (!used.has(mapping))
			throw new Error(`Unused import mapping: ${mapping.from}`);
	}
	return copies;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const manifest = readManifest(resolve(root, "provenance/copy-manifest.json"));
	const copies = checkCopyFidelity(manifest, root, process.argv[2]);
	console.log(
		`Copy fidelity: ${copies} copied files verified (${manifest.entries.length - copies} new files).`,
	);
}
