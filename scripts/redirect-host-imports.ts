import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readManifest } from "./check-copy-fidelity.ts";

/**
 * Local H2 helper (plan §3, "Retained modules replace relative moving imports
 * with the mapped package subpaths"). In a pi-herdr-agents checkout, rewrite
 * every static import, re-export, import type and literal dynamic import that
 * resolves to a moved module into its `@nubl/maestro/<subpath>` export. The
 * local copies of moved modules are left untouched (H2 proves nothing loads
 * them before the reviewed switch deletes them). Fails on a moved target
 * without an export, and on a query-suffixed import of a moved module, which a
 * bare package specifier cannot express.
 */
export interface HostRedirect {
	/** Files rewritten. */
	files: number;
	/** Rewritten specifier count per package subpath. */
	rewrites: Map<string, number>;
}

export function redirectHostImports(
	maestro: string,
	host: string,
): HostRedirect {
	const manifest = readManifest(
		resolve(maestro, "provenance/copy-manifest.json"),
	);
	let pkg: { exports: Record<string, { import?: string }> };
	try {
		pkg = JSON.parse(readFileSync(resolve(maestro, "package.json"), "utf8"));
	} catch (cause) {
		throw new Error("Cannot read the Maestro package manifest", { cause });
	}
	const exportOf = new Map<string, string>();
	for (const [name, target] of Object.entries(pkg.exports))
		if (name !== "." && target.import)
			exportOf.set(
				target.import.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts"),
				`@nubl/maestro/${name.slice(2)}`,
			);
	// The testing facade owns the two fakes.
	exportOf.set(
		"maestro/adapters/fake/fake-harness-adapter.ts",
		"@nubl/maestro/testing",
	);
	exportOf.set(
		"maestro/surfaces/fake/fake-surface-provider.ts",
		"@nubl/maestro/testing",
	);
	const moving = new Map<string, string>();
	for (const entry of manifest.entries)
		if (
			entry.kind === "copy" &&
			/^(?:maestro|pi-extension)\//.test(entry.source)
		)
			moving.set(entry.source, exportOf.get(entry.destination) ?? "");
	const tracked = execFileSync("git", ["-C", host, "ls-files"], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter(
			(path) =>
				/\.(?:[cm]?[jt]s)$/.test(path) &&
				!moving.has(path) &&
				!path.startsWith("node_modules/"),
		);
	const rewrites = new Map<string, number>();
	let files = 0;
	for (const path of tracked) {
		const absolute = resolve(host, path);
		const text = readFileSync(absolute, "utf8");
		const source = ts.createSourceFile(
			path,
			text,
			ts.ScriptTarget.Latest,
			true,
		);
		const edits: { start: number; end: number; text: string }[] = [];
		const consider = (literal: ts.Node | undefined) => {
			if (
				!literal ||
				!(
					ts.isStringLiteral(literal) ||
					ts.isNoSubstitutionTemplateLiteral(literal)
				)
			)
				return;
			const specifier = literal.text;
			if (!specifier.startsWith(".")) return;
			const [bare, query] = specifier.split(/(?=[?#])/);
			const target = relative(host, resolve(dirname(absolute), bare));
			const replacement = moving.get(target);
			if (replacement === undefined) return;
			assert(replacement, `No package export for moved ${target} (${path})`);
			assert(
				query === undefined,
				`Query-suffixed import of a moved module: ${path} -> ${specifier}`,
			);
			const quote = text[literal.getStart(source)];
			edits.push({
				start: literal.getStart(source),
				end: literal.getEnd(),
				text: `${quote}${replacement}${quote}`,
			});
			rewrites.set(replacement, (rewrites.get(replacement) ?? 0) + 1);
		};
		const visit = (node: ts.Node) => {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
				consider(node.moduleSpecifier);
			else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
				consider(node.argument.literal);
			else if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword
			)
				consider(node.arguments[0]);
			ts.forEachChild(node, visit);
		};
		visit(source);
		if (!edits.length) continue;
		let output = text;
		for (const edit of edits.sort((a, b) => b.start - a.start))
			output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
		writeFileSync(absolute, output);
		files++;
	}
	return { files, rewrites };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	assert(process.argv[2], "Usage: redirect-host-imports.ts <host-checkout>");
	const { files, rewrites } = redirectHostImports(
		fileURLToPath(new URL("../", import.meta.url)),
		resolve(process.argv[2]),
	);
	console.log(
		`Redirected ${[...rewrites.values()].reduce((a, b) => a + b, 0)} imports in ${files} files to ${rewrites.size} package subpaths.`,
	);
}
