/**
 * Owner-prepared worktree slots (P3-7, root decision Q3; P2-8 topology B).
 * The owner, before the sandboxed parent starts, makes each child slot a
 * locked linked worktree of the parent's own repository at
 * `PARENT/.piw-slots/<name>`, on its own `refs/heads/<namespace>/<leaf>`
 * branch at an exact base, and lists them in the slot manifest. The parent
 * never runs Git administrative writes: Maestro only checks a slot (plain file
 * reads, no `git` process) and durably claims an unused one before any B2
 * create. An exhausted pool or a slot that does not match its manifest is
 * refused before acquisition. A claim is kept for every launch that may have
 * acquired a worker; only a create that proved no effect releases it.
 */
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fsyncDirectory, privateDirectory } from "./launch-store.ts";

/** The directory of a parent's slots, as pi-worker requires it (`SLOTS_DIR`). */
export const SLOTS_DIR = ".piw-slots";

export interface WorkerSlot {
	/** `PARENT/.piw-slots/<name>`. */
	name: string;
	/** `refs/heads/<namespace>/<leaf>`, unique to this slot. */
	branch: string;
	/** The exact base commit the owner made the slot at. */
	baseSha: string;
}

/** What the owner records before the parent starts. */
export interface WorkerSlotManifest {
	version: 1;
	kind: "maestro-worker-slots";
	slots: WorkerSlot[];
}

export interface ClaimedSlot extends WorkerSlot {
	/** The slot's root: the child's cwd. */
	path: string;
	launchId: string;
}

export type WorkerSlotRefusalCode = "slots_exhausted" | "slot_mismatch";

/** A refused slot claim; nothing was claimed and nothing was sent. */
export class WorkerSlotRefusal extends Error {
	readonly code: WorkerSlotRefusalCode;
	constructor(code: WorkerSlotRefusalCode, message: string) {
		super(message);
		this.name = "WorkerSlotRefusal";
		this.code = code;
	}
}

const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^refs\/heads\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Parses and checks an owner slot manifest. */
export function parseSlotManifest(text: string): WorkerSlotManifest {
	// SAFETY: every field is checked below before the manifest is returned.
	const value = JSON.parse(text) as WorkerSlotManifest;
	if (
		value === null ||
		value.version !== 1 ||
		value.kind !== "maestro-worker-slots" ||
		!Array.isArray(value.slots)
	)
		throw new Error("Not a Maestro worker slot manifest (version 1)");
	const names = new Set<string>();
	const branches = new Set<string>();
	for (const slot of value.slots) {
		if (
			!SLOT_NAME.test(String(slot?.name)) ||
			slot.name === "." ||
			slot.name === ".."
		)
			throw new Error("A slot name is one path component of [A-Za-z0-9._-]");
		if (!BRANCH.test(String(slot.branch)) || slot.branch.includes(".."))
			throw new Error(
				`Slot ${slot.name}: its branch is refs/heads/<namespace>/<leaf>`,
			);
		if (!SHA.test(String(slot.baseSha)))
			throw new Error(`Slot ${slot.name}: its base is a full commit ID`);
		if (names.has(slot.name) || branches.has(slot.branch))
			throw new Error(`Slot ${slot.name}: names and branches are unique`);
		names.add(slot.name);
		branches.add(slot.branch);
	}
	return {
		version: 1,
		kind: "maestro-worker-slots",
		slots: value.slots.map((slot) => ({
			name: slot.name,
			branch: slot.branch,
			baseSha: slot.baseSha,
		})),
	};
}

export interface WorkerSlotPoolOptions {
	/** The parent's root (its sandbox root): the slots live in `root/.piw-slots`. */
	root: string;
	slots: readonly WorkerSlot[];
	/** Where claims are recorded: private to the parent, outside every slot. */
	claimsDir: string;
}

/** The owner's slots of one parent and their durable claims. */
export class WorkerSlotPool {
	readonly root: string;
	readonly slots: readonly WorkerSlot[];
	readonly claimsDir: string;

	constructor(options: WorkerSlotPoolOptions) {
		this.root = realpathSync(options.root);
		this.slots = parseSlotManifest(
			JSON.stringify({
				version: 1,
				kind: "maestro-worker-slots",
				slots: options.slots,
			}),
		).slots;
		this.claimsDir = resolve(options.claimsDir);
		const slotsRoot = join(this.root, SLOTS_DIR);
		if (
			this.claimsDir === slotsRoot ||
			this.claimsDir.startsWith(`${slotsRoot}/`)
		)
			throw new Error("Slot claims are recorded outside every slot");
		privateDirectory(this.claimsDir);
	}

	/** The launch holding `name`, or undefined when it is free. */
	holder(name: string): string | undefined {
		try {
			// SAFETY: only claim() writes this file, from this shape.
			return (
				JSON.parse(readFileSync(this.#claimPath(name), "utf8")) as {
					launch_id: string;
				}
			).launch_id;
		} catch {
			return undefined;
		}
	}

	/**
	 * Durably claims one free slot for `launchId`: the one whose branch leaf
	 * (or `<namespace>/<leaf>`) is `branch` when it is free, else the first free
	 * slot in manifest order. A `base` other than `HEAD` must be the slot's
	 * base. The chosen slot is checked against its manifest first; a mismatch
	 * is refused, never skipped.
	 */
	claim(
		launchId: string,
		request: { branch?: string; base?: string } = {},
	): ClaimedSlot {
		const free = this.slots.filter(
			(slot) => this.holder(slot.name) === undefined,
		);
		if (free.length === 0)
			throw new WorkerSlotRefusal(
				"slots_exhausted",
				`No owner-prepared worker slot is free (${this.slots.length} prepared, all claimed); refused before acquisition. Dynamic worktree creation needs an owner operation.`,
			);
		const wanted = request.branch;
		const slot =
			(wanted === undefined
				? undefined
				: free.find((candidate) => matchesBranch(candidate.branch, wanted))) ??
			free[0]!;
		const base = request.base;
		if (base !== undefined && base !== "HEAD" && base !== slot.baseSha)
			throw new WorkerSlotRefusal(
				"slot_mismatch",
				`Worker slot ${slot.name} is at base ${slot.baseSha}, not the requested ${base}; refused before acquisition.`,
			);
		const path = this.verify(slot);
		const claim = this.#claimPath(slot.name);
		let fd: number;
		try {
			fd = openSync(claim, "wx", 0o600);
		} catch {
			throw new WorkerSlotRefusal(
				"slots_exhausted",
				`Worker slot ${slot.name} was claimed concurrently; refused before acquisition.`,
			);
		}
		try {
			const bytes = Buffer.from(
				`${JSON.stringify({ launch_id: launchId, slot: slot.name, at: Date.now() })}\n`,
			);
			writeSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		fsyncDirectory(this.claimsDir);
		return { ...slot, path, launchId };
	}

	/** Releases a claim of `launchId`: only after its create proved no effect. */
	release(name: string, launchId: string): void {
		if (this.holder(name) !== launchId) return;
		rmSync(this.#claimPath(name), { force: true });
		fsyncDirectory(this.claimsDir);
	}

	/**
	 * Checks a slot against the manifest with plain reads: a real directory at
	 * `root/.piw-slots/<name>` (no symlink), a linked worktree of the parent's
	 * own repository registered back to this path, locked, on its branch, and
	 * that branch at the exact base. Returns its root.
	 */
	verify(slot: WorkerSlot): string {
		const mismatch = (why: string) =>
			new WorkerSlotRefusal(
				"slot_mismatch",
				`Worker slot ${slot.name} does not match its owner manifest: ${why}; refused before acquisition.`,
			);
		const slotsRoot = join(this.root, SLOTS_DIR);
		const path = join(slotsRoot, slot.name);
		for (const directory of [slotsRoot, path]) {
			let stat;
			try {
				stat = lstatSync(directory);
			} catch {
				throw mismatch(`${basename(directory)} is missing`);
			}
			if (stat.isSymbolicLink() || !stat.isDirectory())
				throw mismatch(`${basename(directory)} is not a real directory`);
		}
		const common = commonDirOf(this.root);
		if (!common) throw mismatch("the parent root has no Git repository");
		const gitDir = gitDirOf(path);
		if (!gitDir) throw mismatch("it is not a linked worktree");
		let slotCommon: string;
		try {
			slotCommon = realpathSync(
				resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()),
			);
		} catch {
			throw mismatch("its Git directory names no common directory");
		}
		if (slotCommon !== common)
			throw mismatch("its repository is not the parent's");
		if (
			realpathSync(dirname(gitDir)) !== realpathSync(join(common, "worktrees"))
		)
			throw mismatch(
				"its Git directory is not one of the repository's worktrees",
			);
		try {
			const back = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
			if (realpathSync(dirname(back)) !== path) throw new Error("elsewhere");
		} catch {
			throw mismatch("the repository registers it at another path");
		}
		try {
			lstatSync(join(gitDir, "locked"));
		} catch {
			throw mismatch("it is not locked");
		}
		let head: string;
		try {
			head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		} catch {
			throw mismatch("its HEAD is unreadable");
		}
		if (head !== `ref: ${slot.branch}`)
			throw mismatch(`it is not on ${slot.branch}`);
		const at = refOf(common, slot.branch);
		if (at !== slot.baseSha)
			throw mismatch(`${slot.branch} is not at its base`);
		return path;
	}

	#claimPath(name: string): string {
		if (!SLOT_NAME.test(name))
			throw new Error("A slot name is one path component");
		return join(this.claimsDir, `${name}.claim`);
	}
}

function matchesBranch(branch: string, wanted: string): boolean {
	const short = branch.slice("refs/heads/".length);
	return (
		branch === wanted ||
		short === wanted ||
		short.slice(short.indexOf("/") + 1) === wanted
	);
}

/** The Git directory a worktree's `.git` file names, or undefined. */
function gitDirOf(worktree: string): string | undefined {
	try {
		const dotGit = join(worktree, ".git");
		if (!lstatSync(dotGit).isFile()) return undefined;
		const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"));
		if (!match) return undefined;
		const named = match[1]!.trim();
		return realpathSync(isAbsolute(named) ? named : resolve(worktree, named));
	} catch {
		return undefined;
	}
}

/** The real common directory of the repository holding `root` (a linked or main worktree). */
function commonDirOf(root: string): string | undefined {
	const linked = gitDirOf(root);
	try {
		if (linked)
			return realpathSync(
				resolve(linked, readFileSync(join(linked, "commondir"), "utf8").trim()),
			);
		const main = join(root, ".git");
		if (lstatSync(main).isDirectory()) return realpathSync(main);
	} catch {
		return undefined;
	}
	return undefined;
}

/** A branch's commit from its loose ref or `packed-refs`; undefined when neither names it. */
function refOf(common: string, ref: string): string | undefined {
	try {
		const loose = readFileSync(join(common, ref), "utf8").trim();
		if (SHA.test(loose)) return loose;
	} catch {
		/* not loose: packed */
	}
	try {
		for (const line of readFileSync(join(common, "packed-refs"), "utf8").split(
			"\n",
		)) {
			const [sha, name] = line.split(" ");
			if (name === ref && sha && SHA.test(sha)) return sha;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
