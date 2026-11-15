import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import ts from "typescript";

const CopyEntry = Type.Object({
	kind: Type.Literal("copy"),
	source: Type.String(),
	destination: Type.String(),
	blob: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	archive: Type.Optional(Type.String()),
});
const NewEntry = Type.Object({
	kind: Type.Literal("new"),
	destination: Type.String(),
	reason: Type.String({ minLength: 1 }),
});
const Manifest = Type.Object({
	base_main_sha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	copy_sha: Type.String({ pattern: "^[a-f0-9]{40}$" }),
	mappings: Type.Array(Type.Object({ from: Type.String(), to: Type.String() })),
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
	const mapping = new Map<string, string>();
	for (const entry of mappings) {
		if (mapping.has(entry.from))
			throw new Error(`Duplicate import mapping: ${entry.from}`);
		mapping.set(entry.from, entry.to);
	}
	function specifier(node: ts.Node | undefined): void {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const replacement = mapping.get(node.text);
		if (replacement === undefined) return;
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

export function checkCopyFidelity(
	manifest: CopyManifest,
	root: string,
	upstream?: string,
): number {
	const destinations = new Set<string>();
	let copies = 0;
	for (const entry of manifest.entries) {
		if (destinations.has(entry.destination))
			throw new Error(`Duplicate destination: ${entry.destination}`);
		destinations.add(entry.destination);
		const destination = readFileSync(resolve(root, entry.destination));
		if (entry.kind === "new") continue;
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
					),
				)
			: original;
		// Parse the destination too, but never normalize an undeclared destination rewrite away.
		normalizeImports(destination.toString("utf8"), entry.destination, []);
		if (!expected.equals(destination))
			throw new Error(`Copy differs: ${entry.destination}`);
		copies++;
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
