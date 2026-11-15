import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { gitBlob } from "./check-copy-fidelity.ts";
import {
	anchorEntry,
	readTestMap,
	rewriteResourcePaths,
	TEST_MAPS,
	type SourceRange,
	type TestMigration,
	type TestMigrationMap,
} from "./check-test-migration.ts";

/**
 * Select the test cases of one pinned upstream file whose whole dependency
 * closure (helpers, hooks and imports) already exists in this package, and
 * emit them with their original text. Nothing is rewritten except import
 * specifiers named by the plan's finite mappings and the narrowed import
 * lists. Cases that a previous step already migrated are skipped.
 */
export interface MigrationPlan {
	map: string;
	identity_sha: string;
	import_mappings: { from: string; to: string }[];
	/** Module paths inside dynamic import() arguments (fresh per-load imports). */
	resource_mappings?: { from: string; to: string }[];
	files: {
		source: string;
		destination: string;
		/** Source lines of top-level or nested cases that stay upstream, with reasons. */
		exclude?: { line: number; reason: string }[];
	}[];
}

const TEST_CALLS = new Set(["test", "it"]);
const SUITE_CALLS = new Set(["describe", "suite"]);
const HOOK_CALLS = new Set(["before", "after", "beforeEach", "afterEach"]);

interface Item {
	node: ts.Statement;
	kind: "test" | "suite" | "helper" | "hook";
	declares: string[];
	refs: string[];
	children?: Item[];
	scope: Scope;
	titles: string[];
}
interface Scope {
	parent?: Scope;
	declarations: Map<string, Item>;
}

function callName(node: ts.Node): string | undefined {
	if (!ts.isExpressionStatement(node)) return undefined;
	const call = node.expression;
	if (!ts.isCallExpression(call)) return undefined;
	const callee = ts.isPropertyAccessExpression(call.expression)
		? call.expression.expression
		: call.expression;
	return ts.isIdentifier(callee) ? callee.text : undefined;
}

function containsTest(node: ts.Node): boolean {
	let found = false;
	function visit(child: ts.Node): void {
		const name = callName(child);
		if (name && (TEST_CALLS.has(name) || SUITE_CALLS.has(name))) found = true;
		if (
			ts.isCallExpression(child) &&
			ts.isIdentifier(child.expression) &&
			TEST_CALLS.has(child.expression.text)
		)
			found = true;
		if (!found) ts.forEachChild(child, visit);
	}
	visit(node);
	return found;
}

function declaredNames(node: ts.Statement): string[] {
	const names: string[] = [];
	function binding(name: ts.BindingName): void {
		if (ts.isIdentifier(name)) names.push(name.text);
		else
			for (const element of name.elements)
				if (!ts.isOmittedExpression(element)) binding(element.name);
	}
	if (
		(ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isEnumDeclaration(node)) &&
		node.name
	)
		names.push(node.name.text);
	if (ts.isVariableStatement(node))
		for (const declaration of node.declarationList.declarations)
			binding(declaration.name);
	return names;
}

/** Free names: identifiers used in a statement minus names it declares locally. */
function references(node: ts.Node): string[] {
	const names = new Set<string>();
	const local = new Set<string>();
	function declare(name: ts.BindingName): void {
		if (ts.isIdentifier(name)) local.add(name.text);
		else
			for (const element of name.elements)
				if (!ts.isOmittedExpression(element)) declare(element.name);
	}
	function visit(child: ts.Node): void {
		if (
			(ts.isVariableDeclaration(child) || ts.isParameter(child)) &&
			child !== node
		)
			declare(child.name);
		if (
			(ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) &&
			child !== node &&
			child.name
		)
			local.add(child.name.text);
		if (ts.isIdentifier(child)) {
			const parent = child.parent;
			const isMemberName =
				(ts.isPropertyAccessExpression(parent) && parent.name === child) ||
				(ts.isPropertyAssignment(parent) && parent.name === child) ||
				(ts.isQualifiedName(parent) && parent.right === child) ||
				(ts.isPropertySignature(parent) && parent.name === child) ||
				(ts.isMethodDeclaration(parent) && parent.name === child) ||
				(ts.isPropertyDeclaration(parent) && parent.name === child);
			if (!isMemberName) names.add(child.text);
		}
		ts.forEachChild(child, visit);
	}
	visit(node);
	return [...names].filter((name) => !local.has(name));
}

function suiteBody(node: ts.Statement): ts.Block | undefined {
	if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression))
		return undefined;
	const callback = node.expression.arguments.at(-1);
	if (
		callback &&
		(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
		ts.isBlock(callback.body)
	)
		return callback.body;
	return undefined;
}

function title(node: ts.Statement): string | undefined {
	if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression))
		return undefined;
	const first = node.expression.arguments[0];
	return first && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function build(
	statements: readonly ts.Statement[],
	parent: Scope | undefined,
	titles: string[],
): Item[] {
	const scope: Scope = { parent, declarations: new Map() };
	const items: Item[] = [];
	for (const node of statements) {
		if (ts.isImportDeclaration(node)) continue;
		const name = callName(node);
		const body = suiteBody(node);
		let item: Item;
		if (name && SUITE_CALLS.has(name) && body) {
			const suiteTitles = [...titles, title(node) ?? "<computed>"];
			// The suite call's callee and non-callback arguments; its hooks and cases carry the rest.
			assert(
				ts.isExpressionStatement(node) && ts.isCallExpression(node.expression),
			);
			const call = node.expression;
			item = {
				node,
				kind: "suite",
				declares: [],
				refs: [
					...references(call.expression),
					...call.arguments
						.filter((argument) => argument !== body.parent)
						.flatMap(references),
				],
				scope,
				titles: suiteTitles,
			};
			item.children = build(body.statements, scope, suiteTitles);
		} else if (name && HOOK_CALLS.has(name))
			item = {
				node,
				kind: "hook",
				declares: [],
				refs: references(node),
				scope,
				titles,
			};
		else if (containsTest(node))
			item = {
				node,
				kind: "test",
				declares: [],
				refs: references(node),
				scope,
				titles: [...titles, title(node) ?? "<computed>"],
			};
		else {
			const declares = declaredNames(node);
			item = {
				node,
				kind: declares.length ? "helper" : "hook",
				declares,
				refs: references(node),
				scope,
				titles,
			};
		}
		for (const declared of item.declares)
			scope.declarations.set(declared, item);
		items.push(item);
	}
	return items;
}

function resolveName(name: string, scope: Scope | undefined): Item | undefined {
	for (let current = scope; current; current = current.parent) {
		const found = current.declarations.get(name);
		if (found) return found;
	}
	return undefined;
}

interface Selected {
	text: string;
	count: number;
}
/** A case (or suite prefix) that stays upstream, with why. */
export interface RetainedCase {
	line: number;
	titles: string[];
	reason: string;
}
export interface MigratedFile {
	output: string;
	entry: Omit<TestMigration, "blob" | "archive">;
}

export function migrateFile(
	text: string,
	source: string,
	destination: string,
	root: string,
	mappings: { from: string; to: string }[],
	skipped: SourceRange[],
	exclude: { line: number; reason: string }[],
	resourceMappings: { from: string; to: string }[] = [],
	retained: RetainedCase[] = [],
): MigratedFile {
	const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
	const lineOf = (node: ts.Node) =>
		file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
	const imports = new Map<
		string,
		{ declaration: ts.ImportDeclaration; allowed: boolean }
	>();
	const importDeclarations = file.statements.filter(ts.isImportDeclaration);
	for (const declaration of importDeclarations) {
		assert(ts.isStringLiteral(declaration.moduleSpecifier));
		const original = declaration.moduleSpecifier.text;
		const specifier =
			mappings.find((mapping) => mapping.from === original)?.to ?? original;
		const allowed =
			!specifier.startsWith(".") ||
			existsSync(
				resolve(root, posix.join(posix.dirname(destination), specifier)),
			);
		const clause = declaration.importClause;
		const names: string[] = [];
		if (clause?.name) names.push(clause.name.text);
		if (clause?.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings))
				names.push(clause.namedBindings.name.text);
			else
				for (const element of clause.namedBindings.elements)
					names.push(element.name.text);
		}
		for (const name of names) imports.set(name, { declaration, allowed });
	}
	const items = build(file.statements, undefined, []);
	const excluded = new Set(exclude.map((entry) => entry.line));
	const exclusionReason = new Map(
		exclude.map((entry) => [entry.line, entry.reason]),
	);
	const whyOf = new Map<Item, string[]>();
	/** Unavailable imports (with specifiers) and resource paths behind a taint. */
	const rootsOf = new Map<Item, Set<string>>();
	const explain = (items: Item[]) => {
		const direct = new Set(items.flatMap((item) => whyOf.get(item) ?? []));
		const roots = new Set(
			items.flatMap((item) => [...(rootsOf.get(item) ?? [])]),
		);
		return `${[...direct].join(", ")} (unavailable here: ${[...roots].sort().join("; ")})`;
	};
	const isSkipped = (node: ts.Node) =>
		skipped.some(
			(range) =>
				range.start === node.getStart(file) && range.end === node.getEnd(),
		);
	const taint = new Map<Item, boolean>();
	/** A literal module/resource path (computed import, spawn URL, file read) absent here. */
	function missingPath(node: ts.Node): string | undefined {
		let missing: string | undefined;
		function visit(child: ts.Node): void {
			// Plain literals and template heads such as `../x.ts?reload-${n}`.
			const text = ts.isStringLiteralLike(child)
				? child.text
				: ts.isTemplateExpression(child)
					? child.head.text
					: undefined;
			const literal = text?.split("?")[0];
			const path =
				resourceMappings.find((mapping) => mapping.from === literal)?.to ??
				literal;
			if (
				path &&
				/^\.\.?\/.*\.[cm]?[jt]s$/.test(path) &&
				!existsSync(resolve(root, posix.join(posix.dirname(destination), path)))
			)
				missing = path;
			if (!missing) ts.forEachChild(child, visit);
		}
		visit(node);
		return missing;
	}
	function tainted(item: Item): boolean {
		const known = taint.get(item);
		if (known !== undefined) return known;
		taint.set(item, false);
		const missing = item.kind !== "suite" ? missingPath(item.node) : undefined;
		let result = missing !== undefined;
		const why: string[] = result ? ["missing resource path"] : [];
		const roots = new Set<string>(missing ? [`resource ${missing}`] : []);
		for (const name of item.refs) {
			const declaration = resolveName(name, item.scope);
			if (declaration && declaration !== item) {
				if (tainted(declaration)) {
					result = true;
					why.push(`helper ${name}`);
					for (const root of rootsOf.get(declaration) ?? []) roots.add(root);
				}
			} else if (!declaration && imports.get(name)?.allowed === false) {
				result = true;
				why.push(`import ${name}`);
				const declaration = imports.get(name)?.declaration;
				assert(declaration && ts.isStringLiteral(declaration.moduleSpecifier));
				roots.add(`${name} from ${declaration.moduleSpecifier.text}`);
			}
		}
		taint.set(item, result);
		whyOf.set(item, why);
		rootsOf.set(item, roots);
		if (result && process.env.MIGRATE_EXPLAIN && item.kind === "test")
			console.error(
				`${source}:${lineOf(item.node)} retained: ${why.join(", ")}`,
			);
		return result;
	}
	const needed = new Set<Item>();
	const neededImports = new Set<string>();
	function need(item: Item): void {
		if (needed.has(item)) return;
		needed.add(item);
		for (const name of item.refs) {
			const declaration = resolveName(name, item.scope);
			if (declaration && declaration !== item) need(declaration);
			else if (!declaration && imports.has(name)) neededImports.add(name);
		}
	}
	const selections: SourceRange[] = [];
	const helpers: SourceRange[] = [];
	function range(item: Item): SourceRange {
		const result: SourceRange = {
			start: item.node.getStart(file),
			end: item.node.getEnd(),
			line: lineOf(item.node),
		};
		if (item.kind === "test" && !item.titles.includes("<computed>"))
			result.titles = item.titles;
		return result;
	}
	/** Returns emitted text for the items selected from one statement list. */
	function select(list: Item[]): Selected {
		const hooks = list.filter((item) => item.kind === "hook");
		const hooksTainted = hooks.some(tainted);
		const chosen = new Set<Item>();
		for (const item of list) {
			if (item.kind === "test") {
				if (
					!hooksTainted &&
					!isSkipped(item.node) &&
					!excluded.has(lineOf(item.node)) &&
					!tainted(item)
				)
					chosen.add(item);
			}
		}
		const taintedHooks = hooks.filter(tainted);
		for (const item of list) {
			const line = lineOf(item.node);
			const keep = (reason: string) =>
				retained.push({ line, titles: item.titles, reason });
			if (item.kind !== "test" && item.kind !== "suite") continue;
			if (excluded.has(line)) keep(`excluded: ${exclusionReason.get(line)}`);
			else if (hooksTainted) keep(`suite hooks need ${explain(taintedHooks)}`);
			else if (
				item.kind === "test" &&
				!chosen.has(item) &&
				!isSkipped(item.node)
			)
				keep(`needs ${explain([item])}`);
		}
		const suites = new Map<Item, string>();
		for (const item of list)
			if (item.kind === "suite" && !excluded.has(lineOf(item.node))) {
				const inner = hooksTainted
					? { text: "", count: 0 }
					: select(item.children ?? []);
				if (inner.count) suites.set(item, inner.text);
			}
		if (!chosen.size && !suites.size) return { text: "", count: 0 };
		for (const item of chosen) need(item);
		for (const item of suites.keys()) need(item);
		for (const hook of hooks) need(hook);
		// Helpers needed transitively by this list's chosen cases and nested suites.
		let text = "";
		let count = chosen.size;
		for (const item of list) {
			const leading = text ? "\n\n" : "";
			if (chosen.has(item)) {
				selections.push(range(item));
				text += leading + item.node.getText(file);
			} else if (suites.has(item)) {
				const body = suiteBody(item.node);
				assert(body);
				const inner = suites.get(item) ?? "";
				const whole =
					inner ===
					body.statements
						.map((statement) => statement.getText(file))
						.join("\n\n");
				count++;
				text +=
					leading +
					(whole
						? item.node.getText(file)
						: text.slice(0, 0) +
							file.text.slice(
								item.node.getStart(file),
								body.getStart(file) + 1,
							) +
							"\n" +
							inner +
							"\n" +
							file.text.slice(
								(body.statements.at(-1) ?? body).getEnd(),
								item.node.getEnd(),
							));
			} else if (item.kind === "hook" || needed.has(item)) {
				helpers.push(range(item));
				text += leading + item.node.getText(file);
			}
		}
		return { text, count };
	}
	// Two passes: the first marks needed helpers, the second emits in source order.
	select(items);
	selections.length = 0;
	helpers.length = 0;
	retained.length = 0;
	const body = select(items);
	assert(body.count, `No migratable cases in ${source}`);
	const emitted: string[] = [];
	for (const declaration of importDeclarations) {
		assert(ts.isStringLiteral(declaration.moduleSpecifier));
		const original = declaration.moduleSpecifier.text;
		const specifier =
			mappings.find((mapping) => mapping.from === original)?.to ?? original;
		const clause = declaration.importClause;
		if (!clause) {
			emitted.push(`import ${JSON.stringify(specifier)};`);
			continue;
		}
		const parts: string[] = [];
		if (clause.name && neededImports.has(clause.name.text))
			parts.push(clause.name.text);
		const named: string[] = [];
		if (clause.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				if (neededImports.has(clause.namedBindings.name.text))
					parts.push(`* as ${clause.namedBindings.name.text}`);
			} else
				for (const element of clause.namedBindings.elements)
					if (neededImports.has(element.name.text))
						named.push(element.getText(file));
		}
		if (named.length) parts.push(`{ ${named.join(", ")} }`);
		if (!parts.length) continue;
		assert(
			imports.get(clause.name?.text ?? "")?.allowed !== false &&
				[...neededImports].every(
					(name) =>
						imports.get(name)?.declaration !== declaration ||
						imports.get(name)?.allowed,
				),
			`Needed import is unavailable: ${original}`,
		);
		emitted.push(
			`import ${clause.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${JSON.stringify(specifier)};`,
		);
	}
	const topLevel = file.statements.filter(
		(statement) => !ts.isImportDeclaration(statement),
	);
	const whole =
		selections.length + helpers.length > 0 &&
		topLevel.every(
			(statement) =>
				selections.some((r) => r.start === statement.getStart(file)) ||
				helpers.some((r) => r.start === statement.getStart(file)),
		);
	const entry: Omit<TestMigration, "blob" | "archive"> = whole
		? {
				source,
				destination,
				whole: true,
				selections: items.map(range),
				helpers: [],
			}
		: { source, destination, selections, helpers };
	return {
		output: `${emitted.join("\n")}\n\n${rewriteResourcePaths(body.text, resourceMappings)}\n`,
		entry,
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [planPath, upstream] = process.argv.slice(2);
	assert(planPath && upstream, "Usage: migrate-tests.ts <plan> <upstream>");
	const root = fileURLToPath(new URL("../", import.meta.url));
	let plan: MigrationPlan;
	try {
		plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
	} catch (cause) {
		throw new Error(`Cannot read migration plan: ${planPath}`, { cause });
	}
	let tree: { copy_sha: string };
	try {
		tree = JSON.parse(
			readFileSync(resolve(root, "provenance/upstream-tree.json"), "utf8"),
		);
	} catch (cause) {
		throw new Error("Cannot read pinned upstream tree", { cause });
	}
	const earlier = TEST_MAPS.filter((name) => name !== plan.map)
		.filter((name) => existsSync(resolve(root, "provenance", name)))
		.flatMap((name) => readTestMap(resolve(root, "provenance", name)).files);
	const show = (sha: string, path: string): Buffer | undefined => {
		try {
			return execFileSync("git", ["-C", upstream, "show", `${sha}:${path}`], {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return undefined;
		}
	};
	const map: TestMigrationMap = {
		copy_sha: tree.copy_sha,
		identity_sha: plan.identity_sha,
		import_mappings: plan.import_mappings,
		files: [],
	};
	if (plan.resource_mappings) map.resource_mappings = plan.resource_mappings;
	for (const spec of plan.files) {
		const bytes = show(tree.copy_sha, spec.source);
		assert(bytes, `Missing pinned source: ${spec.source}`);
		const text = bytes.toString("utf8");
		const skipped = earlier
			.filter((entry) => entry.source === spec.source)
			.flatMap((entry) => entry.selections);
		const { output, entry } = migrateFile(
			text,
			spec.source,
			spec.destination,
			root,
			plan.import_mappings,
			skipped,
			spec.exclude ?? [],
			plan.resource_mappings,
		);
		const archive = `provenance/upstream/${spec.source}`;
		mkdirSync(dirname(resolve(root, archive)), { recursive: true });
		writeFileSync(resolve(root, archive), bytes);
		writeFileSync(resolve(root, spec.destination), output);
		const full: TestMigration = { ...entry, archive, blob: gitBlob(bytes) };
		if (spec.exclude?.length) full.retained = spec.exclude;
		anchorEntry(root, full, text, show(plan.identity_sha, spec.source));
		map.files.push(full);
		console.log(
			`${spec.source} -> ${spec.destination}: ${entry.selections.length} selections${entry.whole ? " (whole)" : ""}`,
		);
	}
	writeFileSync(
		resolve(root, "provenance", plan.map),
		JSON.stringify(map, null, "\t") + "\n",
	);
}
