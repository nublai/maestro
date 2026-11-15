import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function scan(path: string): void {
	if (!existsSync(path)) return;
	if (path.endsWith(".js") || path.endsWith(".ts")) {
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		function visit(node: ts.Node): void {
			let specifier: ts.Node | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
				specifier = node.moduleSpecifier;
			if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
				specifier = node.argument.literal;
			if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword
			)
				specifier = node.arguments[0];
			if (specifier && ts.isStringLiteral(specifier)) {
				assert(
					!/pi-herdr-agents|surfaces\/herdr|@earendil-works\/pi-tui|^effect(?:\/|$)/.test(
						specifier.text,
					),
					`Forbidden import in ${path}: ${specifier.text}`,
				);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		return;
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.isDirectory() || /\.[cm]?[jt]s$/.test(entry.name))
			scan(join(path, entry.name));
	}
}
assert(existsSync("dist/index.js"), "Build before checking emitted boundaries");
for (const path of ["index.js", "maestro", "pi-extension", "dist"]) scan(path);
console.log("Source and emitted imports satisfy package boundaries.");
