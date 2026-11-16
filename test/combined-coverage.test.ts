import "./clean-host-env.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { decodeMappings, rawLineHits } from "../scripts/combined-coverage.ts";

test("source-map segments decode to 1-based original lines across generated lines", () => {
	assert.deepEqual(decodeMappings("AAAA;AACA,EAAE;;ACAA"), [
		[{ source: 0, line: 1 }],
		[
			{ source: 0, line: 2 },
			{ source: 0, line: 2 },
		],
		[],
		[{ source: 1, line: 2 }],
	]);
});

test("raw V8 hits take the innermost containing range and union across processes and query variants", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-raw-coverage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "v8"));
	const source = join(root, "src/file.ts");
	writeFileSync(source, "one\ntwo\nthree\n");
	const url = pathToFileURL(source).href;
	const script = (suffix: string, inner: number) => ({
		url: url + suffix,
		functions: [
			{ ranges: [{ startOffset: 0, endOffset: 13, count: 1 }] },
			{ ranges: [{ startOffset: 4, endOffset: 7, count: inner }] },
		],
	});
	writeFileSync(
		join(root, "v8/a.json"),
		JSON.stringify({ result: [script("", 0)] }),
	);
	writeFileSync(
		join(root, "v8/b.json"),
		JSON.stringify({
			result: [
				script("?reload-1", 0),
				{ url: "node:fs", functions: [] },
				{ url: pathToFileURL(join(root, "elsewhere.ts")).href, functions: [] },
			],
		}),
	);
	const hits = rawLineHits(join(root, "v8"), root, (path) =>
		path.startsWith("src/"),
	);
	assert.deepEqual([...hits.keys()], ["src/file.ts"]);
	assert.deepEqual(
		[...(hits.get("src/file.ts") ?? [])],
		[
			[1, 1],
			[2, 0],
			[3, 1],
		],
	);
	writeFileSync(
		join(root, "v8/c.json"),
		JSON.stringify({ result: [script("", 4)] }),
	);
	const unioned = rawLineHits(join(root, "v8"), root, (path) =>
		path.startsWith("src/"),
	);
	assert.equal(unioned.get("src/file.ts")?.get(2), 4);
});
