/**
 * The checked-outcome outbox's delivery owner (P3-9): hands committed outcomes
 * to the parent through a receipt-backed {@link ParentAdmission}, oldest first,
 * one step at a time.
 *
 * - Each attempt's command ID and request identity are durable with
 *   `dispatching` before its transport (`OutcomeStore.dispatch`).
 * - A matching admitted receipt is recorded as `admitted` (`receipt`
 *   evidence). It is never resent, also when the local record of it was lost:
 *   a restart reads the receipt back instead.
 * - A parent that is busy, fenced, rebound, gone or unreadable makes the
 *   outcome wait; it stays in the outbox. A fence is never cleared here, and
 *   no parent is relaunched or replaced.
 * - A proven refusal blocks the outcome; it retries under a new command ID
 *   once its cause may have cleared, or waits for the owner.
 * - Anything unproven is `uncertain` and is never sent again. Receipt reads may
 *   still prove it admitted (or refused). Otherwise it waits for the owner's
 *   explicit decision (`abandon`).
 * - On start, every recovered `uncertain` attempt (a `dispatching` left by a
 *   crash included) is read back through its receipt before anything new is
 *   sent.
 *
 * This proves the parent's input admission, not that the parent consumed or
 * acted on the outcome (root decision Q2: no exactly-once consumption).
 */
import type {
	AdmissionAttempt,
	AdmissionWait,
	OutcomeAdmission,
	ParentAdmission,
} from "../core/parent-admission.ts";
import type {
	OutcomeDeliveryState,
	OutcomeDraft,
	OutcomeKind,
	OutcomeSettlement,
	OutcomeStore,
	StoredOutcome,
} from "../core/outcome-store.ts";

/** Default delay between delivery passes while something waits. */
export const ADMISSION_POLL_MS = 1_000;

/**
 * What a waiting outcome needs: a parent change (`AdmissionWait`), the
 * owner's decision (`owner`), or only its turn (`queued`).
 */
export type AdmissionNeed = AdmissionWait | "owner" | "queued";

/** One outcome the outbox still holds, as its owner should see it. */
export interface AdmissionAttention {
	deliveryId: string;
	taskId: string;
	kind: OutcomeKind;
	state: OutcomeDeliveryState;
	needs: AdmissionNeed;
	/** The latest reason: a refusal or receipt code, never a payload. */
	reason?: string;
	/** The latest attempt's command ID, when one was dispatched. */
	commandId?: string;
	attempts: number;
}

export interface AdmissionOutboxOptions {
	store: OutcomeStore;
	admission: ParentAdmission;
	/** Delay between passes while something waits. Default 1000 ms. */
	pollMs?: number;
}

interface Note {
	needs: AdmissionNeed;
	reason: string;
}

/** A failure's own message only; never a payload. */
function errorText(error: any): string {
	return error instanceof Error ? error.message : "unknown failure";
}

export class AdmissionOutbox implements OutcomeAdmission {
	readonly #store: OutcomeStore;
	readonly #admission: ParentAdmission;
	readonly #pollMs: number;
	readonly #notes = new Map<string, Note>();
	/** Uncertain attempts (`deliveryId:commandId`) whose reads cannot settle on their own. */
	readonly #finalUnknown = new Set<string>();
	#lock: Promise<void> = Promise.resolve();
	#started?: Promise<void>;
	#loop?: Promise<void>;
	#closed = false;
	#wake?: () => void;
	#woken = false;

	constructor(options: AdmissionOutboxOptions) {
		if (options.admission.parent !== options.store.parent)
			throw new Error(
				"This parent admission delivers to another parent than its outcome store; adopt the store explicitly instead of redirecting its outcomes.",
			);
		this.#store = options.store;
		this.#admission = options.admission;
		this.#pollMs = options.pollMs ?? ADMISSION_POLL_MS;
	}

	envelope(draft: OutcomeDraft & { deliveryId: string }): string {
		return this.#admission.envelope(draft);
	}

	/**
	 * Recovery, then the background loop. Recovery reads every uncertain
	 * attempt's receipt back first; only then is anything new dispatched.
	 */
	start(): Promise<void> {
		if (this.#started) return this.#started;
		this.#started = this.#exclusive(() => this.#recover());
		this.#loop = this.#started.then(
			() => this.#run(),
			() => this.#run(),
		);
		return this.#started;
	}

	async submit(deliveryId: string): Promise<OutcomeDeliveryState> {
		if (this.#closed) throw new Error("The admission outbox is closed.");
		const state = await this.#exclusive(() => this.#step(deliveryId));
		this.wake();
		return state;
	}

	/** Runs the next pass now (a parent or report may have changed). */
	wake(): void {
		this.#woken = true;
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	/** Every outcome the outbox still holds, oldest first. */
	attention(): AdmissionAttention[] {
		return this.#store.recovery().outcomes.map((stored) => {
			const { outcome, delivery } = stored;
			const note = this.#notes.get(outcome.deliveryId);
			const item: AdmissionAttention = {
				deliveryId: outcome.deliveryId,
				taskId: outcome.taskId,
				kind: outcome.kind,
				state: delivery.state,
				needs:
					note?.needs ??
					(delivery.state === "uncertain" || delivery.state === "dispatching"
						? "owner"
						: "queued"),
				attempts: delivery.attempts,
			};
			const reason = note?.reason ?? delivery.reason;
			if (reason !== undefined) item.reason = reason;
			if (delivery.commandId !== undefined) item.commandId = delivery.commandId;
			return item;
		});
	}

	/**
	 * The owner's explicit decision to give an outcome up (`suppressed`): an
	 * uncertain one included, whose input may or may not have reached the
	 * parent. Nothing is sent.
	 */
	abandon(deliveryId: string, reason: string): Promise<void> {
		return this.#exclusive(async () => {
			await this.#store.settle(deliveryId, {
				state: "suppressed",
				reason: `abandoned by the owner: ${reason}`,
			});
			this.#notes.delete(deliveryId);
		});
	}

	/** The owner asks for one more receipt read of an uncertain outcome. */
	reconcile(deliveryId: string): Promise<OutcomeDeliveryState> {
		return this.#exclusive(async () => {
			const stored = this.#store.get(deliveryId);
			if (!stored) return this.#finalState(deliveryId);
			if (stored.delivery.state !== "uncertain") return stored.delivery.state;
			return this.#reconcileUncertain(stored, true);
		});
	}

	/** Stops the loop after its current step. Outcomes stay in the store. */
	async close(): Promise<void> {
		this.#closed = true;
		this.wake();
		await this.#loop;
		await this.#lock;
	}

	// ---- internals ----

	#exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#lock.then(work, work);
		this.#lock = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async #run(): Promise<void> {
		while (!this.#closed) {
			await this.#sleep();
			if (this.#closed) return;
			try {
				await this.#exclusive(() => this.#pass());
			} catch {
				/* a failed pass (a closed store) is retried on the next one */
			}
		}
	}

	#sleep(): Promise<void> {
		if (this.#woken) {
			this.#woken = false;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.#wake = undefined;
				this.#woken = false;
				resolve();
			};
			const timer = setTimeout(done, this.#pollMs);
			this.#wake = done;
		});
	}

	/** Reads every uncertain attempt back, then one ordinary pass. */
	async #recover(): Promise<void> {
		for (const stored of this.#store.recovery().outcomes)
			if (stored.delivery.state === "uncertain")
				await this.#reconcileUncertain(stored, false);
		await this.#pass();
	}

	/** One step for every outcome the store holds, oldest first. */
	async #pass(): Promise<void> {
		for (const stored of this.#store.recovery().outcomes) {
			if (this.#closed) return;
			await this.#step(stored.outcome.deliveryId);
		}
	}

	#finalState(deliveryId: string): OutcomeDeliveryState {
		const final = this.#store
			.recovery()
			.final.find((entry) => entry.deliveryId === deliveryId);
		if (!final) throw new Error(`Unknown delivery ${deliveryId}.`);
		return final.state;
	}

	#state(deliveryId: string): OutcomeDeliveryState {
		return (
			this.#store.get(deliveryId)?.delivery.state ??
			this.#finalState(deliveryId)
		);
	}

	#note(deliveryId: string, needs: AdmissionNeed, reason: string): void {
		this.#notes.set(deliveryId, { needs, reason });
	}

	async #step(deliveryId: string): Promise<OutcomeDeliveryState> {
		const stored = this.#store.get(deliveryId);
		if (!stored) return this.#finalState(deliveryId);
		switch (stored.delivery.state) {
			case "pending":
			case "blocked":
				return this.#attempt(stored);
			case "uncertain":
				return this.#reconcileUncertain(stored, false);
			case "dispatching":
				// Only a settlement this process could not write leaves it here; the
				// store reopens it as uncertain, and nothing sends it meanwhile.
				this.#note(
					deliveryId,
					"owner",
					"dispatch_unsettled: its outcome could not be recorded; it recovers as uncertain",
				);
				return "dispatching";
			default:
				return stored.delivery.state;
		}
	}

	async #attempt(stored: StoredOutcome): Promise<OutcomeDeliveryState> {
		const { deliveryId } = stored.outcome;
		const { delivery } = stored;
		if (
			delivery.state === "blocked" &&
			delivery.reason !== undefined &&
			!this.#admission.retryable(delivery.reason)
		) {
			this.#note(deliveryId, "owner", delivery.reason);
			return "blocked";
		}
		let readiness: Awaited<ReturnType<ParentAdmission["prepare"]>>;
		try {
			readiness = await this.#admission.prepare(stored);
		} catch (error) {
			this.#note(deliveryId, "unavailable", errorText(error));
			return delivery.state;
		}
		if (!readiness.ready) {
			this.#note(deliveryId, readiness.wait, readiness.reason);
			// A wait only the owner or a parent change can end is durable, so a
			// restart shows it too; busy and unreadable parents stay in memory.
			if (
				delivery.state === "pending" &&
				readiness.wait !== "busy" &&
				readiness.wait !== "unavailable"
			)
				await this.#store
					.settle(deliveryId, { state: "blocked", reason: readiness.reason })
					.catch(() => {});
			return this.#state(deliveryId);
		}
		const { prepared } = readiness;
		try {
			await this.#store.dispatch(deliveryId, {
				commandId: prepared.commandId,
				request: prepared.request,
			});
		} catch (error) {
			// Not sent: its attempt could not be recorded first.
			this.#note(
				deliveryId,
				"unavailable",
				`not sent: the attempt could not be recorded (${errorText(error)})`,
			);
			return this.#state(deliveryId);
		}
		let attempt: AdmissionAttempt;
		try {
			attempt = await prepared.send();
		} catch (error) {
			attempt = {
				outcome: "unknown",
				reason: `send_failed: ${errorText(error)}`,
				final: true,
			};
		}
		return this.#settle(deliveryId, prepared.commandId, attempt);
	}

	async #reconcileUncertain(
		stored: StoredOutcome,
		explicit: boolean,
	): Promise<OutcomeDeliveryState> {
		const { deliveryId } = stored.outcome;
		const { delivery } = stored;
		if (delivery.commandId === undefined || delivery.request === undefined) {
			// A process-local dispatch (terminal sendMessage) has no receipt to read.
			this.#note(
				deliveryId,
				"owner",
				delivery.reason ?? "uncertain without a recorded request",
			);
			return "uncertain";
		}
		const key = `${deliveryId}:${delivery.commandId}`;
		if (!explicit && this.#finalUnknown.has(key)) return "uncertain";
		let attempt: AdmissionAttempt;
		try {
			attempt = await this.#admission.reconcile(delivery);
		} catch (error) {
			attempt = {
				outcome: "unknown",
				reason: `receipt_unreadable: ${errorText(error)}`,
				final: false,
			};
		}
		// Only a refusal its receipt proves may move an uncertain attempt.
		if (attempt.outcome === "refused" && attempt.receipt === undefined)
			attempt = { outcome: "unknown", reason: attempt.reason, final: true };
		if (attempt.outcome === "unknown") {
			if (attempt.final) this.#finalUnknown.add(key);
			this.#note(deliveryId, "owner", attempt.reason);
			return "uncertain";
		}
		return this.#settle(deliveryId, delivery.commandId, attempt);
	}

	async #settle(
		deliveryId: string,
		commandId: string,
		attempt: AdmissionAttempt,
	): Promise<OutcomeDeliveryState> {
		let settlement: OutcomeSettlement;
		let note: Note | undefined;
		switch (attempt.outcome) {
			case "admitted":
				settlement = {
					state: "admitted",
					evidence: "receipt",
					receipt: attempt.receipt,
				};
				break;
			case "refused":
				settlement = { state: "blocked", reason: attempt.reason };
				if (attempt.receipt) settlement.receipt = attempt.receipt;
				note = {
					needs: attempt.retry ? "queued" : "owner",
					reason: attempt.reason,
				};
				break;
			case "unknown":
				settlement = { state: "uncertain", reason: attempt.reason };
				if (attempt.receipt) settlement.receipt = attempt.receipt;
				if (attempt.final) this.#finalUnknown.add(`${deliveryId}:${commandId}`);
				note = { needs: "owner", reason: attempt.reason };
				break;
		}
		try {
			await this.#store.settle(deliveryId, settlement);
		} catch (error) {
			// Left `dispatching` (or `uncertain`): never sent again; a reopen reads it back.
			this.#note(
				deliveryId,
				"owner",
				`${attempt.outcome === "admitted" ? "admitted" : attempt.reason}, but it could not be recorded (${errorText(error)})`,
			);
			return this.#state(deliveryId);
		}
		if (note) this.#notes.set(deliveryId, note);
		else this.#notes.delete(deliveryId);
		return settlement.state;
	}
}
