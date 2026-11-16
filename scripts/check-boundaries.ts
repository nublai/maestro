import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function checkBoundaryText(text: string, path: string): void {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	const factories = new Set(["createRequire"]);
	const requires = new Set(["require"]);
	function collect(node: ts.Node): void {
		if (
			ts.isImportSpecifier(node) &&
			(node.propertyName ?? node.name).text === "createRequire"
		)
			factories.add(node.name.text);
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			isRequireFactory(node.initializer.expression)
		)
			requires.add(node.name.text);
		ts.forEachChild(node, collect);
	}
	collect(source);
	function isRequireFactory(node: ts.Expression): boolean {
		return ts.isIdentifier(node)
			? factories.has(node.text)
			: ts.isPropertyAccessExpression(node) &&
					node.name.text === "createRequire";
	}
	function visit(node: ts.Node): void {
		let specifier: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			specifier = node.moduleSpecifier;
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			specifier = node.argument.literal;
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (
				callee.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(callee) && requires.has(callee.text)) ||
				isRequireFactory(callee) ||
				(ts.isCallExpression(callee) && isRequireFactory(callee.expression)) ||
				(ts.isPropertyAccessExpression(callee) &&
					callee.name.text === "resolve" &&
					ts.isMetaProperty(callee.expression) &&
					callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword)
			)
				specifier = node.arguments[0];
		}
		if (specifier && ts.isStringLiteralLike(specifier))
			assert(
				!/pi-herdr-agents|surfaces\/herdr|@earendil-works\/pi-tui|^effect(?:\/|$)/.test(
					specifier.text,
				),
				`Forbidden import in ${path}: ${specifier.text}`,
			);
		ts.forEachChild(node, visit);
	}
	visit(source);
}

/** Follow both runtime and type edges from the lean facade, not the Pi-aware runtime barrel. */
export function checkEngineClosure(
	path: string,
	seen = new Set<string>(),
): void {
	const absolute = resolve(path);
	if (seen.has(absolute)) return;
	seen.add(absolute);
	const text = readFileSync(absolute, "utf8");
	for (const entry of ts.preProcessFile(text, true, true).importedFiles) {
		const specifier = entry.fileName;
		assert(
			!/^@earendil-works\/pi-|^@sinclair\/typebox|pi-extension|adapters\/pi|runtime\/pi-/.test(
				specifier,
			),
			`Pi dependency in engine closure: ${path} -> ${specifier}`,
		);
		if (specifier.startsWith("."))
			checkEngineClosure(resolve(dirname(absolute), specifier), seen);
	}
}

/**
 * The protocol-only child entry loads child protocol dependencies only: never
 * the parent runtime/launch composition, a provider or the tool surface (§2.4).
 */
export function checkChildClosure(
	path: string,
	seen = new Set<string>(),
): void {
	const absolute = resolve(path);
	if (seen.has(absolute)) return;
	seen.add(absolute);
	const text = readFileSync(absolute, "utf8");
	for (const entry of ts.preProcessFile(text, true, true).importedFiles) {
		const specifier = entry.fileName;
		assert(
			!/pi-extension|\/runtime\/|^\.\.?\/runtime\/|pi-harness-adapter|\/launch|^\.\/launch|surfaces\/|@earendil-works\/pi-tui/.test(
				specifier,
			),
			`Parent/provider dependency in child closure: ${path} -> ${specifier}`,
		);
		if (specifier.startsWith("."))
			checkChildClosure(resolve(dirname(absolute), specifier), seen);
	}
}

export function scan(path: string): void {
	if (!existsSync(path)) return;
	if (/\.[cm]?[jt]sx?$/.test(path)) {
		checkBoundaryText(readFileSync(path, "utf8"), path);
		return;
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.isDirectory() || /\.[cm]?[jt]sx?$/.test(entry.name))
			scan(join(path, entry.name));
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	assert(
		existsSync("dist/maestro/engine.js"),
		"Build before checking emitted boundaries",
	);
	for (const path of ["maestro", "pi-extension", "dist"]) scan(path);
	// The package root (".") is the engine entry.
	for (const path of ["maestro/engine.ts", "dist/maestro/engine.js"])
		checkEngineClosure(path);
	for (const path of [
		"maestro/adapters/pi/child/entry.ts",
		"dist/maestro/adapters/pi/child/entry.js",
		"maestro/pi/child.ts",
		"dist/maestro/pi/child.js",
	])
		checkChildClosure(path);
	console.log(
		"Source/emitted package boundaries, transitive Pi-free root/engine closures and the protocol-only child closure: passed.",
	);
}
