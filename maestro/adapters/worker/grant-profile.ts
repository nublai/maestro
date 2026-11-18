/**
 * Maestro's B2 method profiles (P3-7, plan section 3 "Grant closure"): the
 * exact methods a worker parent's Maestro calls for ordinary orchestration,
 * never `*` and never Shep's `bridge` profile. A grant registered for the
 * provider carries `MAESTRO_WORKER_PARENT_METHODS`, scoped to the parent and
 * its root, with `answers_for_person` false. Owner reconciliation
 * (`sessions.resolve_unknown`, `workers.relaunch`) and steering/follow-up are
 * deliberately absent; they need a separate owner grant or an explicit mode.
 *
 * `children.report` is in the parent profile although no parent sends it: a
 * typed child's grant methods must be a subset of its creator's, and the leaf
 * reports through its FD 3 (`fd-report.ts`), never through B2.
 */

/** Reads the provider makes: negotiation, binding, receipts (also the Observer's), events and history. */
export const MAESTRO_WORKER_READ_METHODS = [
	"hello",
	"workers.get",
	"receipts.get",
	"events.subscribe",
	"history.page",
] as const;

/** Mutations the provider sends, each under a persisted UUIDv7 command ID. */
export const MAESTRO_WORKER_MUTATION_METHODS = [
	"workers.create",
	"sessions.prompt",
	"executions.interrupt",
	"workers.stop",
] as const;

/** The parent's grant profile: reads, mutations, and the child's report method as a ceiling. */
export const MAESTRO_WORKER_PARENT_METHODS: readonly string[] = Object.freeze([
	...MAESTRO_WORKER_READ_METHODS,
	...MAESTRO_WORKER_MUTATION_METHODS,
	"children.report",
]);

/** A typed child's grant methods (its launch spec): its report, nothing else. */
export const MAESTRO_WORKER_CHILD_METHODS: readonly string[] = Object.freeze([
	"children.report",
]);

/** Methods the profile must never contain. */
export const MAESTRO_WORKER_EXCLUDED_METHODS: readonly string[] = Object.freeze(
	[
		"*",
		"sessions.resolve_unknown",
		"workers.relaunch",
		"sessions.follow_up",
		"sessions.steer",
		"children.launch",
		"interactions.answer_if_current",
	],
);
