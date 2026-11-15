import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
		existsSync("dist/index.js"),
		"Build before checking emitted boundaries",
	);
	for (const path of ["index.js", "maestro", "pi-extension", "dist"])
		scan(path);
	console.log("Source and emitted imports satisfy package boundaries.");
}
