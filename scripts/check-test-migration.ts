import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { gitBlob } from "./check-copy-fidelity.ts";

export interface SourceRange {
	start: number;
	end: number;
	line?: number;
	/** Same text in the identity-baseline blob, when the pinned blob differs. */
	baseline_start?: number;
	baseline_end?: number;
	/** A case added upstream after the identity baseline; its expected titles. */
	added?: boolean;
	/** A baseline case whose body changed upstream (same header and identity). */
	modified?: boolean;
	titles?: string[];
}
export interface TestMigration {
	source: string;
	destination: string;
	archive: string;
	blob: string;
	whole?: boolean;
	selections: SourceRange[];
	helpers: SourceRange[];
	/** Identity-baseline copy of the source when the pinned blob differs from it. */
	baseline_archive?: string;
	baseline_blob?: string;
	/** Cases deliberately left upstream, by pinned source line. */
	retained?: { line: number; reason: string }[];
}
export interface TestMigrationMap {
	copy_sha: string;
	files: TestMigration[];
	import_mappings?: { from: string; to: string }[];
	/** Revision of the original identity ledger (provenance/baseline). */
	identity_sha?: string;
}

/** Header: the statement's first two lines, which carry its case title. */
export function caseHeader(text: string): string {
	return text.split("\n").slice(0, 2).join("\n");
}

/** The unique baseline statement with the same header, for an upstream-modified case. */
export function baselineStatement(
	baseline: string,
	slice: string,
): { start: number; end: number } | undefined {
	const header = caseHeader(slice);
	const file = ts.createSourceFile(
		"baseline.ts",
		baseline,
		ts.ScriptTarget.Latest,
		true,
	);
	const found: { start: number; end: number }[] = [];
	function visit(node: ts.Node): void {
		if (ts.isStatement(node)) {
			const start = node.getStart(file);
			if (caseHeader(baseline.slice(start, node.getEnd())) === header)
				found.push({ start, end: node.getEnd() });
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found.length === 1 ? found[0] : undefined;
}

/**
 * Locate every selection's exact text in the identity-baseline blob so original
 * identities keep matching after a pin advance. Text absent from the baseline is
 * an upstream addition and must carry its expected titles.
 */
export function anchorEntry(
	root: string,
	entry: TestMigration,
	text: string,
	baseline: Buffer | undefined,
): void {
	if (baseline && gitBlob(baseline) === entry.blob) {
		delete entry.baseline_archive;
		delete entry.baseline_blob;
		for (const range of entry.selections) {
			delete range.baseline_start;
			delete range.baseline_end;
			delete range.added;
			delete range.titles;
		}
		return;
	}
	const original = baseline?.toString("utf8") ?? "";
	if (baseline) {
		entry.baseline_archive = `provenance/baseline/upstream/${entry.source}`;
		entry.baseline_blob = gitBlob(baseline);
		mkdirSync(dirname(resolve(root, entry.baseline_archive)), {
			recursive: true,
		});
		writeFileSync(resolve(root, entry.baseline_archive), baseline);
	}
	let cursor = 0;
	for (const range of entry.selections) {
		const slice = text.slice(range.start, range.end);
		const at =
			original.indexOf(slice, cursor) === -1
				? original.indexOf(slice)
				: original.indexOf(slice, cursor);
		const changed = at === -1 ? baselineStatement(original, slice) : undefined;
		if (changed) {
			range.modified = true;
			range.baseline_start = changed.start;
			range.baseline_end = changed.end;
			cursor = changed.end;
			delete range.added;
			delete range.titles;
			continue;
		}
		delete range.modified;
		if (at === -1) {
			assert(
				range.titles?.length,
				`Post-baseline case needs static titles: ${entry.source}:${range.line}`,
			);
			range.added = true;
			delete range.baseline_start;
			delete range.baseline_end;
			continue;
		}
		range.baseline_start = at;
		range.baseline_end = at + slice.length;
		cursor = range.baseline_end;
		delete range.added;
		delete range.titles;
	}
}

/** Per-step maps; each keeps its own finite import mappings. Later maps are optional. */
export const TEST_MAPS = ["m2-test-map.json", "m3-test-map.json"];

export function readTestMap(path: string): TestMigrationMap {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new Error(`Cannot read test migration map: ${path}`, { cause });
	}
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
	let tree: { copy_sha: string; files: { path: string; blob: string }[] };
	try {
		tree = JSON.parse(
			readFileSync(resolve(root, "provenance/upstream-tree.json"), "utf8"),
		);
	} catch (cause) {
		throw new Error("Cannot read pinned test migration provenance", { cause });
	}
	const maps = TEST_MAPS.filter(
		(name, index) =>
			index === 0 || existsSync(resolve(root, "provenance", name)),
	).map((name) => readTestMap(resolve(root, "provenance", name)));
	const destinations = new Set<string>();
	for (const map of maps) {
		assert.equal(map.copy_sha, tree.copy_sha);
		for (const entry of map.files) {
			assert(
				!destinations.has(entry.destination),
				`Duplicate migrated test destination: ${entry.destination}`,
			);
			destinations.add(entry.destination);
			checkEntry(root, map, tree, entry);
		}
	}
	return { copy_sha: tree.copy_sha, files: maps.flatMap((map) => map.files) };
}

function checkEntry(
	root: string,
	map: TestMigrationMap,
	tree: { copy_sha: string; files: { path: string; blob: string }[] },
	entry: TestMigration,
): void {
	{
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
		if (entry.baseline_archive) {
			const baselineBytes = readFileSync(resolve(root, entry.baseline_archive));
			assert.equal(gitBlob(baselineBytes), entry.baseline_blob, entry.source);
			const baseline = baselineBytes.toString("utf8");
			for (const range of entry.selections) {
				if (range.added) {
					assert(
						range.titles?.length,
						`Added case lacks titles: ${entry.source}`,
					);
					assert.equal(
						baseline.indexOf(original.slice(range.start, range.end)),
						-1,
						`Added case exists in the identity baseline: ${entry.source}:${range.line}`,
					);
					continue;
				}
				assert(
					range.baseline_start !== undefined &&
						range.baseline_end !== undefined,
					`Selection lacks its identity-baseline anchor: ${entry.source}:${range.line}`,
				);
				const before = baseline.slice(range.baseline_start, range.baseline_end);
				const after = original.slice(range.start, range.end);
				if (range.modified)
					assert(
						before !== after && caseHeader(before) === caseHeader(after),
						`Modified-case anchor differs: ${entry.source}:${range.line}`,
					);
				else
					assert.equal(
						before,
						after,
						`Identity-baseline anchor differs: ${entry.source}:${range.line}`,
					);
			}
		} else
			assert(
				entry.selections.every((range) => !range.added),
				`Added case without a baseline archive: ${entry.source}`,
			);
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
