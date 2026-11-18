/**
 * Durable acquisition manifests for worker launches (P3-7): one manifest per
 * launch, written before anything is sent and kept on every uncertain
 * outcome. It holds every B2 mutation of that launch under a UUIDv7 command
 * ID that is durable before its transport, and the outcome its reply or
 * receipt proved. A command whose outcome is not proven stays `unknown` (or
 * `pending` when the process ended mid-call) and is never sent again.
 *
 * Files: `<dir>/<launch>.json`, 0600 in a 0700 directory; every write is
 * write-temporary, fsync, rename, directory fsync. No secret, socket path or
 * PID is recorded; command IDs, request hashes, worker IDs and slot identity
 * only.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, variant 10, random rest. */
export function uuidv7(now: number = Date.now()): string {
	const bytes = randomBytes(16);
	let ms = Math.max(0, Math.floor(now));
	for (let index = 5; index >= 0; index--) {
		bytes[index] = ms % 256;
		ms = Math.floor(ms / 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x70;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUIDV7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The B2 operations a worker provider sends. */
export type WorkerMutation =
	| "workers.create"
	| "sessions.prompt"
	| "executions.interrupt"
	| "workers.stop";

/** Why the provider sent a command. */
export type WorkerCommandPurpose =
	| "create"
	| "initial-prompt"
	| "prompt"
	| "interrupt"
	| "stop";

/**
 * `pending`: durable, sent or about to be, no outcome recorded (a process that
 * ended mid-call leaves it so: unknown). `observed`: the reply or receipt
 * proved its effect. `no_effect`: the worker proved it began nothing.
 * `unknown`: the effect may have happened.
 */
export type WorkerCommandOutcome =
	| "pending"
	| "observed"
	| "no_effect"
	| "unknown";

export interface WorkerCommandRecord {
	command_id: string;
	operation: WorkerMutation;
	purpose: WorkerCommandPurpose;
	/** pi-worker-client `requestHash` of the exact request. */
	request_hash: string;
	/** The worker the request names; absent for a create. */
	worker_id?: string;
	/** A prompt's caller-side input identity. */
	input_id?: string;
	outcome: WorkerCommandOutcome;
	/** The refusal code or the unknown reason; never a payload. */
	reason?: string;
	recorded_at: number;
	settled_at?: number;
}

/**
 * `claimed`: the slot is durably claimed, nothing sent. `creating`: the
 * create's command is durable. `acquired`: the worker exists. `uncertain`:
 * whether a worker exists is unknown (kept, never retried). `not_acquired`:
 * the create proved no effect.
 */
export type WorkerAcquisitionState =
	| "claimed"
	| "creating"
	| "acquired"
	| "uncertain"
	| "not_acquired";

export interface WorkerAcquisitionManifest {
	version: 1;
	kind: "maestro-worker-acquisition";
	launch_id: string;
	run_id: string;
	name: string;
	task_id: string;
	generation_id: string;
	parent_worker_id: string;
	slot: { name: string; path: string; branch: string; base_sha: string };
	requested_branch?: string;
	model: { provider: string; model: string; thinking: string };
	state: WorkerAcquisitionState;
	worker_id?: string;
	binding?: {
		worker_epoch: string;
		session_id: string;
		binding_revision: number;
	};
	/** Set while the launch is uncertain or failed; never a payload. */
	uncertainty?: string;
	commands: WorkerCommandRecord[];
	created_at: number;
	updated_at: number;
}

export type NewWorkerAcquisition = Omit<
	WorkerAcquisitionManifest,
	"version" | "kind" | "commands" | "created_at" | "updated_at"
>;

/** A command to record: its UUIDv7 ID is minted first ({@link uuidv7}), since the request hash covers it. */
export type NewWorkerCommand = Omit<
	WorkerCommandRecord,
	"outcome" | "recorded_at" | "settled_at" | "reason"
>;

const LAUNCH_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Durable acquisition manifests in one private directory. */
export class WorkerLaunchStore {
	readonly dir: string;
	readonly #now: () => number;

	constructor(dir: string, now: () => number = Date.now) {
		this.dir = dir;
		this.#now = now;
		privateDirectory(dir);
	}

	/** The manifest of `launchId`, or undefined when there is none. */
	read(launchId: string): WorkerAcquisitionManifest | undefined {
		let text: string;
		try {
			text = readFileSync(this.#path(launchId), "utf8");
		} catch {
			return undefined;
		}
		// SAFETY: only this store writes the file, whole (temporary + rename), from this type.
		return JSON.parse(text) as WorkerAcquisitionManifest;
	}

	/** Every manifest, oldest first. */
	list(): WorkerAcquisitionManifest[] {
		return readdirSync(this.dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -5))
			.filter((launchId) => LAUNCH_ID.test(launchId))
			.sort()
			.flatMap((launchId) => this.read(launchId) ?? []);
	}

	/** Writes a new manifest durably; refuses an existing one. */
	create(manifest: NewWorkerAcquisition): WorkerAcquisitionManifest {
		if (this.read(manifest.launch_id))
			throw new Error(`Acquisition manifest exists: ${manifest.launch_id}`);
		const at = this.#now();
		const full: WorkerAcquisitionManifest = {
			version: 1,
			kind: "maestro-worker-acquisition",
			...manifest,
			commands: [],
			created_at: at,
			updated_at: at,
		};
		this.#write(full);
		return full;
	}

	/** Applies `change` and writes the result durably. */
	update(
		launchId: string,
		change: (manifest: WorkerAcquisitionManifest) => void,
	): WorkerAcquisitionManifest {
		const manifest = this.read(launchId);
		if (!manifest) throw new Error(`No acquisition manifest: ${launchId}`);
		change(manifest);
		manifest.updated_at = this.#now();
		this.#write(manifest);
		return manifest;
	}

	/**
	 * Records a new command durably, before its transport. Its ID is a UUIDv7
	 * used once: a command ID is never sent again for another request.
	 */
	record(launchId: string, command: NewWorkerCommand): WorkerCommandRecord {
		if (!UUIDV7.test(command.command_id))
			throw new Error("A worker command ID is a UUIDv7");
		const record: WorkerCommandRecord = {
			...command,
			outcome: "pending",
			recorded_at: this.#now(),
		};
		this.update(launchId, (manifest) => {
			if (manifest.commands.some((c) => c.command_id === record.command_id))
				throw new Error("A worker command ID is used once");
			manifest.commands.push(record);
		});
		return record;
	}

	/**
	 * Records what a command's reply or receipt proved. `observed` and
	 * `no_effect` are final; an `unknown` may later be resolved by a receipt.
	 */
	settle(
		launchId: string,
		commandId: string,
		outcome: Exclude<WorkerCommandOutcome, "pending">,
		reason?: string,
	): void {
		this.update(launchId, (manifest) => {
			const command = manifest.commands.find((c) => c.command_id === commandId);
			if (!command) throw new Error(`No such command: ${commandId}`);
			if (command.outcome !== "pending" && command.outcome !== "unknown")
				throw new Error(`Command ${commandId} is already ${command.outcome}`);
			command.outcome = outcome;
			if (reason === undefined) delete command.reason;
			else command.reason = reason;
			command.settled_at = this.#now();
		});
	}

	/** Removes a manifest whose create proved no effect. Every other one is kept. */
	discard(launchId: string): void {
		const manifest = this.read(launchId);
		if (!manifest) return;
		if (manifest.state !== "not_acquired")
			throw new Error("Only a launch that acquired nothing is discarded");
		rmSync(this.#path(launchId), { force: true });
		fsyncDirectory(this.dir);
	}

	#path(launchId: string): string {
		if (!LAUNCH_ID.test(launchId)) throw new Error("A launch ID is a UUID");
		return join(this.dir, `${launchId}.json`);
	}

	#write(manifest: WorkerAcquisitionManifest): void {
		writeDurable(
			this.#path(manifest.launch_id),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
	}
}

/** An owned, non-symlink directory with no group or other access, made when missing. */
export function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.getuid !== undefined && stat.uid !== process.getuid()) ||
		(stat.mode & 0o077) !== 0
	)
		throw new Error(
			`${path} must be an owned, non-symlink directory with no group or other access`,
		);
}

/** Write-temporary, fsync, rename, directory fsync: the file is old or new, never torn. */
export function writeDurable(path: string, text: string): void {
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		const bytes = Buffer.from(text);
		let offset = 0;
		while (offset < bytes.length)
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		rmSync(temporary, { force: true });
		throw error;
	}
	closeSync(fd);
	renameSync(temporary, path);
	fsyncDirectory(dirname(path));
}

export function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
