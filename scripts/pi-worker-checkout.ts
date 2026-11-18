/**
 * The real-B2 lane's source check (P3-7): the pi-worker checkout it runs must
 * be the exact commit vendor/pi-worker-client/SOURCE.json pins, with a clean
 * tree, and the build it loads must be what that tree compiles to. Nothing is
 * written: each package is compiled in memory with the checkout's own
 * TypeScript and compared byte for byte with its `dist`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

/** The workspace packages the lane loads: the supervisor and the client it imports. */
export const PI_WORKER_PACKAGES = [
	"packages/client-ts",
	"packages/worker",
] as const;

/** A checkout the lane must not run against. */
export class PiWorkerCheckoutRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiWorkerCheckoutRefusal";
	}
}

/** Git with a synthetic environment, never the user's configuration. */
function git(checkout: string, ...args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: checkout,
			LANG: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Whether `path` is a file the checkout's commit tracks. */
function tracked(checkout: string, path: string): boolean {
	try {
		git(checkout, "ls-files", "--error-unmatch", "--", path);
		return true;
	} catch {
		return false;
	}
}

/** Every file under `dir`, relative to it. */
function files(dir: string, prefix = ""): string[] {
	return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = join(prefix, entry.name);
			return entry.isDirectory() ? files(dir, path) : [path];
		},
	);
}

/**
 * Refuses unless `checkout` is a Git checkout at exactly `commit`, with no
 * tracked change and no untracked file, whose packages' `dist` is exactly
 * what their sources compile to (a file the compiler does not emit must be a
 * byte copy of the source file at the same path, as the build's `cp` makes).
 * Returns the verified commit.
 */
export function verifyPiWorkerCheckout(
	checkout: string,
	commit: string,
	packages: readonly string[] = PI_WORKER_PACKAGES,
): string {
	let head: string;
	try {
		head = git(checkout, "rev-parse", "--verify", "HEAD^{commit}");
	} catch {
		throw new PiWorkerCheckoutRefusal(
			`${checkout} is not a Git checkout of pi-worker; the real-B2 lane needs the pinned commit ${commit}`,
		);
	}
	if (head !== commit)
		throw new PiWorkerCheckoutRefusal(
			`pi-worker checkout ${checkout} is at ${head}, not the pinned ${commit} (vendor/pi-worker-client/SOURCE.json)`,
		);
	const changes = git(
		checkout,
		"status",
		"--porcelain",
		"--untracked-files=all",
	);
	if (changes !== "")
		throw new PiWorkerCheckoutRefusal(
			`pi-worker checkout ${checkout} has changes beyond ${commit}:\n${changes}`,
		);
	const require = createRequire(join(checkout, "package.json"));
	let ts: typeof import("typescript");
	try {
		// SAFETY: the checkout's own pinned TypeScript, the compiler its build runs.
		ts = require("typescript") as typeof import("typescript");
	} catch {
		throw new PiWorkerCheckoutRefusal(
			`pi-worker checkout ${checkout} has no installed TypeScript (run npm ci there)`,
		);
	}
	for (const pkg of packages) {
		const root = join(checkout, pkg);
		const config = ts.getParsedCommandLineOfConfigFile(
			join(root, "tsconfig.json"),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					throw new PiWorkerCheckoutRefusal(
						`${pkg}/tsconfig.json: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
					);
				},
			},
		);
		const outDir = config?.options.outDir;
		if (!config || !outDir)
			throw new PiWorkerCheckoutRefusal(`${pkg} names no build output`);
		if (!existsSync(outDir))
			throw new PiWorkerCheckoutRefusal(
				`${pkg} is not built (run npm run build in ${checkout})`,
			);
		const emitted = new Map<string, string>();
		ts.createProgram({
			rootNames: config.fileNames,
			options: config.options,
		}).emit(undefined, (name, text) => emitted.set(name, text));
		const built = files(outDir).map((path) => join(outDir, path));
		const stale = (path: string) =>
			new PiWorkerCheckoutRefusal(
				`${relative(checkout, path)} is not built from ${commit} (rebuild: npm run build in ${checkout})`,
			);
		for (const [path] of emitted) if (!built.includes(path)) throw stale(path);
		for (const path of built) {
			const actual = readFileSync(path);
			const expected = emitted.get(path);
			const copied = join(root, relative(outDir, path));
			if (expected !== undefined) {
				if (!actual.equals(Buffer.from(expected))) throw stale(path);
			} else if (
				!tracked(checkout, copied) ||
				!actual.equals(readFileSync(copied))
			)
				throw stale(path);
		}
	}
	// The supervisor imports the client by package name: it must resolve into this tree.
	const client = join(checkout, "node_modules/@nublai/pi-worker-client");
	if (
		!existsSync(client) ||
		realpathSync(client) !== realpathSync(join(checkout, "packages/client-ts"))
	)
		throw new PiWorkerCheckoutRefusal(
			`pi-worker checkout ${checkout} does not link its own client package (run npm ci there)`,
		);
	return head;
}
