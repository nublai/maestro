import "./clean-host-env.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	discoverAgentCatalog,
	discoverAgentDefinitions,
	discoverRolePackPaths,
} from "../maestro/core/roles/discovery.ts";

test("core role packs retain diagnostics, metadata, precedence and fail-closed duplicate policy", (t) => {
	const root = mkdtempSync(join(tmpdir(), "maestro-role-packs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project"),
		agentConfigDir = join(root, "global"),
		pack = join(root, "pack"),
		other = join(root, "other");
	for (const dir of [cwd, agentConfigDir, pack, other]) mkdirSync(dir);
	writeFileSync(
		join(pack, "package.json"),
		JSON.stringify({ name: "@fixture/roles", version: "1.0.0" }),
	);
	writeFileSync(join(other, "package.json"), "{");
	const role = (name: string, fields: string, body = "fixture") =>
		`---\nname: ${name}\n${fields}\n---\n${body}`;
	writeFileSync(
		join(pack, "worker.md"),
		role("worker", "description: worker\nspawning: false\ntools: read"),
	);
	writeFileSync(
		join(other, "worker.md"),
		role("worker", "description: duplicate"),
	);
	writeFileSync(
		join(pack, "mismatch.md"),
		role("different", "description: mismatch"),
	);
	writeFileSync(
		join(pack, "missing-description.md"),
		role("missing-description", "tools: read"),
	);
	writeFileSync(join(pack, "invalid.md"), "no frontmatter");
	writeFileSync(
		join(pack, "invalid-capability.md"),
		role("invalid-capability", "tools: [read]"),
	);
	writeFileSync(
		join(pack, "legacy.md"),
		role("legacy", "description: legacy\ncli: external"),
	);
	mkdirSync(join(pack, "directory.md"));
	symlinkSync(join(pack, "loop.md"), join(pack, "loop.md"));
	const nonMarkdown = join(root, "plain.txt");
	writeFileSync(nonMarkdown, "fixture");
	const options = {
		cwd,
		agentConfigDir,
		onRolePackDiscovered(event: { register(path: string): void }) {
			event.register(pack);
			event.register(other);
			event.register(nonMarkdown);
			event.register(join(root, "missing"));
		},
	};
	const catalog = discoverAgentCatalog(options);
	assert.equal(
		catalog.agents.find((agent) => agent.name === "worker"),
		undefined,
	);
	const codes = catalog.diagnostics.map((d) => d.code);
	for (const code of [
		"role-name-mismatch",
		"missing-role-description",
		"invalid-role-definition",
		"invalid-capability-declaration",
		"unreadable-role-definition",
		"invalid-role-pack-file",
		"missing-role-pack-path",
		"duplicate-package-role",
	])
		assert.ok(codes.includes(code), code);
	const global = join(agentConfigDir, "agents");
	mkdirSync(global);
	writeFileSync(
		join(global, "worker.md"),
		role("worker", "description: intentional override"),
	);
	assert.equal(
		discoverAgentDefinitions(options).find((agent) => agent.name === "worker")
			?.source,
		"global",
	);
	assert.equal(
		discoverRolePackPaths((event) => {
			event.register("relative");
			event.register(pack);
			event.register(pack);
		}).paths.length,
		1,
	);
	writeFileSync(
		join(global, "invalid-capability.md"),
		role("invalid-capability", "tools: [read]"),
	);
	assert.ok(
		discoverAgentCatalog(options).diagnostics.some(
			(d) =>
				d.code === "invalid-capability-declaration" &&
				d.path?.startsWith(global),
		),
	);
	const originalStat = fs.statSync;
	try {
		// SAFETY: this scoped fixture deliberately makes statSync fail; its original overloads are restored below.
		fs.statSync = (() => {
			throw new Error("fixture stat refusal");
		}) as typeof fs.statSync;
		syncBuiltinESMExports();
		const unavailable = discoverAgentCatalog({
			cwd: join(root, "absent"),
			agentConfigDir: join(root, "absent"),
			onRolePackDiscovered: (event) => event.register(pack),
		});
		assert.ok(
			unavailable.diagnostics.some(
				(d) => d.code === "unreadable-role-pack-path",
			),
		);
	} finally {
		fs.statSync = originalStat;
		syncBuiltinESMExports();
	}
	assert.equal(
		discoverRolePackPaths(() => {
			throw "fixture refusal";
		}).diagnostics[0].code,
		"role-pack-discovery-failed",
	);
});
