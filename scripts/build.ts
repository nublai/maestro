import assert from "node:assert/strict";
import { copyFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
	// JavaScript, declarations and source maps from the unmodified copies.
	const program = ts.createProgram(parsed.fileNames, parsed.options);
	report(ts.getPreEmitDiagnostics(program));
	report(program.emit().diagnostics);
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
