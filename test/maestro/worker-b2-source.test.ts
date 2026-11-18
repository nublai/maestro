/**
 * P3-7: the real-B2 lane runs only against the pinned pi-worker commit and a
 * build of exactly that commit (`scripts/pi-worker-checkout.ts`). A synthetic
 * two-package checkout stands in for pi-worker; its build is the TypeScript
 * compiler Maestro already has, linked as the checkout's own.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	PiWorkerCheckoutRefusal,
	verifyPiWorkerCheckout,
} from "../../scripts/pi-worker-checkout.ts";

const TSC = fileURLToPath(
	new URL("../../node_modules/typescript/bin/tsc", import.meta.url),
);
const TYPESCRIPT = dirname(dirname(TSC));

function syntheticCheckout() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "maestro-piw-src-")));
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: dir,
		LANG: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
	const write = (path: string, text: string) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	const tsconfig = JSON.stringify({
		compilerOptions: {
			rootDir: ".",
			outDir: "dist",
			module: "nodenext",
			target: "es2023",
			declaration: true,
			sourceMap: true,
			types: [],
		},
		include: ["src/**/*.ts"],
	});
	write(".gitignore", "node_modules/\ndist/\n");
	write("package.json", '{"private":true}\n');
	write("packages/client-ts/tsconfig.json", tsconfig);
	write("packages/client-ts/src/index.ts", "export const client = 1;\n");
	write(
		"packages/client-ts/src/generated/validators.js",
		"export const validators = {};\n",
	);
	write("packages/worker/tsconfig.json", tsconfig);
	write("packages/worker/src/supervisor.ts", "export const supervisor = 1;\n");
	mkdirSync(join(dir, "node_modules/@nublai"), { recursive: true });
	symlinkSync(TYPESCRIPT, join(dir, "node_modules/typescript"));
	symlinkSync(
		"../../packages/client-ts",
		join(dir, "node_modules/@nublai/pi-worker-client"),
	);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("add", ".");
	git("commit", "-qm", "base");
	/** What `npm run build` does there: tsc per package, then the validators copy. */
	const build = () => {
		for (const pkg of ["packages/client-ts", "packages/worker"]) {
			rmSync(join(dir, pkg, "dist"), { recursive: true, force: true });
			execFileSync(process.execPath, [TSC, "-p", join(dir, pkg)], { env });
		}
		cpSync(
			join(dir, "packages/client-ts/src/generated/validators.js"),
			join(dir, "packages/client-ts/dist/src/generated/validators.js"),
		);
	};
	build();
	return {
		dir,
		git,
		write,
		build,
		head: () => git("rev-parse", "HEAD"),
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const refused = (text: RegExp) => (error: Error) =>
	error instanceof PiWorkerCheckoutRefusal && text.test(error.message);

describe("the real-B2 lane's pi-worker source check", () => {
	it("accepts the pinned commit with a clean tree and its own build", () => {
		const t = syntheticCheckout();
		try {
			assert.equal(verifyPiWorkerCheckout(t.dir, t.head()), t.head());
		} finally {
			t.dispose();
		}
	});

	it("refuses a checkout at another revision before anything runs", () => {
		const t = syntheticCheckout();
		try {
			const pinned = t.head();
			t.write(
				"packages/worker/src/supervisor.ts",
				"export const supervisor = 2;\n",
			);
			t.git("commit", "-qam", "next");
			t.build();
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, pinned),
				refused(new RegExp(`is at ${t.head()}, not the pinned ${pinned}`)),
			);
		} finally {
			t.dispose();
		}
	});

	it("refuses tracked changes and untracked files", () => {
		const t = syntheticCheckout();
		try {
			t.write("packages/worker/src/extra.ts", "export const extra = 1;\n");
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, t.head()),
				refused(/has changes beyond/),
			);
			rmSync(join(t.dir, "packages/worker/src/extra.ts"));
			appendFileSync(join(t.dir, "packages/worker/src/supervisor.ts"), "\n");
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, t.head()),
				refused(/has changes beyond/),
			);
		} finally {
			t.dispose();
		}
	});

	it("refuses a build that is not what the pinned sources compile to", () => {
		const t = syntheticCheckout();
		try {
			// Built at an earlier commit, then moved to the pin without rebuilding.
			t.write(
				"packages/worker/src/supervisor.ts",
				"export const supervisor = 2;\n",
			);
			t.git("commit", "-qam", "next");
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, t.head()),
				refused(
					/packages\/worker\/dist\/src\/supervisor\.(js|d\.ts) is not built from/,
				),
			);
			t.build();
			assert.equal(verifyPiWorkerCheckout(t.dir, t.head()), t.head());
			// A copied build file that differs from its tracked source.
			appendFileSync(
				join(t.dir, "packages/client-ts/dist/src/generated/validators.js"),
				"// edited\n",
			);
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, t.head()),
				refused(/validators\.js is not built from/),
			);
			t.build();
			// A build file nothing in the tree produces.
			writeFileSync(join(t.dir, "packages/worker/dist/src/stray.js"), "");
			assert.throws(
				() => verifyPiWorkerCheckout(t.dir, t.head()),
				refused(/stray\.js is not built from/),
			);
		} finally {
			t.dispose();
		}
	});

	it("the B2 test files refuse a checkout the runner did not verify", async () => {
		const { piWorkerCheckout } = await import(
			"../helpers/worker-b2-fixture.ts"
		);
		const saved = {
			checkout: process.env.MAESTRO_PI_WORKER_CHECKOUT,
			verified: process.env.MAESTRO_PI_WORKER_VERIFIED,
		};
		try {
			process.env.MAESTRO_PI_WORKER_CHECKOUT = "/nonexistent/pi-worker";
			delete process.env.MAESTRO_PI_WORKER_VERIFIED;
			assert.throws(piWorkerCheckout, /Run through npm run test:worker-b2/);
			process.env.MAESTRO_PI_WORKER_VERIFIED = "0".repeat(40);
			assert.throws(piWorkerCheckout, /Run through npm run test:worker-b2/);
		} finally {
			for (const [key, value] of [
				["MAESTRO_PI_WORKER_CHECKOUT", saved.checkout],
				["MAESTRO_PI_WORKER_VERIFIED", saved.verified],
			] as const)
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
		}
	});

	it("refuses a directory that is not a Git checkout", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-piw-none-"));
		try {
			assert.throws(
				() => verifyPiWorkerCheckout(dir, "0".repeat(40)),
				refused(/is not a Git checkout of pi-worker/),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
