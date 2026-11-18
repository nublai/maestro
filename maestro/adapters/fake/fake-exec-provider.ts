import type {
	ExecCapabilities,
	ExecHandle,
	ExecLaunch,
	ExecObserveOptions,
	ExecPromptInput,
	ExecProvider,
	ExecReconciliation,
	ExecStopReport,
	ExecStopRequest,
} from "../../core/exec-provider.ts";
import type { AcquisitionControl } from "../../core/surface-provider.ts";
import type { PaneInspection } from "../../core/types.ts";

/** Every capability, including a receipt-backed parent admission. */
export const FULL_EXEC_CAPABILITIES: Readonly<ExecCapabilities> = Object.freeze(
	{
		resume: true,
		fork: true,
		persistent: true,
		sharedCheckout: true,
		worktree: true,
		callerSurface: true,
		executionExit: true,
		parentAdmission: "receipt",
	},
);

export interface FakeExecProviderOptions<Launch, Launched> {
	name?: string;
	/** Overrides of {@link FULL_EXEC_CAPABILITIES}. */
	capabilities?: Partial<ExecCapabilities>;
	/** Builds the harness record for one acquired execution. */
	launched(request: Launch, ref: string): Launched;
}

export interface FakeExecution<Launch> {
	readonly ref: string;
	readonly request: Launch;
	state: "live" | "finished" | "stopped";
	exitCode?: number;
	output: string[];
	prompts: ExecPromptInput[];
	interrupts: number;
	/** Set by {@link FakeExecProvider.blockStop}: the next stop stays unconfirmed. */
	stopError?: Error;
	/** What the blocked stop reports about its request. */
	stopRequest?: ExecStopRequest;
}

/**
 * In-memory ExecProvider: no surface, process or network. Tests drive exits,
 * output and stop failures explicitly; every call is recorded in `calls`.
 */
export class FakeExecProvider<Launch, Launched>
	implements ExecProvider<Launch, Launched>
{
	readonly name: string;
	readonly capabilities: Readonly<ExecCapabilities>;
	/** Method names in call order, launches included even when refused. */
	readonly calls: string[] = [];
	/** Executions acquired so far, in launch order. */
	readonly executions: FakeExecution<Launch>[] = [];
	#next = 1;
	#launchError?: Error;
	#launchFailure?: string;
	#build: (request: Launch, ref: string) => Launched;

	constructor(options: FakeExecProviderOptions<Launch, Launched>) {
		this.name = options.name ?? "fake-exec";
		this.capabilities = Object.freeze({
			...FULL_EXEC_CAPABILITIES,
			...options.capabilities,
		});
		this.#build = options.launched;
	}

	isAvailable(): boolean {
		return true;
	}

	async launch(
		request: Launch,
		control?: AcquisitionControl,
	): Promise<ExecLaunch<Launched>> {
		this.calls.push("launch");
		control?.signal?.throwIfAborted();
		const error = this.#launchError;
		if (error) {
			this.#launchError = undefined;
			throw error;
		}
		const ref = `${this.name}-${this.#next++}`;
		const launched = this.#build(request, ref);
		this.executions.push({
			ref,
			request,
			state: "live",
			output: [],
			prompts: [],
			interrupts: 0,
		});
		const launch: ExecLaunch<Launched> = {
			handle: Object.freeze({
				provider: this.name,
				ref,
				capabilities: this.capabilities,
			}),
			launched,
		};
		const launchFailure = this.#launchFailure;
		this.#launchFailure = undefined;
		if (launchFailure) launch.launchFailure = launchFailure;
		return launch;
	}

	async inspect(handle: ExecHandle): Promise<PaneInspection> {
		this.calls.push("inspect");
		return snapshot(this.#execution(handle));
	}

	async *observe(
		handle: ExecHandle,
		options: ExecObserveOptions,
	): AsyncIterable<PaneInspection> {
		this.calls.push("observe");
		const execution = this.#execution(handle);
		while (!options.signal.aborted) {
			const current = snapshot(execution);
			yield current;
			if (current.kind === "missing") return;
			await new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					options.signal.removeEventListener("abort", finish);
					resolve();
				};
				const timer = setTimeout(finish, options.intervalMs ?? 10);
				options.signal.addEventListener("abort", finish, { once: true });
			});
		}
	}

	async read(handle: ExecHandle, lines?: number): Promise<string> {
		this.calls.push("read");
		const output = this.#execution(handle).output;
		return (lines === undefined ? output : output.slice(-lines)).join("\n");
	}

	async prompt(handle: ExecHandle, input: ExecPromptInput): Promise<void> {
		this.calls.push("prompt");
		const execution = this.#execution(handle);
		if (execution.state !== "live")
			throw new Error(`Fake execution ${execution.ref} is not live`);
		execution.prompts.push({ ...input });
	}

	async interrupt(handle: ExecHandle): Promise<void> {
		this.calls.push("interrupt");
		const execution = this.#execution(handle);
		if (execution.state !== "live")
			throw new Error(`Fake execution ${execution.ref} is not live`);
		execution.interrupts++;
	}

	async stop(handle: ExecHandle): Promise<ExecStopReport> {
		this.calls.push("stop");
		const execution = this.#execution(handle);
		const error = execution.stopError;
		if (error) {
			const request = execution.stopRequest ?? "sent";
			execution.stopError = undefined;
			execution.stopRequest = undefined;
			return { request, termination: "unconfirmed", error };
		}
		if (execution.state !== "live")
			return { request: "not-sent", termination: "confirmed" };
		execution.state = "stopped";
		return { request: "sent", termination: "confirmed" };
	}

	async reconcile(handle: ExecHandle): Promise<ExecReconciliation> {
		this.calls.push("reconcile");
		const execution = this.#execution(handle);
		if (execution.state === "live") return { kind: "live" };
		if (execution.state === "stopped") return { kind: "missing" };
		return execution.exitCode === undefined
			? { kind: "finished" }
			: { kind: "finished", exitCode: execution.exitCode };
	}

	/** The next launch rejects with `error` before acquiring anything. */
	failNextLaunch(error: Error): void {
		this.#launchError = error;
	}

	/**
	 * The next launch acquires an execution but reports its dispatch uncertain
	 * through the top-level `launchFailure` only; the harness record is untouched.
	 */
	uncertainNextLaunch(reason: string): void {
		this.#launchFailure = reason;
	}

	/** End the execution on its own, as a natural exit. */
	exit(handle: ExecHandle, exitCode = 0): void {
		const execution = this.#execution(handle);
		if (execution.state !== "live") return;
		execution.state = "finished";
		execution.exitCode = exitCode;
	}

	print(handle: ExecHandle, text: string): void {
		this.#execution(handle).output.push(...text.split("\n"));
	}

	/**
	 * The next stop of this execution reports `error`, unconfirmed, with
	 * `request` as its request state (default `sent`). The execution stays live.
	 */
	blockStop(
		handle: ExecHandle,
		error: Error,
		request: ExecStopRequest = "sent",
	): void {
		const execution = this.#execution(handle);
		execution.stopError = error;
		execution.stopRequest = request;
	}

	execution(handle: ExecHandle): FakeExecution<Launch> {
		return this.#execution(handle);
	}

	#execution(handle: ExecHandle): FakeExecution<Launch> {
		const execution =
			handle.provider === this.name
				? this.executions.find((candidate) => candidate.ref === handle.ref)
				: undefined;
		if (!execution) throw new Error(`Unknown fake execution ${handle.ref}`);
		return execution;
	}
}

function snapshot<Launch>(execution: FakeExecution<Launch>): PaneInspection {
	return execution.state === "live"
		? { kind: "present", agentStatus: "working", observedAt: Date.now() }
		: { kind: "missing" };
}
