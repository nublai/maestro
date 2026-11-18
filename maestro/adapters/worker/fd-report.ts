/**
 * The typed worker child's report channel (P3-7): a leaf reports to its
 * parent by writing one line to the descriptor pi-worker gave it (FD 3), never
 * through B2. The supervisor reads that pipe, records each line as a
 * `children.report` receipt and tells the parent; a report is a claim, never
 * proof.
 *
 * Authority boundary: this module is the whole child-side reporter. It imports
 * Node's `fs` only: no B2 client, no grant, no socket, no engine, no runtime.
 * It reads exactly one environment variable, the report descriptor, and
 * writes only to that descriptor. A child holds no bearer and no socket.
 *
 * Wire format (pi-worker `host.ts` `readReports`): LF-terminated JSON
 * `{report_id, kind, message}` and nothing else; `report_id` matches
 * `[A-Za-z0-9_-]{1,64}`, `kind` is `result` or `help`, `message` is at most
 * 8192 bytes. Past 32 reports or 16 KiB unread the supervisor stops trusting
 * the channel, so the reporter refuses before it writes.
 */
import { writeSync } from "node:fs";

/** The variable pi-worker sets for a typed child: its report descriptor. */
export const WORKER_REPORT_FD_ENV = "PI_WORKER_REPORT_FD";

/** pi-worker's report-channel bounds (`REPORT_LIMITS`). */
export const FD_REPORT_LIMITS = Object.freeze({
	messageBytes: 8192,
	reports: 32,
	lineBytes: 16 * 1024,
});

export type FdReportKind = "result" | "help";

export interface FdReport {
	report_id: string;
	kind: FdReportKind;
	message: string;
}

const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The descriptor named by the environment, or undefined when this is not a typed worker child. */
export function reportDescriptor(
	env: Readonly<Record<string, string | undefined>>,
): number | undefined {
	const raw = env[WORKER_REPORT_FD_ENV];
	if (raw === undefined || raw === "") return undefined;
	// Never a standard stream: pi and its extensions own 0 to 2.
	if (!/^\d{1,4}$/.test(raw) || Number(raw) < 3)
		throw new Error(`${WORKER_REPORT_FD_ENV} must name a descriptor above 2`);
	return Number(raw);
}

export interface FdReporterOptions {
	/** Writes bytes to a descriptor; returns how many it wrote. Default: `fs.writeSync`. */
	write?: (fd: number, bytes: Uint8Array) => number;
	/** The next report's identity. Default: a time-ordered random identity. */
	reportId?: () => string;
}

/** One typed child's reporter over its report descriptor. */
export class FdReporter {
	readonly fd: number;
	#count = 0;
	readonly #write: (fd: number, bytes: Uint8Array) => number;
	readonly #reportId: () => string;

	constructor(fd: number, options: FdReporterOptions = {}) {
		if (!Number.isInteger(fd) || fd < 3)
			throw new Error("A report descriptor is above the standard streams");
		this.fd = fd;
		this.#write =
			options.write ?? ((target, bytes) => writeSync(target, bytes));
		this.#reportId = options.reportId ?? defaultReportId;
	}

	/** Reports sent so far. */
	get count(): number {
		return this.#count;
	}

	/**
	 * Writes one report line, all of it, or throws without writing when it
	 * breaks a bound the supervisor enforces. Returns what was written.
	 */
	report(kind: FdReportKind, message: string): FdReport {
		if (kind !== "result" && kind !== "help")
			throw new Error("A report is a result or a help request");
		if (Buffer.byteLength(message) > FD_REPORT_LIMITS.messageBytes)
			throw new Error(
				`A report message is at most ${FD_REPORT_LIMITS.messageBytes} bytes`,
			);
		if (this.#count >= FD_REPORT_LIMITS.reports)
			throw new Error(
				`A child sends at most ${FD_REPORT_LIMITS.reports} reports`,
			);
		const report: FdReport = { report_id: this.#reportId(), kind, message };
		if (!REPORT_ID.test(report.report_id))
			throw new Error("A report identity is 1 to 64 of [A-Za-z0-9_-]");
		const line = Buffer.from(`${JSON.stringify(report)}\n`);
		if (line.length > FD_REPORT_LIMITS.lineBytes)
			throw new Error("A report line exceeds the channel buffer");
		this.#count++;
		let offset = 0;
		while (offset < line.length)
			offset += this.#write(this.fd, line.subarray(offset));
		return report;
	}
}

/** The reporter of a typed worker child, or undefined outside one. */
export function fdReporterFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
	options: FdReporterOptions = {},
): FdReporter | undefined {
	const fd = reportDescriptor(env);
	return fd === undefined ? undefined : new FdReporter(fd, options);
}

let sequence = 0;
function defaultReportId(): string {
	sequence = (sequence + 1) % 0x10000;
	const random = Math.floor(Math.random() * 0x1000000)
		.toString(16)
		.padStart(6, "0");
	return `r${Date.now().toString(36)}-${sequence.toString(36)}-${random}`;
}

/**
 * What a `result` report claims about the child's run: its completion
 * (`done`, or `error` with the child's message) and, optionally, its bounded
 * final summary, the child's own accept-check report and the commit it
 * produced. A claim, checked by the parent, never trusted as its verdict.
 */
export interface ResultClaim {
	type: "done" | "error";
	summary?: string;
	errorMessage?: string;
	/** The child's accept-check report, as its completion sidecar carries it. */
	accept?: ReportJson;
	/**
	 * The full object ID of the commit the child claims as its result (P3-10).
	 * The parent's bound check compares it with what owner Git reads; it is
	 * never the subject itself.
	 */
	commit?: string;
}

/** A full Git object ID (SHA-1 or SHA-256), lower case: the only claimed commit kept. */
export const CLAIMED_COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** A JSON value a report message carries. */
export type ReportJson =
	| null
	| boolean
	| number
	| string
	| ReportJson[]
	| { [key: string]: ReportJson | undefined };

/** The decoded claim of a `result` message, or `invalid` for anything this reporter did not write. */
export type DecodedResultClaim =
	| { type: "done"; summary?: string; accept?: ReportJson; commit?: string }
	| { type: "error"; errorMessage?: string; summary?: string }
	| { type: "invalid" };

const RESULT_VERSION = 1;

/**
 * The message of a `result` report: versioned JSON within the message bound.
 * An over-long summary is cut (never inside a character) so the claim fits;
 * when not even an empty summary fits, the claim goes without one.
 */
export function encodeResultClaim(claim: ResultClaim): string {
	if (claim.commit !== undefined && !CLAIMED_COMMIT.test(claim.commit))
		throw new Error("A claimed commit is a full lower-case object ID");
	const base = {
		v: RESULT_VERSION,
		type: claim.type,
		errorMessage: claim.errorMessage,
		accept: claim.accept,
		commit: claim.commit,
	} satisfies { [key: string]: ReportJson | undefined };
	const fixed = JSON.stringify(base);
	if (Buffer.byteLength(fixed) > FD_REPORT_LIMITS.messageBytes)
		throw new Error("A result claim without its summary exceeds the bound");
	if (claim.summary === undefined) return fixed;
	let summary = claim.summary;
	for (;;) {
		const encoded = JSON.stringify({ ...base, summary });
		const over = Buffer.byteLength(encoded) - FD_REPORT_LIMITS.messageBytes;
		if (over <= 0) return encoded;
		// Nothing left to cut: the claim without a summary fits (checked above).
		if (summary === "") return fixed;
		// Cut by code points, at least a quarter of the excess bytes, then re-check.
		const points = Array.from(summary);
		summary = points
			.slice(0, Math.max(0, points.length - Math.max(1, Math.ceil(over / 4))))
			.join("");
	}
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- The reporter parses a claim read back from B2 without importing a schema package (its import closure is node:fs only). */
/** The completion a `result` message claims, as the child's completion sidecar would carry it. */
export function decodeResultClaim(message: string): DecodedResultClaim {
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return { type: "invalid" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return { type: "invalid" };
	// SAFETY: a parsed JSON object; each field is checked below before use.
	const value = parsed as Record<string, unknown>;
	if (value.v !== RESULT_VERSION) return { type: "invalid" };
	const summary = typeof value.summary === "string" ? value.summary : undefined;
	if (value.type === "done") {
		const done: DecodedResultClaim & { type: "done" } = { type: "done" };
		if (summary !== undefined) done.summary = summary;
		if (value.accept !== undefined) {
			// SAFETY: a value JSON.parse produced is a ReportJson.
			done.accept = value.accept as ReportJson;
		}
		if (value.commit !== undefined) {
			// A malformed commit is not a claim this reporter wrote.
			if (
				typeof value.commit !== "string" ||
				!CLAIMED_COMMIT.test(value.commit)
			)
				return { type: "invalid" };
			done.commit = value.commit;
		}
		return done;
	}
	if (value.type === "error") {
		const error: DecodedResultClaim & { type: "error" } = { type: "error" };
		if (typeof value.errorMessage === "string")
			error.errorMessage = value.errorMessage;
		if (summary !== undefined) error.summary = summary;
		return error;
	}
	return { type: "invalid" };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
