import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { gitBlob } from "./check-copy-fidelity.ts";

export interface SourceRange {
	start: number;
	end: number;
	line?: number;
}
export interface TestMigration {
	source: string;
	destination: string;
	archive: string;
	blob: string;
	whole?: boolean;
	selections: SourceRange[];
	helpers: SourceRange[];
}
export interface TestMigrationMap {
	copy_sha: string;
	files: TestMigration[];
	import_mappings?: { from: string; to: string }[];
}

/** Ignore only lexical trivia in tests: literal contents and assertion tokens remain exact. */
export function tokens(text: string): string {
	const source = ts.createSourceFile(
		"test.ts",
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const result: string[] = [];
	function visit(node: ts.Node): void {
		const children = node.getChildren(source);
		if (children.length) for (const child of children) visit(child);
		else if (node.kind !== ts.SyntaxKind.EndOfFileToken)
			result.push(node.getText(source));
	}
	visit(source);
	return JSON.stringify(result);
}

export function checkTestMigration(root: string): TestMigrationMap {
	let map: TestMigrationMap;
	let tree: { copy_sha: string; files: { path: string; blob: string }[] };
	try {
		map = JSON.parse(
			readFileSync(resolve(root, "provenance/m2-test-map.json"), "utf8"),
		);
		tree = JSON.parse(
			readFileSync(resolve(root, "provenance/upstream-tree.json"), "utf8"),
		);
	} catch (cause) {
		throw new Error("Cannot read pinned test migration provenance", { cause });
	}
	assert.equal(map.copy_sha, tree.copy_sha);
	for (const entry of map.files) {
		const bytes = readFileSync(resolve(root, entry.archive));
		assert.equal(gitBlob(bytes), entry.blob, entry.source);
		assert.equal(
			tree.files.find((file) => file.path === entry.source)?.blob,
			entry.blob,
			entry.source,
		);
		const original = bytes.toString("utf8");
		const migrated = readFileSync(resolve(root, entry.destination), "utf8");
		const parsed = ts.createSourceFile(
			entry.destination,
			migrated,
			ts.ScriptTarget.Latest,
			true,
		);
		const source = ts.createSourceFile(
			entry.source,
			original,
			ts.ScriptTarget.Latest,
			true,
		);
		function bindings(file: ts.SourceFile, rewrite: boolean): string[] {
			return file.statements.filter(ts.isImportDeclaration).flatMap((node) => {
				assert(ts.isStringLiteral(node.moduleSpecifier));
				const specifier = node.moduleSpecifier.text;
				const target = rewrite
					? (map.import_mappings?.find((mapping) => mapping.from === specifier)
							?.to ?? specifier)
					: specifier;
				const clause = node.importClause;
				const names: string[] = [];
				if (!clause) names.push("side-effect");
				if (clause?.name) names.push(`default:${clause.name.text}`);
				if (clause?.namedBindings) {
					if (ts.isNamespaceImport(clause.namedBindings))
						names.push(`namespace:${clause.namedBindings.name.text}`);
					else
						for (const binding of clause.namedBindings.elements)
							names.push(
								`${(binding.propertyName ?? binding.name).text}:${binding.name.text}`,
							);
				}
				return names.map((name) => JSON.stringify([target, name]));
			});
		}
		const allowedImports = new Set(bindings(source, true));
		// The original isolated-agent-dir helper imports this same environment cleaner first.
		if (original.includes('import "../isolated-agent-dir.ts";'))
			allowedImports.add(
				JSON.stringify(["../clean-host-env.ts", "side-effect"]),
			);
		for (const binding of bindings(parsed, false))
			assert(
				allowedImports.has(binding),
				`Unmapped test import: ${entry.destination} ${binding}`,
			);
		const statements = new Set<string>();
		function visit(node: ts.Node) {
			if (ts.isStatement(node) && !ts.isImportDeclaration(node))
				statements.add(tokens(node.getText(parsed)));
			ts.forEachChild(node, visit);
		}
		visit(parsed);
		for (const range of [...entry.selections, ...entry.helpers]) {
			assert(
				range.start >= 0 &&
					range.end > range.start &&
					range.end <= original.length,
			);
			assert(
				statements.has(tokens(original.slice(range.start, range.end))),
				`Changed or missing test/helper body: ${entry.source}:${range.line ?? range.start} -> ${entry.destination}`,
			);
		}
		if (entry.whole)
			assert.deepEqual(
				parsed.statements
					.filter((n) => !ts.isImportDeclaration(n))
					.map((n) => tokens(n.getText(parsed))),
				entry.selections.map((range) =>
					tokens(original.slice(range.start, range.end)),
				),
				`Changed whole-file test body: ${entry.source}`,
			);
	}
	return map;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const map = checkTestMigration(
		fileURLToPath(new URL("../", import.meta.url)),
	);
	console.log(
		`Migrated assertion/helper token fidelity: ${map.files.length} source files verified against pinned blobs.`,
	);
}
