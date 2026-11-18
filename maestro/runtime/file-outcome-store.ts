/**
 * The file-backed OutcomeStore (P3-8): one writer per directory, a versioned
 * and checksummed append journal fsynced per record, and atomic snapshot
 * compaction. No database dependency.
 *
 * Layout (directory 0700, files 0600):
 * - `writer.lock`: the single writer's `{pid, host, token}`; linked into place
 *   atomically, so it is never torn. A lock whose process is gone on this host
 *   is recovered by the next opener; a live or foreign holder refuses the open.
 * - `snapshot.json`: the compacted state at a sequence number, replaced by an
 *   fsynced temporary file, rename and directory fsync.
 * - `journal.jsonl`: one record per line after the snapshot's sequence. Each
 *   line is `{"v":1,"seq":N,"sum":"<sha256>","rec":{...}}`; the checksum covers
 *   the sequence and the exact record text.
 *
 * Recovery: an incomplete or invalid last line is a torn append that never
 * resolved, so it is cut off. Any other invalid line, a sequence gap or an
 * unknown version refuses the open: nothing is guessed. Records at or below
 * the snapshot's sequence (a crash during compaction) are skipped.
 *
 * Placement: terminal hosts use `terminalOutcomeStoreDir`, a private directory
 * per parent under the existing `herdr-agents` config namespace. It survives
 * process restarts, not disk loss or a hostile same-UID writer.
 */
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	OUTCOME_JOURNAL_VERSION,
	OUTCOME_RECORD_LIMIT,
	OutcomeStoreError,
	assertOutcomeJson,
	boundOutcomeText,
	canTransition,
	isFinalDelivery,
	outcomeDedupeKey,
	outcomeDigest,
	validateOutcomeAttempt,
	validateOutcomeCheck,
	validateOutcomeDraft,
	type CheckedOutcome,
	type FinalDelivery,
	type InterruptedRun,
	type OutcomeAttempt,
	type OutcomeBatch,
	type OutcomeCheckStart,
	type OutcomeDelivery,
	type OutcomeDraft,
	type OutcomeJson,
	type OutcomeRecovery,
	type OutcomeSettlement,
	type OutcomeStore,
	type StoredOutcome,
} from "../core/outcome-store.ts";
import {
	isFiniteNumber,
	isRecord,
	isString,
} from "../core/config/type-guards.ts";

/** The synchronous file operations the store uses; tests inject faults and crashes. */
export interface OutcomeStoreFs {
	mkdirSync(path: string, options: { recursive: true; mode: number }): void;
	openSync(path: string, flags: string, mode?: number): number;
	writeSync(
		fd: number,
		buffer: Uint8Array,
		offset: number,
		length: number,
	): number;
	fsyncSync(fd: number): void;
	ftruncateSync(fd: number, length: number): void;
	closeSync(fd: number): void;
	readFileSync(path: string): Buffer;
	renameSync(from: string, to: string): void;
	linkSync(existing: string, link: string): void;
	unlinkSync(path: string): void;
}

/** The store's default operations over `node:fs`. */
export const nodeOutcomeStoreFs: OutcomeStoreFs = {
	mkdirSync: (path, options) => {
		nodeFs.mkdirSync(path, options);
	},
	openSync: (path, flags, mode) => nodeFs.openSync(path, flags, mode),
	writeSync: (fd, buffer, offset, length) =>
		nodeFs.writeSync(fd, buffer, offset, length),
	fsyncSync: (fd) => nodeFs.fsyncSync(fd),
	ftruncateSync: (fd, length) => nodeFs.ftruncateSync(fd, length),
	closeSync: (fd) => nodeFs.closeSync(fd),
	readFileSync: (path) => nodeFs.readFileSync(path),
	renameSync: (from, to) => nodeFs.renameSync(from, to),
	linkSync: (existing, link) => nodeFs.linkSync(existing, link),
	unlinkSync: (path) => nodeFs.unlinkSync(path),
};

export interface FileOutcomeStoreOptions {
	/** The store directory; created 0700 when missing. */
	dir: string;
	/** The parent identity this store delivers to. */
	parent: string;
	/**
	 * Take over a store written for another parent identity. Never implied by a
	 * matching cwd or name: a new parent adopts stored outcomes explicitly.
	 */
	adopt?: boolean;
	/** Journal records after which an append compacts. Default 512. */
	compactAfter?: number;
	/** Delivered (final) delivery identities kept for deduplication. Default 1024. */
	retainFinal?: number;
	fs?: OutcomeStoreFs;
	/** Whether a process on this host is alive; tests inject one. */
	isProcessAlive?: (pid: number) => boolean;
	host?: string;
	pid?: number;
	now?: () => number;
	newId?: () => string;
}

const LOCK_FILE = "writer.lock";
const SNAPSHOT_FILE = "snapshot.json";
const JOURNAL_FILE = "journal.jsonl";
const LINE =
	/^\{"v":(\d+),"seq":(\d+),"sum":"([0-9a-f]{64})","rec":(\{.*\})\}$/s;
const SNAPSHOT =
	/^\{"v":(\d+),"seq":(\d+),"sum":"([0-9a-f]{64})","state":(\{.*\})\}$/s;

/** A private per-parent directory under the `herdr-agents` config namespace. */
export function terminalOutcomeStoreDir(
	configDir: string,
	parent: string,
): string {
	const id = createHash("sha256").update(parent).digest("hex").slice(0, 32);
	return join(configDir, "herdr-agents", "outcome-store", id);
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
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

function checksum(seq: number, raw: string): string {
	return createHash("sha256").update(`${seq}:${raw}`).digest("hex");
}

function corrupt(message: string): never {
	throw new OutcomeStoreError("corrupt", message);
}

// Journal records. Field names are part of the v1 on-disk format.
interface OpenRecord {
	type: "open";
	owner: string;
	parent: string;
	adopted?: boolean;
	at: number;
}
interface AttemptRecord {
	type: "attempt";
	owner: string;
	attempt: OutcomeAttempt;
}
interface CheckRecord {
	type: "check";
	owner: string;
	check: OutcomeCheckStart;
}
interface BatchRecord {
	type: "batch";
	outcomes: { outcome: CheckedOutcome; closesRun: boolean }[];
	observer?: { key: string; state: OutcomeJson };
	at: number;
}
interface DeliveryRecord {
	type: "delivery";
	deliveryId: string;
	delivery: OutcomeDelivery;
}
interface ClosedRecord {
	type: "closed";
	owner: string;
	taskId: string;
	reason: string;
	at: number;
}
type JournalRecord =
	| OpenRecord
	| AttemptRecord
	| CheckRecord
	| BatchRecord
	| DeliveryRecord
	| ClosedRecord;

interface FinalEntry extends FinalDelivery {
	dedupeKey: string;
}

/** The compacted state; also the in-memory model every record is applied to. */
interface StoreState {
	parent?: string;
	owners: { owner: string; at: number; adopted?: boolean }[];
	runs: InterruptedRun[];
	outcomes: StoredOutcome[];
	final: FinalEntry[];
	observers: { key: string; state: OutcomeJson }[];
}

const OWNER_HISTORY = 64;

class Model {
	parent?: string;
	owners: StoreState["owners"] = [];
	readonly runs = new Map<string, InterruptedRun>();
	readonly outcomes = new Map<string, StoredOutcome>();
	readonly final = new Map<string, FinalEntry>();
	readonly keys = new Map<string, string>();
	readonly observers = new Map<string, OutcomeJson>();

	private readonly retainFinal: number;

	constructor(retainFinal: number) {
		this.retainFinal = retainFinal;
	}

	static runKey(owner: string, taskId: string): string {
		return JSON.stringify([owner, taskId]);
	}

	load(state: StoreState): void {
		this.parent = state.parent;
		this.owners = [...state.owners];
		for (const run of state.runs)
			this.runs.set(Model.runKey(run.owner, run.taskId), run);
		for (const stored of state.outcomes) {
			this.outcomes.set(stored.outcome.deliveryId, stored);
			this.keys.set(stored.outcome.dedupeKey, stored.outcome.deliveryId);
		}
		for (const entry of state.final) {
			this.final.set(entry.deliveryId, entry);
			this.keys.set(entry.dedupeKey, entry.deliveryId);
		}
		for (const { key, state: value } of state.observers)
			this.observers.set(key, value);
	}

	save(): StoreState {
		const state: StoreState = {
			owners: this.owners,
			runs: [...this.runs.values()],
			outcomes: [...this.outcomes.values()],
			final: [...this.final.values()],
			observers: [...this.observers].map(([key, value]) => ({
				key,
				state: value,
			})),
		};
		if (this.parent !== undefined) state.parent = this.parent;
		return state;
	}

	/** Applies one durable record; a record that cannot apply is corruption. */
	apply(record: JournalRecord): void {
		switch (record.type) {
			case "open":
				this.parent = record.parent;
				this.owners.push(
					record.adopted
						? { owner: record.owner, at: record.at, adopted: true }
						: { owner: record.owner, at: record.at },
				);
				if (this.owners.length > OWNER_HISTORY)
					this.owners.splice(0, this.owners.length - OWNER_HISTORY);
				return;
			case "attempt":
				this.run(record.owner, record.attempt.taskId).attempts.push(
					record.attempt,
				);
				return;
			case "check":
				this.run(record.owner, record.check.taskId).checks.push(record.check);
				return;
			case "batch":
				for (const { outcome, closesRun } of record.outcomes) {
					if (this.keys.has(outcome.dedupeKey))
						corrupt(`Duplicate outcome ${outcome.deliveryId} in journal.`);
					this.outcomes.set(outcome.deliveryId, {
						outcome,
						delivery: {
							state: "pending",
							attempts: 0,
							at: outcome.committedAt,
						},
					});
					this.keys.set(outcome.dedupeKey, outcome.deliveryId);
					if (closesRun)
						this.runs.delete(Model.runKey(outcome.owner, outcome.taskId));
				}
				if (record.observer)
					this.observers.set(record.observer.key, record.observer.state);
				return;
			case "delivery": {
				const stored = this.outcomes.get(record.deliveryId);
				if (
					!stored ||
					!canTransition(stored.delivery.state, record.delivery.state)
				)
					corrupt(`Invalid delivery record for ${record.deliveryId}.`);
				stored.delivery = record.delivery;
				if (isFinalDelivery(record.delivery.state)) {
					this.outcomes.delete(record.deliveryId);
					const entry: FinalEntry = {
						deliveryId: record.deliveryId,
						dedupeKey: stored.outcome.dedupeKey,
						state: record.delivery.state,
						at: record.delivery.at,
					};
					if (record.delivery.evidence)
						entry.evidence = record.delivery.evidence;
					this.final.set(record.deliveryId, entry);
					this.trimFinal();
				}
				return;
			}
			case "closed":
				this.runs.delete(Model.runKey(record.owner, record.taskId));
				return;
			default:
				corrupt("Unknown journal record type.");
		}
	}

	private run(owner: string, taskId: string): InterruptedRun {
		const key = Model.runKey(owner, taskId);
		let run = this.runs.get(key);
		if (!run) {
			run = { owner, taskId, attempts: [], checks: [] };
			this.runs.set(key, run);
		}
		return run;
	}

	private trimFinal(): void {
		for (const [id, entry] of this.final) {
			if (this.final.size <= this.retainFinal) break;
			this.final.delete(id);
			if (this.keys.get(entry.dedupeKey) === id)
				this.keys.delete(entry.dedupeKey);
		}
	}
}

/** Shape checks for values read back from disk; the checksum proved the bytes. */
function parseRecord(raw: string): JournalRecord {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		corrupt("Journal record is not JSON.");
	}
	// The record's bytes match the checksum this writer computed over its own
	// serialized JournalRecord; only its discriminant is re-checked here.
	const record: JournalRecord = value;
	if (!isRecord(value) || !isString(value.type))
		corrupt("Journal record has no type.");
	return record;
}

function parseState(raw: string): StoreState {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		corrupt("Snapshot state is not JSON.");
	}
	// The bytes match the checksum this writer computed over its own serialized
	// StoreState; every collection is checked to be an array below.
	const state: StoreState = value;
	if (
		!isRecord(value) ||
		!Array.isArray(value.owners) ||
		!Array.isArray(value.runs) ||
		!Array.isArray(value.outcomes) ||
		!Array.isArray(value.final) ||
		!Array.isArray(value.observers)
	)
		corrupt("Snapshot state is malformed.");
	return state;
}

function version(value: string): void {
	if (Number(value) !== OUTCOME_JOURNAL_VERSION)
		throw new OutcomeStoreError(
			"version",
			`Unsupported outcome journal version ${value}; this Maestro reads version ${OUTCOME_JOURNAL_VERSION}.`,
		);
}

export class FileOutcomeStore implements OutcomeStore {
	readonly parent: string;
	readonly owner: string;
	private readonly dir: string;
	private readonly fs: OutcomeStoreFs;
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly compactAfter: number;
	private readonly model: Model;
	private readonly lockToken: string;
	private journalFd: number;
	private journalSize: number;
	private seq: number;
	private sinceSnapshot: number;
	private closed = false;
	private broken?: string;

	private constructor(init: {
		options: FileOutcomeStoreOptions;
		fs: OutcomeStoreFs;
		model: Model;
		lockToken: string;
		journalFd: number;
		journalSize: number;
		seq: number;
		sinceSnapshot: number;
		owner: string;
	}) {
		const { options } = init;
		this.dir = options.dir;
		this.parent = options.parent;
		this.owner = init.owner;
		this.fs = init.fs;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? randomUUID;
		this.compactAfter = options.compactAfter ?? 512;
		this.model = init.model;
		this.lockToken = init.lockToken;
		this.journalFd = init.journalFd;
		this.journalSize = init.journalSize;
		this.seq = init.seq;
		this.sinceSnapshot = init.sinceSnapshot;
	}

	/**
	 * Opens the store as its single writer: takes the lock, validates the
	 * snapshot and journal, cuts a torn tail, then records this owner. Every
	 * `dispatching` delivery left by an earlier owner becomes `uncertain`.
	 */
	static async open(
		options: FileOutcomeStoreOptions,
	): Promise<FileOutcomeStore> {
		if (!options.parent)
			throw new OutcomeStoreError(
				"invalid",
				"Outcome store parent is required.",
			);
		const fs = options.fs ?? nodeOutcomeStoreFs;
		const now = options.now ?? Date.now;
		const newId = options.newId ?? randomUUID;
		try {
			fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
		} catch (error) {
			throw new OutcomeStoreError(
				"io",
				`Cannot create the outcome store directory: ${errorText(error)}`,
				{ cause: error },
			);
		}
		const lockToken = acquireLock(fs, options, newId());
		let journalFd: number | undefined;
		try {
			const model = new Model(options.retainFinal ?? 1024);
			let seq = 0;
			const snapshot = readOptional(fs, join(options.dir, SNAPSHOT_FILE));
			if (snapshot !== undefined) {
				// The snapshot ends with one newline; the pattern anchors the record.
				const match = SNAPSHOT.exec(
					snapshot.toString("utf8").replace(/\n$/, ""),
				);
				if (!match) corrupt("Outcome snapshot is malformed.");
				version(match[1]);
				seq = Number(match[2]);
				if (checksum(seq, match[4]) !== match[3])
					corrupt("Outcome snapshot checksum does not match.");
				model.load(parseState(match[4]));
			}
			const journalPath = join(options.dir, JOURNAL_FILE);
			const existing = readOptional(fs, journalPath);
			const journal = existing ?? Buffer.alloc(0);
			const { size, records, lastSeq } = replay(journal, seq, model);
			journalFd = fs.openSync(journalPath, "a", 0o600);
			if (size < journal.length) {
				// The cut tail never resolved its append; nothing durable is lost.
				fs.ftruncateSync(journalFd, size);
				fs.fsyncSync(journalFd);
			}
			if (existing === undefined) syncDir(fs, options.dir);
			if (
				model.parent !== undefined &&
				model.parent !== options.parent &&
				!options.adopt
			)
				throw new OutcomeStoreError(
					"parent",
					"This outcome store belongs to another parent; adopt it explicitly to take over its outcomes.",
				);
			const store = new FileOutcomeStore({
				options,
				fs,
				model,
				lockToken,
				journalFd,
				journalSize: size,
				seq: lastSeq,
				sinceSnapshot: records,
				owner: newId(),
			});
			const adopted =
				model.parent !== undefined && model.parent !== options.parent;
			const open: OpenRecord = {
				type: "open",
				owner: store.owner,
				parent: options.parent,
				at: now(),
			};
			if (adopted) open.adopted = true;
			store.append(open);
			for (const stored of model.outcomes.values())
				if (stored.delivery.state === "dispatching")
					store.append({
						type: "delivery",
						deliveryId: stored.outcome.deliveryId,
						delivery: {
							...stored.delivery,
							state: "uncertain",
							reason:
								"dispatch interrupted: the previous owner stopped after marking it dispatching",
							at: now(),
						},
					});
			return store;
		} catch (error) {
			if (journalFd !== undefined) closeQuietly(fs, journalFd);
			releaseLock(fs, options.dir, lockToken);
			throw error;
		}
	}

	async recordAttempt(attempt: Omit<OutcomeAttempt, "at">): Promise<void> {
		validateOutcomeAttempt(attempt);
		this.append({
			type: "attempt",
			owner: this.owner,
			attempt: { ...attempt, at: this.now() },
		});
	}

	async recordCheck(check: Omit<OutcomeCheckStart, "at">): Promise<void> {
		validateOutcomeCheck(check);
		this.append({
			type: "check",
			owner: this.owner,
			check: { ...check, at: this.now() },
		});
	}

	async commit(draft: OutcomeDraft): Promise<StoredOutcome> {
		const [stored] = await this.commitBatch({ outcomes: [draft] });
		return stored!;
	}

	async commitBatch(batch: OutcomeBatch): Promise<StoredOutcome[]> {
		this.usable();
		const at = this.now();
		const order: string[] = [];
		const fresh: BatchRecord["outcomes"] = [];
		const keys = new Map<string, CheckedOutcome>();
		for (const draft of batch.outcomes ?? []) {
			validateOutcomeDraft(draft);
			const outcome = this.checked(draft, at);
			const existing = this.existing(outcome, draft.deliveryId, keys);
			if (existing) {
				order.push(existing.deliveryId);
				continue;
			}
			keys.set(outcome.dedupeKey, outcome);
			order.push(outcome.deliveryId);
			fresh.push({
				outcome,
				closesRun: draft.closesRun ?? draft.kind === "result",
			});
		}
		if (batch.observer) {
			if (!batch.observer.key)
				throw new OutcomeStoreError(
					"invalid",
					"Observer state key is required.",
				);
			assertOutcomeJson(batch.observer.state, "observer state");
		}
		if (fresh.length || batch.observer) {
			const record: BatchRecord = { type: "batch", outcomes: fresh, at };
			if (batch.observer)
				record.observer = {
					key: batch.observer.key,
					state: structuredClone(batch.observer.state),
				};
			this.append(record);
		}
		return order.map((id) => structuredClone(this.model.outcomes.get(id)!));
	}

	async dispatch(deliveryId: string): Promise<OutcomeDelivery> {
		const stored = this.stored(deliveryId);
		this.transition(stored, "dispatching");
		const delivery: OutcomeDelivery = {
			state: "dispatching",
			attempts: stored.delivery.attempts + 1,
			commandId: this.newId(),
			at: this.now(),
		};
		this.append({ type: "delivery", deliveryId, delivery });
		return delivery;
	}

	async settle(
		deliveryId: string,
		settlement: OutcomeSettlement,
	): Promise<OutcomeDelivery> {
		const stored = this.stored(deliveryId);
		this.transition(stored, settlement.state);
		if (settlement.state === "admitted" && !settlement.evidence)
			throw new OutcomeStoreError(
				"invalid",
				"Admission needs its evidence kind.",
			);
		const delivery: OutcomeDelivery = {
			state: settlement.state,
			attempts: stored.delivery.attempts,
			at: this.now(),
		};
		if (stored.delivery.commandId)
			delivery.commandId = stored.delivery.commandId;
		if (settlement.evidence) delivery.evidence = settlement.evidence;
		if (settlement.reason !== undefined) delivery.reason = settlement.reason;
		this.append({ type: "delivery", deliveryId, delivery });
		return delivery;
	}

	async closeRun(
		taskId: string,
		reason: string,
		owner = this.owner,
	): Promise<void> {
		this.usable();
		if (!this.model.runs.has(Model.runKey(owner, taskId))) return;
		this.append({ type: "closed", owner, taskId, reason, at: this.now() });
	}

	get(deliveryId: string): StoredOutcome | undefined {
		const stored = this.model.outcomes.get(deliveryId);
		return stored && structuredClone(stored);
	}

	observerState(key: string): OutcomeJson | undefined {
		const state = this.model.observers.get(key);
		return state === undefined ? undefined : structuredClone(state);
	}

	recovery(): OutcomeRecovery {
		return structuredClone({
			parent: this.parent,
			owner: this.owner,
			outcomes: [...this.model.outcomes.values()],
			interrupted: [...this.model.runs.values()],
			final: [...this.model.final.values()].map(
				({ dedupeKey: _key, ...entry }) => entry,
			),
		});
	}

	/**
	 * Snapshot then truncate. Every cut is safe: until the rename is durable
	 * the old snapshot and journal stand; afterwards the journal's records are
	 * at or below the snapshot's sequence and are skipped.
	 */
	async compact(): Promise<void> {
		this.usable();
		const raw = JSON.stringify(this.model.save());
		const body = `{"v":${OUTCOME_JOURNAL_VERSION},"seq":${this.seq},"sum":"${checksum(this.seq, raw)}","state":${raw}}\n`;
		const tmp = join(this.dir, `${SNAPSHOT_FILE}.${this.newId()}.tmp`);
		try {
			const fd = this.fs.openSync(tmp, "wx", 0o600);
			try {
				writeAll(this.fs, fd, Buffer.from(body, "utf8"));
				this.fs.fsyncSync(fd);
			} finally {
				this.fs.closeSync(fd);
			}
			this.fs.renameSync(tmp, join(this.dir, SNAPSHOT_FILE));
		} catch (error) {
			try {
				this.fs.unlinkSync(tmp);
			} catch {
				/* the temporary file may not exist */
			}
			throw new OutcomeStoreError(
				"io",
				`Outcome snapshot failed: ${errorText(error)}`,
				{ cause: error },
			);
		}
		try {
			syncDir(this.fs, this.dir);
			this.fs.ftruncateSync(this.journalFd, 0);
			this.fs.fsyncSync(this.journalFd);
		} catch (error) {
			// The snapshot may be in place; the journal still replays above it.
			throw new OutcomeStoreError(
				"io",
				`Outcome journal truncation failed: ${errorText(error)}`,
				{ cause: error },
			);
		}
		this.journalSize = 0;
		this.sinceSnapshot = 0;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		closeQuietly(this.fs, this.journalFd);
		releaseLock(this.fs, this.dir, this.lockToken);
	}

	private checked(draft: OutcomeDraft, at: number): CheckedOutcome {
		const { text, truncated } = boundOutcomeText(draft.text);
		const outcome: CheckedOutcome = {
			deliveryId: draft.deliveryId ?? this.newId(),
			dedupeKey: outcomeDedupeKey(this.parent, this.owner, draft),
			parent: this.parent,
			owner: this.owner,
			taskId: draft.taskId,
			attempt: draft.attempt,
			kind: draft.kind,
			outcome: draft.outcome,
			text,
			textDigest: outcomeDigest(draft.text),
			textTruncated: truncated,
			committedAt: at,
		};
		for (const field of [
			"generation",
			"reportId",
			"runId",
			"textSource",
		] as const)
			if (draft[field] !== undefined) outcome[field] = draft[field];
		if (draft.exitCode !== undefined) outcome.exitCode = draft.exitCode;
		for (const field of [
			"verdict",
			"subject",
			"cancellation",
			"facts",
		] as const)
			if (draft[field] !== undefined)
				outcome[field] = structuredClone(draft[field]);
		if (draft.envelope !== undefined) {
			outcome.envelope = draft.envelope;
			outcome.envelopeDigest = outcomeDigest(draft.envelope);
		}
		return outcome;
	}

	/**
	 * The same logical outcome again (same dedupe key and content, and no other
	 * delivery identity) returns the original. Anything else conflicts.
	 */
	private existing(
		outcome: CheckedOutcome,
		explicitId: string | undefined,
		batch: Map<string, CheckedOutcome>,
	): CheckedOutcome | undefined {
		const byKey = this.model.keys.get(outcome.dedupeKey);
		const prior =
			batch.get(outcome.dedupeKey) ??
			(byKey === undefined
				? undefined
				: this.model.outcomes.get(byKey)?.outcome);
		if (prior) {
			if (
				prior.textDigest === outcome.textDigest &&
				prior.outcome === outcome.outcome &&
				(explicitId === undefined || explicitId === prior.deliveryId)
			)
				return prior;
			throw new OutcomeStoreError(
				"conflict",
				`A different outcome is already committed for this run attempt (${prior.deliveryId}).`,
			);
		}
		if (byKey !== undefined)
			throw new OutcomeStoreError(
				"conflict",
				`This outcome was already delivered or withdrawn (${byKey}); it is not committed again.`,
			);
		if (
			explicitId !== undefined &&
			(this.model.outcomes.has(explicitId) ||
				this.model.final.has(explicitId) ||
				[...batch.values()].some((item) => item.deliveryId === explicitId))
		)
			throw new OutcomeStoreError(
				"conflict",
				`Delivery ${explicitId} already names another outcome.`,
			);
		return undefined;
	}

	private stored(deliveryId: string): StoredOutcome {
		this.usable();
		const stored = this.model.outcomes.get(deliveryId);
		if (!stored) {
			const final = this.model.final.get(deliveryId);
			throw new OutcomeStoreError(
				final ? "transition" : "unknown",
				final
					? `Delivery ${deliveryId} is already ${final.state}.`
					: `Unknown delivery ${deliveryId}.`,
			);
		}
		return stored;
	}

	private transition(
		stored: StoredOutcome,
		to: OutcomeDelivery["state"],
	): void {
		if (!canTransition(stored.delivery.state, to))
			throw new OutcomeStoreError(
				"transition",
				`Delivery ${stored.outcome.deliveryId} cannot move from ${stored.delivery.state} to ${to}.`,
			);
	}

	private usable(): void {
		if (this.closed)
			throw new OutcomeStoreError("closed", "The outcome store is closed.");
		if (this.broken)
			throw new OutcomeStoreError(
				"broken",
				`The outcome store stopped after a failed write: ${this.broken}`,
			);
	}

	/** Writes one record and fsyncs it; the model changes only after that. */
	private append(record: JournalRecord): void {
		this.usable();
		this.assertLockHeld();
		const seq = this.seq + 1;
		const raw = JSON.stringify(record);
		const line = Buffer.from(
			`{"v":${OUTCOME_JOURNAL_VERSION},"seq":${seq},"sum":"${checksum(seq, raw)}","rec":${raw}}\n`,
			"utf8",
		);
		if (line.length > OUTCOME_RECORD_LIMIT)
			throw new OutcomeStoreError(
				"limit",
				`Outcome record of ${line.length} bytes exceeds ${OUTCOME_RECORD_LIMIT}.`,
			);
		try {
			writeAll(this.fs, this.journalFd, line);
		} catch (error) {
			this.rollback(error);
			throw new OutcomeStoreError(
				"io",
				`Outcome journal write failed: ${errorText(error)}`,
				{ cause: error },
			);
		}
		try {
			this.fs.fsyncSync(this.journalFd);
		} catch (error) {
			// After a failed fsync the page cache cannot be trusted: stop writing.
			this.broken = errorText(error);
			try {
				this.fs.ftruncateSync(this.journalFd, this.journalSize);
			} catch {
				/* already broken */
			}
			throw new OutcomeStoreError(
				"io",
				`Outcome journal fsync failed: ${this.broken}`,
				{ cause: error },
			);
		}
		this.seq = seq;
		this.journalSize += line.length;
		this.sinceSnapshot++;
		this.model.apply(record);
		if (this.sinceSnapshot >= this.compactAfter) {
			// The record is durable; a failed compaction leaves a longer journal.
			void this.compact().catch(() => {});
		}
	}

	private rollback(cause: any): void {
		try {
			this.fs.ftruncateSync(this.journalFd, this.journalSize);
			this.fs.fsyncSync(this.journalFd);
		} catch {
			this.broken = `${errorText(cause)}; the partial record could not be removed`;
		}
	}

	private assertLockHeld(): void {
		let held = false;
		try {
			held =
				parseLock(this.fs.readFileSync(join(this.dir, LOCK_FILE)))?.token ===
				this.lockToken;
		} catch {
			held = false;
		}
		if (!held) {
			this.broken = "the writer lock is no longer held";
			throw new OutcomeStoreError(
				"locked",
				"The outcome store's writer lock was removed or taken over; this writer stopped.",
			);
		}
	}
}

export function openFileOutcomeStore(
	options: FileOutcomeStoreOptions,
): Promise<FileOutcomeStore> {
	return FileOutcomeStore.open(options);
}

interface Replayed {
	/** Bytes of valid records; anything after is a torn tail to cut. */
	size: number;
	/** Records applied above the snapshot. */
	records: number;
	lastSeq: number;
}

function replay(journal: Buffer, snapshotSeq: number, model: Model): Replayed {
	let offset = 0;
	let lastSeq = snapshotSeq;
	let records = 0;
	const text = journal.toString("utf8");
	const lines = text.split("\n");
	// The text after the last newline is an append that never completed.
	const complete = lines.slice(0, -1);
	let validEnd = 0;
	for (let index = 0; index < complete.length; index++) {
		const lineText = complete[index]!;
		const bytes = Buffer.byteLength(lineText, "utf8") + 1;
		const match = LINE.exec(lineText);
		const seq = match ? Number(match[2]) : NaN;
		const valid = !!match && checksum(seq, match[4]) === match[3];
		if (!valid) {
			// Only the final line can be a torn append; anything earlier is damage.
			if (index === complete.length - 1) break;
			corrupt(`Outcome journal record ${index + 1} is damaged.`);
		}
		version(match[1]);
		offset += bytes;
		if (seq <= snapshotSeq) {
			validEnd = offset;
			continue;
		}
		if (seq !== lastSeq + 1)
			corrupt(`Outcome journal sequence jumps from ${lastSeq} to ${seq}.`);
		model.apply(parseRecord(match[4]));
		lastSeq = seq;
		records++;
		validEnd = offset;
	}
	return { size: validEnd, records, lastSeq };
}

function readOptional(fs: OutcomeStoreFs, path: string): Buffer | undefined {
	try {
		return fs.readFileSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw new OutcomeStoreError(
			"io",
			`Cannot read the outcome store: ${errorText(error)}`,
			{ cause: error },
		);
	}
}

function writeAll(fs: OutcomeStoreFs, fd: number, buffer: Buffer): void {
	let written = 0;
	while (written < buffer.length) {
		const count = fs.writeSync(fd, buffer, written, buffer.length - written);
		if (count <= 0) throw new Error("short write");
		written += count;
	}
}

function syncDir(fs: OutcomeStoreFs, dir: string): void {
	// Windows cannot open a directory for fsync; its renames are not ordered by one.
	if (process.platform === "win32") return;
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function closeQuietly(fs: OutcomeStoreFs, fd: number): void {
	try {
		fs.closeSync(fd);
	} catch {
		/* already closed */
	}
}

interface LockHolder {
	pid: number;
	host: string;
	token: string;
}

function parseLock(raw: Buffer): LockHolder | undefined {
	let value: any;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		return undefined;
	}
	if (
		!isRecord(value) ||
		!isFiniteNumber(value.pid) ||
		!isString(value.host) ||
		!isString(value.token)
	)
		return undefined;
	return { pid: value.pid, host: value.host, token: value.token };
}

/**
 * The lock is written to a private file and linked into place, so a holder's
 * content is always complete. A holder whose process is gone on this host is
 * moved aside and verified before it is discarded, so two recoverers cannot
 * both win; anything unreadable or foreign stays held (fail closed).
 */
function acquireLock(
	fs: OutcomeStoreFs,
	options: FileOutcomeStoreOptions,
	token: string,
): string {
	const lock = join(options.dir, LOCK_FILE);
	const host = options.host ?? hostname();
	const pid = options.pid ?? process.pid;
	const alive = options.isProcessAlive ?? defaultIsProcessAlive;
	const body = Buffer.from(
		JSON.stringify({ pid, host, token, at: (options.now ?? Date.now)() }),
		"utf8",
	);
	const mine = `${lock}.${token}`;
	try {
		const fd = fs.openSync(mine, "wx", 0o600);
		try {
			writeAll(fs, fd, body);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		for (let tries = 0; tries < 8; tries++) {
			try {
				fs.linkSync(mine, lock);
				syncDir(fs, options.dir);
				return token;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const raw = readOptional(fs, lock);
			if (raw === undefined) continue;
			const holder = parseLock(raw);
			if (!holder || holder.host !== host || alive(holder.pid))
				throw new OutcomeStoreError(
					"locked",
					`The outcome store at ${options.dir} has another writer (${holder ? `process ${holder.pid} on ${holder.host}` : "unreadable lock"}); one writer per store.`,
				);
			const aside = `${lock}.stale-${token}`;
			try {
				fs.renameSync(lock, aside);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			const moved = readOptional(fs, aside);
			if (moved && !moved.equals(raw)) {
				// Another opener replaced the stale lock first: put its lock back.
				try {
					fs.linkSync(aside, lock);
				} catch {
					/* a third opener holds it now; the moved holder sees its lock lost */
				}
			}
			fs.unlinkSync(aside);
		}
		throw new OutcomeStoreError(
			"locked",
			`Could not take the outcome store lock at ${options.dir}.`,
		);
	} catch (error) {
		if (error instanceof OutcomeStoreError) throw error;
		throw new OutcomeStoreError(
			"io",
			`Cannot lock the outcome store: ${errorText(error)}`,
			{ cause: error },
		);
	} finally {
		try {
			fs.unlinkSync(mine);
		} catch {
			/* never created */
		}
	}
}

function releaseLock(fs: OutcomeStoreFs, dir: string, token: string): void {
	const lock = join(dir, LOCK_FILE);
	try {
		if (parseLock(fs.readFileSync(lock))?.token === token) fs.unlinkSync(lock);
	} catch {
		/* already gone */
	}
}
