/**
 * The worker provider's real-B2 lane (P3-7): the ExecProvider conformance
 * suite and the provider's B2 tests against pi-worker's own supervisor, built
 * from a pinned local checkout named by MAESTRO_PI_WORKER_CHECKOUT (the commit
 * vendor/pi-worker-client/SOURCE.json records, after `npm ci && npm run
 * build`). Refuses to run without it rather than skipping, and refuses a
 * checkout at another commit, with local changes, or whose build is not what
 * that commit compiles to (`pi-worker-checkout.ts`). Isolated HOME, Pi agent
 * directory and npm cache; TMPDIR is the caller's.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPiWorkerCheckout } from "./pi-worker-checkout.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkout = process.env.MAESTRO_PI_WORKER_CHECKOUT;
assert.ok(
	checkout,
	"MAESTRO_PI_WORKER_CHECKOUT must name a built pi-worker checkout at the commit vendor/pi-worker-client/SOURCE.json records",
);
for (const built of [
	"packages/worker/dist/src/supervisor/supervisor.js",
	"packages/worker/dist/test/supervisor-fixture.js",
])
	assert.ok(
		existsSync(join(checkout, built)),
		`Not built: ${built} (run npm ci && npm run build there)`,
	);
// SAFETY: a small JSON file this repository writes.
const source = JSON.parse(
	readFileSync(join(root, "vendor/pi-worker-client/SOURCE.json"), "utf8"),
) as { source_commit: string };
const verified = verifyPiWorkerCheckout(checkout, source.source_commit);
const home = mkdtempSync(join(tmpdir(), "maestro-worker-b2-home-"));
try {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--test",
			"--test-concurrency=1",
			"test/worker/b2-conformance.test.ts",
			"test/worker/b2-provider.test.ts",
			"test/worker/b2-admission.test.ts",
			"test/worker/b2-bound-check.test.ts",
		],
		{
			cwd: root,
			stdio: "inherit",
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: tmpdir(),
				PI_CODING_AGENT_DIR: join(home, "agent"),
				npm_config_cache: join(home, "npm-cache"),
				MAESTRO_PI_WORKER_CHECKOUT: checkout,
				MAESTRO_PI_WORKER_VERIFIED: verified,
			},
		},
	);
	assert.equal(result.status, 0, "Worker real-B2 tests failed");
	console.log(
		`Worker real-B2 lane passed against pi-worker ${verified} (checkout verified at that commit, clean, its build matching its sources; client tarball).`,
	);
} finally {
	rmSync(home, { recursive: true, force: true });
}
