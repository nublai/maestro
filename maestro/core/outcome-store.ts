/**
 * Maestro's checked-outcome outbox (P3-8): the injected store a run owner
 * commits a finalized outcome to before it is delivered or its run retired.
 *
 * - One record per outcome holds the bounded result, its verdict and evidence
 *   and the `pending` delivery state, so a crash leaves either nothing or the
 *   whole outcome. Every write is durable before its promise resolves.
 * - Delivery moves `pending -> dispatching -> admitted`, or to `uncertain`,
 *   `blocked` or `suppressed`. `dispatching` is durable before any transport,
 *   so a crash after it can only ever recover as `uncertain`: never resent.
 * - Terminal admission (`process-local`) is weaker than a receipt: it proves
 *   the parent's own process took the message, nothing after a crash.
 * - Receipt-backed admission (P3-9) records the dispatch's request identity
 *   (operation, target binding, request hash) with `dispatching`, before any
 *   transport, and the admission receipt's identity with `admitted`.
 * - The store keeps checked verdicts and delivery state, not raw child reports
 *   or receipts, and never a bearer or other credential.
 * - It is not the audit ledger (`outcomes.jsonl`), which stays separate.
 */
import { createHash } from "node:crypto";
import {
	isBoolean,
	isFiniteNumber,
	isNonEmptyString,
	isRecord,
	isString,
	type JsonObject,
	type JsonValue,
} from "./config/type-guards.ts";

export const OUTCOME_JOURNAL_VERSION = 1;
/** Bounded outcome text, in UTF-16 code units; the digest covers the full text. */
export const OUTCOME_TEXT_LIMIT = 64 * 1024;
/** Bounded serialized envelope, in UTF-16 code units. */
export const OUTCOME_ENVELOPE_LIMIT = 128 * 1024;
/** One journal record, in bytes; larger writes are refused before any I/O. */
export const OUTCOME_RECORD_LIMIT = 1024 * 1024;

export type OutcomeJson = JsonValue;
export type OutcomeJsonObject = JsonObject;

/** A help request never takes a run's terminal-result slot. */
export type OutcomeKind = "result" | "help";

export type OutcomeDeliveryState =
	| "pending"
	| "dispatching"
	| "admitted"
	| "uncertain"
	| "blocked"
	| "suppressed";

/**
 * `process-local`: the parent's own process accepted the message (terminal
 * `sendMessage`); `receipt`: a durable admission receipt proves it.
 */
export type OutcomeAdmissionEvidence = "process-local" | "receipt";

/** Recorded before acquisition, so a crash during it is visible on restart. */
export interface OutcomeAttempt {
	taskId: string;
	/** One-based, one per acquisition of the run. */
	attempt: number;
	model?: string;
	thinking?: string;
	/**
	 * Provider binding identity (slot, base, pin, command IDs, request hashes):
	 * opaque references only, never a socket path, PID, pane ID or secret.
	 */
	binding?: OutcomeJsonObject;
	at: number;
}

/** The immutable subject a check started against, recorded before it runs. */
export interface OutcomeCheckStart {
	taskId: string;
	attempt: number;
	subject: OutcomeJsonObject;
	at: number;
}

/** What a run owner commits; the store adds identity, digests and bounds. */
export interface OutcomeDraft {
	taskId: string;
	attempt: number;
	kind: OutcomeKind;
	/** The child generation (worker epoch or Pi generation); else the store owner. */
	generation?: string;
	/** The source report's identity, when the provider has one. */
	reportId?: string;
	runId?: string;
	/** The run outcome (`completed`, `failed`, `killed`, `help`, ...). */
	outcome: string;
	exitCode?: number;
	text: string;
	textSource?: string;
	/** The parent's checked verdict and its evidence. */
	verdict?: OutcomeJsonObject;
	/** The exact subject the verdict is bound to. */
	subject?: OutcomeJsonObject;
	/** Cancellation and termination facts. */
	cancellation?: OutcomeJsonObject;
	/** Other bounded host facts (runtime, worktree, references). */
	facts?: OutcomeJsonObject;
	/** The exact serialized delivery envelope, when built before the commit. */
	envelope?: string;
	/** A stable delivery identity; generated when absent. */
	deliveryId?: string;
	/** Whether this outcome ends its run's open attempts. Default: kind `result`. */
	closesRun?: boolean;
}

export interface CheckedOutcome {
	deliveryId: string;
	/** Parent + task + generation + attempt + kind + source report. */
	dedupeKey: string;
	parent: string;
	/** The store owner (one per open) that committed it. */
	owner: string;
	taskId: string;
	attempt: number;
	kind: OutcomeKind;
	generation?: string;
	reportId?: string;
	runId?: string;
	outcome: string;
	exitCode?: number;
	text: string;
	textDigest: string;
	textTruncated: boolean;
	textSource?: string;
	verdict?: OutcomeJsonObject;
	subject?: OutcomeJsonObject;
	cancellation?: OutcomeJsonObject;
	facts?: OutcomeJsonObject;
	envelope?: string;
	envelopeDigest?: string;
	committedAt: number;
}

export interface OutcomeDelivery {
	state: OutcomeDeliveryState;
	/** Dispatch attempts so far; each gets a fresh command ID. */
	attempts: number;
	commandId?: string;
	/**
	 * The current attempt's request identity, durable with `dispatching`
	 * (operation, target binding, request hash): what a later receipt read
	 * needs. Identity only: never the message, a bearer or a socket path.
	 */
	request?: OutcomeJsonObject;
	/** The receipt identity that settled the current attempt, when one did. */
	receipt?: OutcomeJsonObject;
	evidence?: OutcomeAdmissionEvidence;
	reason?: string;
	at: number;
}

export interface StoredOutcome {
	outcome: CheckedOutcome;
	delivery: OutcomeDelivery;
}

/** A run whose attempts were recorded but which neither committed nor closed. */
export interface InterruptedRun {
	owner: string;
	taskId: string;
	attempts: OutcomeAttempt[];
	/** A check started here never committed a verdict: verification is incomplete. */
	checks: OutcomeCheckStart[];
}

/** A retired delivery identity, kept (bounded) so it is never committed again. */
export interface FinalDelivery {
	deliveryId: string;
	state: OutcomeDeliveryState;
	evidence?: OutcomeAdmissionEvidence;
	at: number;
}

export interface OutcomeRecovery {
	parent: string;
	owner: string;
	/** Retained outcomes whose delivery is not final, oldest first. */
	outcomes: StoredOutcome[];
	interrupted: InterruptedRun[];
	/** The most recent final deliveries, oldest first. */
	final: FinalDelivery[];
}

/** An opaque consumer state saved in the same record as its outcomes. */
export interface OutcomeObserverState {
	key: string;
	state: OutcomeJson;
}

export interface OutcomeBatch {
	outcomes?: OutcomeDraft[];
	observer?: OutcomeObserverState;
}

export interface OutcomeSettlement {
	state: Exclude<OutcomeDeliveryState, "pending" | "dispatching">;
	evidence?: OutcomeAdmissionEvidence;
	reason?: string;
	/**
	 * The receipt identity behind this settlement. Required to move an
	 * `uncertain` delivery to `blocked`: only a matching refused receipt proves
	 * that its command began nothing.
	 */
	receipt?: OutcomeJsonObject;
}

/** What a dispatch records with `dispatching`, before the caller sends. */
export interface OutcomeDispatch {
	/** The attempt's command ID; generated when absent. */
	commandId?: string;
	/** The attempt's request identity (see {@link OutcomeDelivery.request}). */
	request?: OutcomeJsonObject;
}

/**
 * The injected outbox. One writer per store; methods resolve only after their
 * record is durable and reject without changing state otherwise.
 */
export interface OutcomeStore {
	readonly parent: string;
	readonly owner: string;
	recordAttempt(attempt: Omit<OutcomeAttempt, "at">): Promise<void>;
	recordCheck(check: Omit<OutcomeCheckStart, "at">): Promise<void>;
	/** One durable record: the outcome and its `pending` delivery. */
	commit(draft: OutcomeDraft): Promise<StoredOutcome>;
	/** Outcomes and an observer state, all or nothing in one record. */
	commitBatch(batch: OutcomeBatch): Promise<StoredOutcome[]>;
	/** `pending`/`blocked` -> `dispatching`, durable before the caller sends. */
	dispatch(
		deliveryId: string,
		dispatch?: OutcomeDispatch,
	): Promise<OutcomeDelivery>;
	settle(
		deliveryId: string,
		settlement: OutcomeSettlement,
	): Promise<OutcomeDelivery>;
	/** Ends a run's open attempts without an outcome; another owner's when given. */
	closeRun(taskId: string, reason: string, owner?: string): Promise<void>;
	get(deliveryId: string): StoredOutcome | undefined;
	observerState(key: string): OutcomeJson | undefined;
	recovery(): OutcomeRecovery;
	compact(): Promise<void>;
	/** Releases the writer lock; later calls reject. */
	close(): Promise<void>;
}

export type OutcomeStoreErrorCode =
	| "locked"
	| "corrupt"
	| "version"
	| "parent"
	| "conflict"
	| "transition"
	| "unknown"
	| "invalid"
	| "limit"
	| "closed"
	| "broken"
	| "io";

export class OutcomeStoreError extends Error {
	readonly code: OutcomeStoreErrorCode;
	constructor(
		code: OutcomeStoreErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "OutcomeStoreError";
		this.code = code;
	}
}

export function isOutcomeStoreError(
	value: any,
	code?: OutcomeStoreErrorCode,
): value is OutcomeStoreError {
	return (
		value instanceof OutcomeStoreError &&
		(code === undefined || value.code === code)
	);
}

const TRANSITIONS = {
	pending: ["dispatching", "blocked", "suppressed"],
	// `blocked`: a proven no-effect refusal; `suppressed`: nothing was sent.
	dispatching: ["admitted", "uncertain", "blocked", "suppressed"],
	// A retry is a new dispatch attempt with a new command ID.
	blocked: ["dispatching", "suppressed"],
	// Never dispatched again as it is: only proof of admission, a matching
	// refused receipt (`blocked`, which then retries under a new command ID; the
	// settlement must carry that receipt) or the owner's abandonment.
	uncertain: ["admitted", "blocked", "suppressed"],
	admitted: [],
	suppressed: [],
} satisfies Record<OutcomeDeliveryState, readonly OutcomeDeliveryState[]>;

export function canTransition(
	from: OutcomeDeliveryState,
	to: OutcomeDeliveryState,
): boolean {
	const allowed: readonly OutcomeDeliveryState[] = TRANSITIONS[from];
	return allowed.includes(to);
}

export function isFinalDelivery(state: OutcomeDeliveryState): boolean {
	return TRANSITIONS[state].length === 0;
}

export function outcomeDigest(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export interface BoundedOutcomeText {
	text: string;
	truncated: boolean;
}

export function boundOutcomeText(
	text: string,
	limit = OUTCOME_TEXT_LIMIT,
): BoundedOutcomeText {
	if (text.length <= limit) return { text, truncated: false };
	let end = limit;
	// Never split a surrogate pair.
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return { text: text.slice(0, end), truncated: true };
}

/** The identity two commits of the same logical outcome share. */
export function outcomeDedupeKey(
	parent: string,
	owner: string,
	draft: Pick<
		OutcomeDraft,
		"taskId" | "generation" | "attempt" | "kind" | "reportId"
	>,
): string {
	return JSON.stringify([
		parent,
		draft.taskId,
		draft.generation ?? `owner:${owner}`,
		draft.attempt,
		draft.kind,
		draft.reportId ?? null,
	]);
}

function invalid(message: string): never {
	throw new OutcomeStoreError("invalid", message);
}

// Public-boundary checks: drafts are typed, but a store must not persist a
// value it could not read back, so each field is re-checked as raw JSON (`any`).
function nonEmpty(value: any, field: string): void {
	if (!isNonEmptyString(value))
		invalid(`Outcome ${field} must be a non-empty string.`);
}

function optionalString(value: any, field: string): void {
	if (value !== undefined && !isString(value))
		invalid(`Outcome ${field} must be a string.`);
}

function attemptNumber(value: any): void {
	if (!Number.isSafeInteger(value) || value < 1)
		invalid("Outcome attempt must be a positive integer.");
}

/** Plain JSON only: no functions, cycles, non-finite numbers or class instances. */
export function assertOutcomeJson(
	value: any,
	field: string,
	seen = new Set<object>(),
): asserts value is OutcomeJson {
	if (value === null || isString(value) || isBoolean(value)) return;
	if (isFiniteNumber(value)) return;
	const array = Array.isArray(value);
	if (!array && !isRecord(value)) invalid(`Outcome ${field} is not JSON.`);
	if (seen.has(value)) invalid(`Outcome ${field} is cyclic.`);
	seen.add(value);
	if (array) for (const item of value) assertOutcomeJson(item, field, seen);
	else {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			invalid(`Outcome ${field} is not a plain object.`);
		for (const item of Object.values(value))
			if (item !== undefined) assertOutcomeJson(item, field, seen);
	}
	seen.delete(value);
}

function optionalObject(value: any, field: string): void {
	if (value === undefined) return;
	if (!isRecord(value)) invalid(`Outcome ${field} must be an object.`);
	assertOutcomeJson(value, field);
}

export function validateOutcomeAttempt(
	attempt: Omit<OutcomeAttempt, "at">,
): void {
	nonEmpty(attempt.taskId, "task ID");
	attemptNumber(attempt.attempt);
	optionalString(attempt.model, "model");
	optionalString(attempt.thinking, "thinking");
	optionalObject(attempt.binding, "binding");
}

export function validateOutcomeCheck(
	check: Omit<OutcomeCheckStart, "at">,
): void {
	nonEmpty(check.taskId, "task ID");
	attemptNumber(check.attempt);
	if (!isRecord(check.subject))
		invalid("Outcome check subject must be an object.");
	assertOutcomeJson(check.subject, "check subject");
}

export function validateOutcomeDispatch(dispatch: OutcomeDispatch): void {
	if (dispatch.commandId !== undefined)
		nonEmpty(dispatch.commandId, "dispatch command ID");
	optionalObject(dispatch.request, "dispatch request");
}

export function validateOutcomeSettlement(
	from: OutcomeDeliveryState,
	settlement: OutcomeSettlement,
): void {
	optionalString(settlement.reason, "settlement reason");
	optionalObject(settlement.receipt, "settlement receipt");
	if (
		from === "uncertain" &&
		settlement.state === "blocked" &&
		settlement.receipt === undefined
	)
		invalid(
			"An uncertain delivery becomes blocked only with the refused receipt that proves its command began nothing.",
		);
}

export function validateOutcomeDraft(draft: OutcomeDraft): void {
	nonEmpty(draft.taskId, "task ID");
	attemptNumber(draft.attempt);
	if (draft.kind !== "result" && draft.kind !== "help")
		invalid("Outcome kind must be result or help.");
	nonEmpty(draft.outcome, "run outcome");
	for (const field of [
		"generation",
		"reportId",
		"runId",
		"textSource",
		"envelope",
		"deliveryId",
	] as const)
		optionalString(draft[field], field);
	if (draft.deliveryId === "") invalid("Outcome deliveryId must not be empty.");
	if (!isString(draft.text)) invalid("Outcome text must be a string.");
	if (draft.exitCode !== undefined && !Number.isSafeInteger(draft.exitCode))
		invalid("Outcome exit code must be an integer.");
	if (
		draft.envelope !== undefined &&
		draft.envelope.length > OUTCOME_ENVELOPE_LIMIT
	)
		throw new OutcomeStoreError(
			"limit",
			`Outcome envelope exceeds ${OUTCOME_ENVELOPE_LIMIT} characters.`,
		);
	for (const field of ["verdict", "subject", "cancellation", "facts"] as const)
		optionalObject(draft[field], field);
	if (draft.closesRun !== undefined && !isBoolean(draft.closesRun))
		invalid("Outcome closesRun must be a boolean.");
}
