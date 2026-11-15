import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
	migrateFile,
	type MigrationPlan,
	type RetainedCase,
} from "./migrate-tests.ts";
import { readTestMap, TEST_MAPS } from "./check-test-migration.ts";

/**
 * Complete the original test ownership ledger: give every original identity
 * that stays upstream an explicit reason. Whole-file "stay" sources take their
 * Appendix B reason. For a source with moved cases, the migration selector is
 * re-run against the current tree (with every earlier step's selections and
 * the latest plan's mappings and exclusions) and reports, per retained case or
 * suite prefix, the exclusion, the tainted suite hooks, or the unavailable
 * helpers/imports that keep it upstream. A retained identity with no reason,
 * or a case that would now migrate, fails.
 *
 *   node --experimental-strip-types scripts/retained-ledger.ts \
 *     <upstream checkout> <identities.json.gz from a unit run>
 */
export interface LedgerEntry {
	file: string;
	titles: string[];
	skip: boolean | string;
	todo: boolean | string;
	reason: string;
}

interface Identity {
	kind: string;
	file: string;
	titles: string[];
	skip: boolean | string;
	todo: boolean | string;
	owner: string;
}

function readJson<T>(path: string, what: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new Error(`Cannot read ${what}: ${path}`, { cause });
	}
}

/** `<computed>` stands for one title produced by a loop or template. */
export function prefixMatches(prefix: string[], titles: string[]): boolean {
	return (
		prefix.length <= titles.length &&
		prefix.every(
			(title, index) => title === "<computed>" || title === titles[index],
		)
	);
}

export function buildLedger(
	root: string,
	upstream: string,
	identities: Identity[],
): LedgerEntry[] {
	const manifest = readJson<{
		original_test_tree: { source: string; fate: string; reason: string }[];
	}>(resolve(root, "provenance/test-manifest.json"), "test manifest");
	const plan = readJson<MigrationPlan>(
		resolve(root, "provenance/m4-test-plan.json"),
		"M4 migration plan",
	);
	const tree = readJson<{ copy_sha: string }>(
		resolve(root, "provenance/upstream-tree.json"),
		"upstream tree",
	);
	const fate = new Map(
		manifest.original_test_tree.map((row) => [row.source, row]),
	);
	const maps = TEST_MAPS.map((name) =>
		readTestMap(resolve(root, "provenance", name)),
	);
	const retained = identities.filter(
		(event) => event.kind !== "suite" && event.owner === "pi-herdr-agents",
	);
	const reasons = new Map<string, RetainedCase[]>();
	for (const file of new Set(retained.map((event) => event.file))) {
		const row = fate.get(file);
		assert(row, `No Appendix B row for ${file}`);
		const earlier = maps.flatMap((map) =>
			map.files.filter((entry) => entry.source === file),
		);
		if (row.fate === "stay" || !earlier.length) {
			reasons.set(file, [
				{
					line: 0,
					titles: [],
					reason: `Appendix B ${row.fate}: ${row.reason}`,
				},
			]);
			continue;
		}
		const text = execFileSync(
			"git",
			["-C", upstream, "show", `${tree.copy_sha}:${file}`],
			{ encoding: "utf8", maxBuffer: 1 << 28 },
		);
		const cases: RetainedCase[] = [];
		const destination = earlier[0].destination;
		try {
			migrateFile(
				text,
				file,
				destination,
				root,
				plan.import_mappings,
				earlier.flatMap((entry) => entry.selections),
				plan.files.find((spec) => spec.source === file)?.exclude ??
					maps
						.flatMap((map) => map.files)
						.find((entry) => entry.source === file)?.retained ??
					[],
				plan.resource_mappings,
				cases,
			);
		} catch (error) {
			// A source whose remaining cases all stay has nothing left to select.
			if (!/No migratable cases/.test(String(error))) throw error;
		}
		reasons.set(file, cases);
	}
	return retained.map((event) => {
		const candidates = (reasons.get(event.file) ?? []).filter((entry) =>
			prefixMatches(entry.titles, event.titles),
		);
		assert(
			candidates.length,
			`No retention reason (would it migrate now?): ${event.file} ${JSON.stringify(event.titles)}`,
		);
		const best = candidates.reduce((a, b) =>
			b.titles.length > a.titles.length ? b : a,
		);
		return {
			file: event.file,
			titles: event.titles,
			skip: event.skip,
			todo: event.todo,
			reason: best.reason,
		};
	});
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [upstream, identitiesPath] = process.argv.slice(2);
	assert(
		upstream && identitiesPath,
		"Usage: retained-ledger.ts <upstream> <identities.json.gz>",
	);
	const root = fileURLToPath(new URL("../", import.meta.url));
	let identities: Identity[];
	try {
		identities = JSON.parse(
			gunzipSync(readFileSync(identitiesPath)).toString("utf8"),
		);
	} catch (cause) {
		throw new Error(`Cannot read identities: ${identitiesPath}`, { cause });
	}
	const ledger = buildLedger(root, resolve(upstream), identities);
	writeFileSync(
		resolve(root, "provenance/m4/retained-ledger.json"),
		JSON.stringify(ledger, null, "\t") + "\n",
	);
	console.log(`${ledger.length} retained identities, each with a reason.`);
}
