/**
 * Receipt-backed parent admission (P3-9): the port a checked-outcome outbox
 * uses to hand one committed outcome to its parent.
 *
 * - The outbox records `dispatching` with the attempt's command ID and request
 *   identity before `send` is called, so an attempt it cannot settle recovers
 *   as uncertain and is read back through `reconcile`, never sent again.
 * - Only a matching receipt that says the parent's input was admitted is
 *   `admitted`. A proven refusal (`refused`) began nothing; whether it may be
 *   retried under a new command ID is the port's call. Anything else is
 *   `unknown`: absence, expiry or a denied read is never proof of no effect.
 * - Admission proves the parent's harness took the input, not that the
 *   parent read, reasoned about or accepted the outcome.
 *
 * Plain TypeScript; implementations own their transport and identities.
 */
import type {
	OutcomeDelivery,
	OutcomeDeliveryState,
	OutcomeDraft,
	OutcomeJsonObject,
	StoredOutcome,
} from "./outcome-store.ts";

/**
 * Why a delivery waits before any send:
 * - `busy`: the parent is running a turn (its input would be refused);
 * - `fenced`: the parent's session is fenced until its owner resolves it;
 * - `parent-changed`: the parent's generation or session is not the one this
 *   store delivers to (explicit adoption only, never a redirect);
 * - `parent-gone`: the parent is stopped, failed or unknown;
 * - `unavailable`: the parent could not be read now.
 */
export type AdmissionWait =
	| "busy"
	| "fenced"
	| "parent-changed"
	| "parent-gone"
	| "unavailable";

/** One attempt's outcome, from its reply or a receipt read. */
export type AdmissionAttempt =
	/** A matching receipt proves the parent's input admission. */
	| { outcome: "admitted"; receipt: OutcomeJsonObject }
	/**
	 * Proven to have begun nothing. `retry`: the cause can clear by itself
	 * (busy, fenced, rebound); otherwise only the owner can unblock it.
	 */
	| {
			outcome: "refused";
			reason: string;
			retry: boolean;
			receipt?: OutcomeJsonObject;
	  }
	/**
	 * Not proven either way. `final`: further reads cannot change it on their
	 * own (unknown outcome, missing, expired or denied receipt); the owner
	 * reconciles. Otherwise a later read may settle it.
	 */
	| {
			outcome: "unknown";
			reason: string;
			final: boolean;
			receipt?: OutcomeJsonObject;
	  };

/** An attempt ready to send: its identity is recorded before `send` runs. */
export interface PreparedAdmission {
	commandId: string;
	/** Request identity (operation, target binding, request hash); never the message. */
	request: OutcomeJsonObject;
	/** Sends once; never retries a mutation and never throws. */
	send(): Promise<AdmissionAttempt>;
}

export type ParentReadiness =
	| { ready: true; prepared: PreparedAdmission }
	| { ready: false; wait: AdmissionWait; reason: string };

export interface ParentAdmission {
	/** The parent identity this port delivers to; must equal its store's `parent`. */
	readonly parent: string;
	/**
	 * The exact message for an outcome, persisted as its envelope before the
	 * commit, so a restart never rebuilds it from a changed template.
	 */
	envelope(draft: OutcomeDraft & { deliveryId: string }): string;
	/** Reads only: whether the parent can take input now, and the attempt if so. */
	prepare(stored: StoredOutcome): Promise<ParentReadiness>;
	/** One receipt read of a recorded attempt; never sends. */
	reconcile(delivery: OutcomeDelivery): Promise<AdmissionAttempt>;
	/** Whether a recorded refusal reason may clear without the owner. */
	retryable(reason: string): boolean;
}

/**
 * The run owner's side of an outbox: with it, a committed outcome is handed
 * over instead of sent by the host's `onSettled`.
 */
export interface OutcomeAdmission {
	/** Builds the persisted envelope for a draft about to be committed. */
	envelope(draft: OutcomeDraft & { deliveryId: string }): string;
	/**
	 * Takes ownership of a committed delivery and makes one attempt now.
	 * Resolves with its state afterwards (`pending`/`blocked` while it waits);
	 * the outbox keeps it until it is admitted, abandoned or reconciled.
	 */
	submit(deliveryId: string): Promise<OutcomeDeliveryState>;
}
