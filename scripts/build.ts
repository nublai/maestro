import assert from "node:assert/strict";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Declaration-only overlay. H1's copied extension.ts infers createPiExtension's
 * return type from three interfaces its sibling modules do not export, so
 * declaration emit cannot name them (TS4058). The copies stay byte-identical:
 * JavaScript and its source maps come from the unmodified sources; only the
 * declaration pass reads these interfaces as exported. Each rewrite must match
 * exactly once; delete an entry once the pinned source exports it.
 */
export const DECLARATION_EXPORTS = {
	"pi-extension/subagents/controls.ts": ["SubagentInterruptDetails"],
	"pi-extension/subagents/persistent.ts": [
		"SubagentSendDetails",
		"SubagentStopDetails",
	],
} satisfies Record<string, string[]>;

export function exportInterfaces(text: string, names: string[]): string {
	for (const name of names) {
		const declaration = `\ninterface ${name} {`;
		assert.equal(
			text.split(declaration).length,
			2,
			`Expected one unexported interface ${name}`,
		);
		text = text.replace(declaration, `\nexport interface ${name} {`);
	}
	return text;
}

function report(diagnostics: readonly ts.Diagnostic[]): void {
	if (!diagnostics.length) return;
	throw new Error(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (name) => name,
			getCurrentDirectory: ts.sys.getCurrentDirectory,
			getNewLine: () => "\n",
		}),
	);
}

export function build(root: string): void {
	rmSync(resolve(root, "dist"), { recursive: true, force: true });
	const parsed = ts.getParsedCommandLineOfConfigFile(
		resolve(root, "tsconfig.build.json"),
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => report([diagnostic]),
		},
	);
	assert(parsed);
	report(parsed.errors);
	// Pass 1: JavaScript and source maps from the unmodified sources.
	const javascript = ts.createProgram(parsed.fileNames, {
		...parsed.options,
		declaration: false,
		declarationMap: false,
	});
	report(ts.getPreEmitDiagnostics(javascript));
	report(javascript.emit().diagnostics);
	// Pass 2: declarations only, through the overlay.
	const overlay = new Map(
		Object.entries(DECLARATION_EXPORTS).map(([path, names]) => [
			resolve(root, path),
			names,
		]),
	);
	const host = ts.createCompilerHost(parsed.options);
	const getSourceFile = host.getSourceFile;
	host.getSourceFile = (fileName, language, onError, create) => {
		const names = overlay.get(resolve(fileName));
		if (!names) return getSourceFile(fileName, language, onError, create);
		return ts.createSourceFile(
			fileName,
			exportInterfaces(ts.sys.readFile(fileName) ?? "", names),
			language,
		);
	};
	const declarations = ts.createProgram(
		parsed.fileNames,
		{ ...parsed.options, emitDeclarationOnly: true },
		host,
	);
	report(ts.getPreEmitDiagnostics(declarations));
	report(declarations.emit().diagnostics);
	// Non-code asset (§2.4): config-path.ts resolves its default example two
	// levels above dist/pi-extension/subagents/, as the source tree's does.
	copyFileSync(
		resolve(root, "config.json.example"),
		resolve(root, "dist/config.json.example"),
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	build(fileURLToPath(new URL("../", import.meta.url)));
