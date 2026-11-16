import assert from "node:assert/strict";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { readManifest } from "./check-copy-fidelity.ts";

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
	// The extraction pin travels with the candidate: a consumer (H2) refuses a
	// tarball whose base or copy revision differs from its own (plan §1.4).
	const manifest = readManifest(resolve(root, "provenance/copy-manifest.json"));
	writeFileSync(
		resolve(root, "dist/provenance.json"),
		JSON.stringify(
			{
				source_repository: "giuseppecrj/pi-herdr-agents",
				base_main_sha: manifest.base_main_sha,
				copy_sha: manifest.copy_sha,
			},
			null,
			"\t",
		) + "\n",
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	build(fileURLToPath(new URL("../", import.meta.url)));
