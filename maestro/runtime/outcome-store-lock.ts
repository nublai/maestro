/**
 * The file OutcomeStore's single-writer lock (P3-8): a Unix-domain socket
 * listening at `<store>/writer.lock`.
 *
 * - The kernel answers for the holder. While the holder's process lives, its
 *   listening socket accepts a connection; once the process dies, by any
 *   means, the socket stops listening and a connection is refused. No PID,
 *   host name or clock is involved, so a holder in another PID namespace (a
 *   sandbox, a container) sharing the directory is still seen as alive.
 * - A new holder binds a private socket and links it into place, so the
 *   public name only ever names a socket that is already listening. A refused
 *   holder is moved aside only while the name is still that socket (by inode,
 *   on both sides of the move) and refused again before it is removed: two
 *   openers recovering the same stale lock cannot both win, and a live socket
 *   moved by mistake is put back before a third opener can take the name.
 * - The holder checks before every write that the public name is still its own
 *   socket (`held`); a writer whose lock was removed or replaced stops.
 *
 * The store directory must be on local storage. A socket on a network
 * filesystem belongs to the kernel of the machine that bound it, so another
 * machine would see it refused and take it over. Linux opens on a known
 * network, cluster or FUSE filesystem are refused; on other systems, and for
 * types the list does not name, this is documented, not detected. Windows has
 * no filesystem-bound sockets here and is refused.
 */
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutcomeStoreError } from "../core/outcome-store.ts";
import { isString } from "../core/config/type-guards.ts";

/** One writer's hold on a store directory. */
export interface OutcomeStoreLock {
	/** Whether this writer still holds the lock; checked before every write. */
	held(): boolean;
	/** Gives the lock up; later `held()` calls return false. */
	release(): Promise<void>;
}

/** Takes the lock for a store directory, or rejects with `locked`/`io`. */
export type OutcomeStoreLocker = (dir: string) => Promise<OutcomeStoreLock>;

export const OUTCOME_LOCK_FILE = "writer.lock";
/** How long a connection to a holder may take before it counts as alive. */
const PROBE_TIMEOUT_MS = 2_000;
const RETRIES = 8;

/**
 * `statfs` types of network, cluster and userspace filesystems (Linux
 * `f_type`, from `linux/magic.h`), where a socket file cannot prove a holder
 * on another machine is alive. FUSE is refused as a whole: sshfs, rclone,
 * GlusterFS, s3fs and virtiofs all report it, and `statfs` cannot tell those
 * from a local FUSE filesystem (gocryptfs, encfs), which is refused too.
 * Out-of-tree types (BeeGFS, OrangeFS and the like) are not listed.
 */
const NETWORK_FILESYSTEMS = new Map<number, string>([
	[0x6969, "NFS"],
	[0x517b, "SMB"],
	[0xff534d42, "CIFS"],
	[0xfe534d42, "SMB2"],
	[0x00c36400, "Ceph"],
	[0x5346414f, "AFS"],
	[0x73757245, "Coda"],
	[0x01021997, "9P"],
	[0x0bd00bd0, "Lustre"],
	[0x01161970, "GFS2"],
	[0x47504653, "GPFS"],
	[0x65735546, "FUSE"],
	[0x7461636f, "OCFS2"],
	[0x6b414653, "kAFS"],
	[0x564c, "NCP"],
]);

/** The network, cluster or FUSE filesystem a Linux `statfs` type names. */
export function networkFilesystemName(type: number): string | undefined {
	return NETWORK_FILESYSTEMS.get(type);
}

/** Longest socket path in bytes, without the terminating NUL (`sun_path`). */
function socketPathLimit(): number {
	return process.platform === "linux" ? 107 : 103;
}

function errorCode(error: any): string | undefined {
	// Node's system errors are Error instances carrying a string `code`.
	return error !== null && error !== undefined && isString(error.code)
		? error.code
		: undefined;
}

function errorText(error: any): string {
	return error instanceof Error ? error.message : String(error);
}

function unsafe(dir: string, why: string, cause?: unknown): never {
	throw new OutcomeStoreError(
		"io",
		`Cannot lock the outcome store at ${dir} safely: ${why}`,
		cause === undefined ? undefined : { cause },
	);
}

function anotherWriter(dir: string): never {
	throw new OutcomeStoreError(
		"locked",
		`The outcome store at ${dir} has another writer (its lock socket accepts connections); one writer per store.`,
	);
}

type Probe = "alive" | "refused" | "gone";

/** Whether a socket path has a listening holder; anything unclear is alive. */
function probe(path: string): Promise<Probe> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const done = (state: Probe) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(state);
		};
		const timer = setTimeout(() => done("alive"), PROBE_TIMEOUT_MS);
		socket.once("connect", () => done("alive"));
		socket.once("error", (error) => {
			const code = errorCode(error);
			if (code === "ECONNREFUSED") done("refused");
			else if (code === "ENOENT") done("gone");
			else done("alive");
		});
	});
}

function listen(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		// Probes only need the kernel to accept; the holder never reads them.
		const server = createServer((socket) => socket.destroy());
		server.once("error", reject);
		server.listen(path, () => {
			server.removeListener("error", reject);
			server.on("error", () => {});
			// A held lock never keeps the process alive.
			server.unref();
			resolve(server);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

interface LockPaths {
	/** The store directory, or a short alias of it. */
	base: string;
	dispose(): void;
}

/** The longest socket path the lock binds or connects to under `base`. */
function longestSocket(base: string): number {
	return Buffer.byteLength(join(base, `${OUTCOME_LOCK_FILE}.x-0123456789ab`));
}

/**
 * Socket paths are short (104 bytes on macOS). A longer store path is reached
 * through a symlink in a fresh private (0700) directory under the temporary
 * directory, or `/tmp` when that is long too; the socket itself is still
 * created in the store directory.
 */
function reachable(dir: string): LockPaths {
	if (longestSocket(dir) <= socketPathLimit())
		return { base: dir, dispose() {} };
	for (const root of new Set([tmpdir(), "/tmp"])) {
		// mkdtemp's six random characters; the alias is `<root>/maestro-lock-XXXXXX/d`.
		if (
			longestSocket(join(root, "maestro-lock-XXXXXX", "d")) > socketPathLimit()
		)
			continue;
		let alias: string;
		try {
			alias = nodeFs.mkdtempSync(join(root, "maestro-lock-"));
		} catch {
			continue;
		}
		try {
			nodeFs.symlinkSync(dir, join(alias, "d"));
		} catch (error) {
			nodeFs.rmSync(alias, { recursive: true, force: true });
			unsafe(
				dir,
				`its path is too long for a socket and no short alias could be made (${errorText(error)})`,
				error,
			);
		}
		return {
			base: join(alias, "d"),
			dispose: () => nodeFs.rmSync(alias, { recursive: true, force: true }),
		};
	}
	unsafe(
		dir,
		"its path is too long for a socket, and so are the temporary directory and /tmp",
	);
}

function refuseNetworkFilesystem(dir: string): void {
	if (process.platform !== "linux") return;
	let type: number;
	try {
		type = nodeFs.statfsSync(dir).type;
	} catch (error) {
		unsafe(
			dir,
			`its filesystem could not be identified (${errorText(error)})`,
			error,
		);
	}
	const name = networkFilesystemName(type);
	if (name)
		unsafe(
			dir,
			`it is on a ${name} filesystem (network, cluster or FUSE); the store directory must be on local storage`,
		);
}

/** The default locker: a listening Unix-domain socket at `<dir>/writer.lock`. */
export const socketOutcomeStoreLock: OutcomeStoreLocker = async (dir) => {
	if (process.platform === "win32")
		unsafe(
			dir,
			"Windows has no filesystem-bound socket lock for the outcome store yet",
		);
	refuseNetworkFilesystem(dir);
	const lock = join(dir, OUTCOME_LOCK_FILE);
	const id = randomBytes(6).toString("hex");
	const mine = `${OUTCOME_LOCK_FILE}.${id}`;
	const aside = `${OUTCOME_LOCK_FILE}.x-${id}`;
	const { base, dispose } = reachable(dir);
	let server: Server | undefined;
	try {
		try {
			server = await listen(join(base, mine));
		} catch (error) {
			unsafe(
				dir,
				`its lock socket could not be bound (${errorText(error)})`,
				error,
			);
		}
		// The store's files are owner-only; so is its lock.
		nodeFs.chmodSync(join(dir, mine), 0o600);
		let published = false;
		for (let tries = 0; tries < RETRIES && !published; tries++) {
			try {
				nodeFs.linkSync(join(dir, mine), lock);
				published = true;
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST")
					unsafe(
						dir,
						`its lock socket could not be linked into place (${errorText(error)})`,
						error,
					);
			}
			let stat: nodeFs.Stats;
			try {
				stat = nodeFs.lstatSync(lock);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			// Only a socket can prove its holder dead; anything else stays held.
			if (!stat.isSocket())
				throw new OutcomeStoreError(
					"locked",
					`The outcome store at ${dir} has a ${OUTCOME_LOCK_FILE} that is not a lock socket; remove it only once no writer uses the store.`,
				);
			const state = await probe(join(base, OUTCOME_LOCK_FILE));
			if (state === "alive") anotherWriter(dir);
			if (state === "gone") continue;
			// Refused: its holder is gone. Move it aside, then make sure it is
			// still the refused socket and not one another opener just published.
			// Its inode is checked on both sides of the move without yielding:
			// while a live lock is aside, a third opener could publish its own.
			const probed = (path: string) => {
				const now = nodeFs.lstatSync(path);
				return now.ino === stat.ino && now.dev === stat.dev;
			};
			try {
				if (!probed(lock)) continue;
				nodeFs.renameSync(lock, join(dir, aside));
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			if (
				!probed(join(dir, aside)) ||
				(await probe(join(base, aside))) !== "refused"
			) {
				try {
					nodeFs.linkSync(join(dir, aside), lock);
				} catch {
					/* a third opener holds the name now; the moved holder sees it lost */
				}
				nodeFs.rmSync(join(dir, aside), { force: true });
				anotherWriter(dir);
			}
			nodeFs.rmSync(join(dir, aside), { force: true });
		}
		if (!published)
			throw new OutcomeStoreError(
				"locked",
				`Could not take the outcome store lock at ${dir}.`,
			);
		const own = nodeFs.lstatSync(join(dir, mine));
		const live = server;
		// Only the public name remains; it is this socket's, by inode.
		nodeFs.unlinkSync(join(dir, mine));
		let released = false;
		const held = (): boolean => {
			if (released || !live.listening) return false;
			try {
				const now = nodeFs.lstatSync(lock);
				return now.ino === own.ino && now.dev === own.dev;
			} catch {
				return false;
			}
		};
		return {
			held,
			async release() {
				if (released) return;
				if (held()) nodeFs.rmSync(lock, { force: true });
				released = true;
				await close(live);
			},
		};
	} catch (error) {
		if (server) {
			nodeFs.rmSync(join(dir, mine), { force: true });
			await close(server);
		}
		if (error instanceof OutcomeStoreError) throw error;
		unsafe(dir, errorText(error), error);
	} finally {
		dispose();
	}
};
