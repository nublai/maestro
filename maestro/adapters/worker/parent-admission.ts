/**
 * Receipt-backed parent admission over B2 (P3-9): a checked outcome reaches
 * the parent worker as one `sessions.prompt {if_busy: reject}`.
 *
 * - The parent is named by its worker, epoch and session
 *   ({@link workerParentIdentity}); its outcome store carries that identity.
 *   A relaunched or rebound parent is a different parent: its outcomes wait
 *   until a new store owner adopts them explicitly, never redirected.
 * - `prepare` reads the parent's row first and sends only to an idle,
 *   unfenced parent of that identity. A busy parent waits; a fenced one waits
 *   for its owner (never cleared here); a stopped, missing or rebound one
 *   blocks.
 * - The attempt's UUIDv7 command ID and request hash are recorded (by the
 *   outbox) before the request is sent. A lost reply gets one receipt read;
 *   only a matching `delivered` receipt with `effect: observed` and
 *   `admission: accepted` is admission. Missing, expired, denied or unsettled
 *   receipts stay unknown: absence is not proof of no effect.
 * - Help requests are their own outcomes (`kind: help`, keyed by the report's
 *   command ID); they never take the run's result slot
 *   ({@link workerObserverPersistence}).
 */
import {
	type Client,
	ClientFailure,
	classifyReceipt,
	type components,
	type Expected,
	type ObserverBatch,
	type ObserverState,
	parseObserverState,
	type Receipt,
	type Reconciliation,
	reconcile,
	requestHash,
} from "@nublai/pi-worker-client";
import {
	boundOutcomeText,
	type OutcomeDelivery,
	type OutcomeDraft,
	type OutcomeJsonObject,
	type OutcomeStore,
	outcomeDigest,
	type StoredOutcome,
} from "../../core/outcome-store.ts";
import type {
	AdmissionAttempt,
	ParentAdmission,
	ParentReadiness,
} from "../../core/parent-admission.ts";
import { isString } from "../../core/config/type-guards.ts";
import {
	uuidv7,
	type WorkerAcquisitionManifest,
	type WorkerLaunchStore,
} from "./launch-store.ts";

type Worker = components["schemas"]["Worker"];
type ChildClaim = components["schemas"]["ChildClaim"];

/** The parent a store delivers to: one worker generation and its session. */
export interface WorkerParentBinding {
	worker_id: string;
	worker_epoch: string;
	session_id: string;
}

/** The outcome store's parent identity for a worker parent. */
export function workerParentIdentity(parent: WorkerParentBinding): string {
	return `pi-worker/${parent.worker_id}/${parent.worker_epoch}/${parent.session_id}`;
}

/** The parent's current binding (`PI_WORKER_ID` inside a sandboxed parent). */
export async function readWorkerParent(
	client: Client,
	workerId: string,
): Promise<WorkerParentBinding> {
	const row = await client.call("workers.get", {
		path: { worker_id: workerId },
	});
	if (!row.session_id)
		throw new Error(`Worker ${workerId} has no bound session.`);
	return {
		worker_id: row.worker_id,
		worker_epoch: row.worker_epoch,
		session_id: row.session_id,
	};
}

/** The persisted envelope's version tag; a later format gets a new tag. */
export const WORKER_OUTCOME_ENVELOPE = "maestro-outcome/v1";
const VERDICT_LIMIT = 2_000;

/**
 * The exact prompt text for one outcome: a versioned header naming the
 * delivery, then the bounded text. Persisted before the commit.
 */
export function workerOutcomeEnvelope(
	draft: OutcomeDraft & { deliveryId: string },
): string {
	const lines = [
		`[${WORKER_OUTCOME_ENVELOPE} ${draft.kind}] delivery ${draft.deliveryId}`,
		`task ${draft.taskId} attempt ${draft.attempt} outcome ${draft.outcome}${
			draft.exitCode === undefined ? "" : ` exit ${draft.exitCode}`
		}`,
	];
	if (draft.kind === "help")
		lines.push(
			"The subagent asks for help and waits; answer it with subagent_send. This is not its result.",
		);
	if (draft.verdict) {
		const verdict = JSON.stringify(draft.verdict);
		lines.push(
			`verdict ${verdict.length > VERDICT_LIMIT ? `${verdict.slice(0, VERDICT_LIMIT)}…` : verdict}`,
		);
	}
	const { text, truncated } = boundOutcomeText(draft.text);
	lines.push("", truncated ? `${text}\n[truncated]` : text);
	return lines.join("\n");
}

/**
 * Refusals and waits whose cause can clear without the owner: the next
 * attempt reads the parent again and sends under a new command ID.
 */
const RETRYABLE = new Set([
	"worker_busy",
	"worker_not_ready",
	"binding_change_in_progress",
	"stale_binding",
	"session_fenced",
	"transport_unavailable",
	"parent_busy",
	"parent_fenced",
	"parent_not_ready",
	"parent_unavailable",
	"parent_rebound",
	"parent_stopped",
	"parent_missing",
]);

/** Unknown reasons that further reads cannot settle on their own. */
const FINAL_UNKNOWN = new Set([
	"outcome_unknown",
	"receipt_missing",
	"receipt_expired",
	"receipt_scope_denied",
	"receipt_mismatch",
	"receipt_not_admitted",
]);

/** A reason's code: its text before the first colon. */
function code(reason: string): string {
	const colon = reason.indexOf(":");
	return colon < 0 ? reason : reason.slice(0, colon);
}

/** A receipt's identity, never its payload. */
export function receiptFacts(receipt: Receipt): OutcomeJsonObject {
	const facts: OutcomeJsonObject = {
		command_id: receipt.command_id,
		operation: receipt.operation,
		request_hash: receipt.request_hash,
		state: receipt.state,
		stage: receipt.stage,
		effect: receipt.effect,
		created_at: receipt.created_at,
	};
	for (const field of [
		"worker_id",
		"execution_id",
		"admission",
		"error",
	] as const) {
		const value = receipt[field];
		if (value !== undefined) facts[field] = value;
	}
	return facts;
}

export interface WorkerParentAdmissionOptions {
	/** A client whose grant may read the parent and prompt it (Maestro's profile). */
	client: Client;
	parent: WorkerParentBinding;
	now?(): number;
}

export class WorkerParentAdmission implements ParentAdmission {
	readonly parent: string;
	readonly #client: Client;
	readonly #binding: WorkerParentBinding;
	readonly #now: () => number;

	constructor(options: WorkerParentAdmissionOptions) {
		this.#client = options.client;
		this.#binding = { ...options.parent };
		this.parent = workerParentIdentity(options.parent);
		this.#now = options.now ?? Date.now;
	}

	envelope(draft: OutcomeDraft & { deliveryId: string }): string {
		return workerOutcomeEnvelope(draft);
	}

	retryable(reason: string): boolean {
		return RETRYABLE.has(code(reason));
	}

	async prepare(stored: StoredOutcome): Promise<ParentReadiness> {
		const id = this.#binding.worker_id;
		let row: Worker;
		try {
			row = await this.#client.call("workers.get", {
				path: { worker_id: id },
			});
		} catch (error) {
			if (
				error instanceof ClientFailure &&
				error.phase === "http" &&
				error.message === "unknown_worker"
			)
				return {
					ready: false,
					wait: "parent-gone",
					reason: "parent_missing",
				};
			return {
				ready: false,
				wait: "unavailable",
				reason: `parent_unavailable: ${failureText(error)}`,
			};
		}
		if (
			row.worker_epoch !== this.#binding.worker_epoch ||
			row.session_id !== this.#binding.session_id
		)
			return {
				ready: false,
				wait: "parent-changed",
				reason:
					"parent_rebound: the parent's generation or session is not this store's; an owner must adopt the store",
			};
		// A generation that is ending (cleanup pending) never takes input again.
		if (
			row.status === "stopped" ||
			row.status === "failed" ||
			row.status === "cleanup_pending"
		)
			return {
				ready: false,
				wait: "parent-gone",
				reason: `parent_stopped: ${row.status}`,
			};
		if (row.status !== "ready")
			return {
				ready: false,
				wait: "unavailable",
				reason: `parent_not_ready: ${row.status}`,
			};
		if (row.fence)
			return {
				ready: false,
				wait: "fenced",
				reason: `parent_fenced: uncertain command ${row.fence.command_id}; the owner resolves it`,
			};
		if (row.foreground !== "idle")
			return {
				ready: false,
				wait: "busy",
				reason: `parent_busy: ${row.foreground}`,
			};
		const commandId = uuidv7(this.#now());
		// The persisted envelope; an outcome committed without one gets the template.
		const message =
			stored.outcome.envelope ?? workerOutcomeEnvelope(stored.outcome);
		const body = {
			command_id: commandId,
			worker_epoch: row.worker_epoch,
			session_id: row.session_id,
			binding_revision: row.binding_revision,
			message,
			if_busy: "reject" as const,
		};
		const path = { worker_id: id };
		const hash = requestHash("sessions.prompt", { path, body });
		const expected: Expected = {
			command_id: commandId,
			operation: "sessions.prompt",
			request_hash: hash,
			worker_id: id,
		};
		return {
			ready: true,
			prepared: {
				commandId,
				request: {
					operation: "sessions.prompt",
					worker_id: id,
					worker_epoch: row.worker_epoch,
					session_id: row.session_id,
					binding_revision: row.binding_revision,
					request_hash: hash,
					message_digest: outcomeDigest(message),
				},
				send: () =>
					this.#send(expected, () =>
						this.#client.call("sessions.prompt", { path, body }),
					),
			},
		};
	}

	async reconcile(delivery: OutcomeDelivery): Promise<AdmissionAttempt> {
		const expected = expectedOf(delivery);
		if (!expected)
			return {
				outcome: "unknown",
				reason: "receipt_unreadable: no recorded sessions.prompt request",
				final: true,
			};
		return this.#classify(await reconcile(this.#client, expected));
	}

	/** Sends once; a lost reply gets one receipt read, never a second send. */
	async #send(
		expected: Expected,
		call: () => Promise<Receipt>,
	): Promise<AdmissionAttempt> {
		let settled: Reconciliation | ClientFailure;
		try {
			settled = classifyReceipt(await call(), expected);
		} catch (error) {
			if (error instanceof ClientFailure && error.effect === "no_effect") {
				// Before the write nothing reached the worker; its text may name local paths.
				const reason =
					error.phase === "before_write"
						? "transport_unavailable"
						: error.message;
				return { outcome: "refused", reason, retry: this.retryable(reason) };
			}
			settled = await reconcile(this.#client, expected);
		}
		return this.#classify(settled);
	}

	#classify(settled: Reconciliation | ClientFailure): AdmissionAttempt {
		if (settled instanceof ClientFailure) {
			const reason =
				settled.phase === "before_write"
					? "transport_unavailable"
					: settled.message;
			return settled.effect === "no_effect"
				? { outcome: "refused", reason, retry: this.retryable(reason) }
				: { outcome: "unknown", reason, final: true };
		}
		if (settled.outcome === "observed") {
			const receipt = receiptFacts(settled.receipt);
			// Delivered and observed, but only `accepted` is the parent's input admission.
			return settled.receipt.admission === "accepted"
				? { outcome: "admitted", receipt }
				: {
						outcome: "unknown",
						reason: `receipt_not_admitted: ${settled.receipt.admission ?? "none"}`,
						final: true,
						receipt,
					};
		}
		if (settled.outcome === "no_effect") {
			const reason = settled.receipt.error ?? settled.receipt.state;
			return {
				outcome: "refused",
				reason,
				retry: this.retryable(reason),
				receipt: receiptFacts(settled.receipt),
			};
		}
		const attempt: AdmissionAttempt = {
			outcome: "unknown",
			reason: settled.reason,
			final: FINAL_UNKNOWN.has(settled.reason),
		};
		if (settled.receipt) attempt.receipt = receiptFacts(settled.receipt);
		return attempt;
	}
}

function expectedOf(delivery: OutcomeDelivery): Expected | undefined {
	const request = delivery.request;
	if (
		!delivery.commandId ||
		!request ||
		request.operation !== "sessions.prompt" ||
		!isString(request.request_hash) ||
		!isString(request.worker_id)
	)
		return undefined;
	return {
		command_id: delivery.commandId,
		operation: "sessions.prompt",
		request_hash: request.request_hash,
		worker_id: request.worker_id,
	};
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no static type; only an Error's own message is read. */
function failureText(error: unknown): string {
	if (error instanceof ClientFailure)
		return error.phase === "before_write"
			? "transport_unavailable"
			: error.message;
	return error instanceof Error ? error.message : "unknown failure";
}

/** The outcome store key of the provider Observer's persisted state. */
export const WORKER_OBSERVER_STATE_KEY = "pi-worker/observer";

export interface WorkerObserverPersistenceOptions {
	store: OutcomeStore;
	launches: WorkerLaunchStore;
	client: Client;
	/** Builds the persisted envelope; usually the outbox's or the admission's. */
	envelope(draft: OutcomeDraft & { deliveryId: string }): string;
	/** Called after a batch that committed new outcomes (the outbox's `wake`). */
	committed?(outcomes: StoredOutcome[]): void;
	now?(): number;
}

/**
 * The provider Observer's `restored` state and `persist` hook over the outcome
 * store: each batch's state is saved in one record together with the help
 * requests it surfaced (P3-8 `commitBatch`), so a restart diffs from exactly
 * what was saved and a help request is neither lost nor committed twice.
 * A cold seed (no saved state) counts the reports already on its rows as
 * surfaced without notices; its owned help requests are retained with it.
 * Result reports are not committed here: the run owner's checks commit them.
 */
export interface WorkerObserverPersistence {
	/** The last saved state: a restart diffs from it, never a cold seed. */
	restored?: ObserverState;
	/** Saves a batch's state and the help requests it surfaced in one record. */
	persist(
		batch: ObserverBatch,
		row?: (workerId: string) => Worker | undefined,
	): Promise<void>;
}

/**
 * The Observer state last saved with the outbox, checked: a state the client
 * cannot trust throws rather than becoming a cold seed over pending outcomes.
 */
export function restoredWorkerObserverState(
	store: OutcomeStore,
): ObserverState | undefined {
	const saved = store.observerState(WORKER_OBSERVER_STATE_KEY);
	return saved === undefined ? undefined : parseObserverState(saved);
}

export function workerObserverPersistence(
	options: WorkerObserverPersistenceOptions,
): WorkerObserverPersistence {
	const restored = restoredWorkerObserverState(options.store);
	const persistence: WorkerObserverPersistence = {
		async persist(batch, row) {
			const outcomes: OutcomeDraft[] = [];
			const owned = (workerId: string) =>
				options.launches.list().find((m) => m.worker_id === workerId);
			const help: {
				workerId: string;
				manifest: WorkerAcquisitionManifest;
				claim: ChildClaim;
			}[] = [];
			for (const notice of batch.notices) {
				if (notice.kind !== "child_report" || notice.report_kind !== "help")
					continue;
				const manifest = owned(notice.worker_id);
				// Not this parent's launch: nothing of ours to deliver.
				if (!manifest) continue;
				const claim = await helpClaim(
					options.client,
					notice.worker_id,
					notice.report_command_id,
					row,
				);
				help.push({ workerId: notice.worker_id, manifest, claim });
			}
			// A cold seed counts every report on its rows as surfaced and names
			// none: saving it alone would acknowledge an owned help request that
			// has no outcome. Its owned help is retained in the same record.
			if (batch.seeded)
				for (const [workerId, seen] of Object.entries(batch.state.workers)) {
					const manifest = owned(workerId);
					if (!manifest) continue;
					for (const reportId of seen.reports) {
						const claim = await helpClaim(
							options.client,
							workerId,
							reportId,
							row,
						);
						if (claim.kind === "help") help.push({ workerId, manifest, claim });
					}
				}
			for (const { workerId, manifest, claim } of help) {
				const deliveryId = uuidv7(options.now?.() ?? Date.now());
				const draft: OutcomeDraft & { deliveryId: string } = {
					taskId: manifest.task_id,
					attempt: 1,
					kind: "help",
					generation: manifest.generation_id,
					reportId: claim.command_id,
					runId: manifest.run_id,
					outcome: "help",
					text: claim.message,
					textSource: "child",
					facts: {
						worker_id: workerId,
						report_command_id: claim.command_id,
						claim_not_verified: true,
					},
					closesRun: false,
					deliveryId,
				};
				draft.envelope = options.envelope(draft);
				outcomes.push(draft);
			}
			const committed = await options.store.commitBatch({
				outcomes,
				observer: {
					key: WORKER_OBSERVER_STATE_KEY,
					// SAFETY: the client's ObserverState is plain JSON by contract.
					state: JSON.parse(JSON.stringify(batch.state)),
				},
			});
			if (committed.length) options.committed?.(committed);
		},
	};
	if (restored !== undefined) persistence.restored = restored;
	return persistence;
}

/** The help claim a notice names, from the Observer's row or a fresh read. */
async function helpClaim(
	client: Client,
	workerId: string,
	reportId: string,
	row?: (workerId: string) => Worker | undefined,
): Promise<ChildClaim> {
	const find = (worker: Worker | undefined) =>
		worker?.child_reports?.find((claim) => claim.command_id === reportId);
	const seen = find(row?.(workerId));
	if (seen) return seen;
	const read = find(
		await client.call("workers.get", { path: { worker_id: workerId } }),
	);
	if (!read)
		throw new Error(
			`Help report ${reportId} is not on worker ${workerId}'s row; its batch is not saved.`,
		);
	return read;
}
