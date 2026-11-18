/**
 * P3-7: the typed worker child's FD reporter and its import/authority
 * boundary. The leaf reports through its inherited FD 3 only: the reporter
 * imports no B2 client, grant, engine or runtime, reads only its descriptor
 * variable, and opens no socket.
 */
import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	decodeResultClaim,
	encodeResultClaim,
	FD_REPORT_LIMITS,
	FdReporter,
	fdReporterFromEnv,
	reportDescriptor,
} from "../../maestro/adapters/worker/fd-report.ts";

const REPORTER = fileURLToPath(
	new URL("../../maestro/adapters/worker/fd-report.ts", import.meta.url),
);

/** Every module specifier the file at `path` imports, followed through relative imports. */
function closure(
	path: string,
	seen = new Map<string, string[]>(),
): Map<string, string[]> {
	const absolute = resolve(path);
	if (seen.has(absolute)) return seen;
	const specifiers = ts
		.preProcessFile(readFileSync(absolute, "utf8"), true, true)
		.importedFiles.map((entry) => entry.fileName);
	seen.set(absolute, specifiers);
	for (const specifier of specifiers)
		if (specifier.startsWith("."))
			closure(resolve(dirname(absolute), specifier), seen);
	return seen;
}

function collect() {
	const writes: { fd: number; text: string }[] = [];
	return {
		writes,
		write: (fd: number, bytes: Uint8Array) => {
			writes.push({ fd, text: Buffer.from(bytes).toString("utf8") });
			return bytes.length;
		},
	};
}

describe("worker FD reporter", () => {
	it("writes one LF-terminated {report_id, kind, message} line to its descriptor and nothing else", () => {
		const sink = collect();
		const reporter = new FdReporter(3, {
			write: sink.write,
			reportId: () => "r-1",
		});
		const sent = reporter.report("result", "claim");
		assert.deepEqual(sent, {
			report_id: "r-1",
			kind: "result",
			message: "claim",
		});
		assert.deepEqual(sink.writes, [
			{
				fd: 3,
				text: '{"report_id":"r-1","kind":"result","message":"claim"}\n',
			},
		]);
		assert.equal(reporter.count, 1);
	});

	it("a partial write is completed, never duplicated", () => {
		const chunks: string[] = [];
		const reporter = new FdReporter(3, {
			reportId: () => "r-2",
			write: (_fd, bytes) => {
				const n = Math.min(5, bytes.length);
				chunks.push(Buffer.from(bytes.subarray(0, n)).toString("utf8"));
				return n;
			},
		});
		reporter.report("help", "which file?");
		assert.equal(
			chunks.join(""),
			'{"report_id":"r-2","kind":"help","message":"which file?"}\n',
		);
	});

	it("refuses before writing what the supervisor would reject", () => {
		const sink = collect();
		const reporter = new FdReporter(3, { write: sink.write });
		assert.throws(
			() =>
				reporter.report(
					"result",
					"x".repeat(FD_REPORT_LIMITS.messageBytes + 1),
				),
			/at most 8192 bytes/,
		);
		// SAFETY: deliberately not a report kind, to see the refusal.
		assert.throws(
			() => reporter.report("done" as "result", "m"),
			/result or a help/,
		);
		assert.throws(
			() =>
				new FdReporter(3, {
					write: sink.write,
					reportId: () => "bad id!",
				}).report("result", "m"),
			/1 to 64/,
		);
		for (let i = 0; i < FD_REPORT_LIMITS.reports; i++)
			reporter.report("help", "h");
		assert.throws(() => reporter.report("result", "m"), /at most 32 reports/);
		assert.equal(sink.writes.length, FD_REPORT_LIMITS.reports);
		assert.ok(sink.writes.every((w) => !w.text.includes("bad id")));
	});

	it("the descriptor comes from PI_WORKER_REPORT_FD only and is never a standard stream", () => {
		assert.equal(reportDescriptor({}), undefined);
		assert.equal(fdReporterFromEnv({}), undefined);
		assert.equal(reportDescriptor({ PI_WORKER_REPORT_FD: "3" }), 3);
		for (const raw of ["0", "1", "2", "-3", "3.5", "fd3"])
			assert.throws(
				() => reportDescriptor({ PI_WORKER_REPORT_FD: raw }),
				/above 2/,
				raw,
			);
		assert.throws(() => new FdReporter(2), /above the standard streams/);
		// A socket or grant in the environment changes nothing.
		const reporter = fdReporterFromEnv({
			PI_WORKER_REPORT_FD: "3",
			PI_WORKER_SOCKET: "/run/piw-parent/sock",
			PI_WORKER_GRANT_FILE: "/tmp/grant.json",
		});
		assert.equal(reporter?.fd, 3);
	});

	it("a result claim round-trips, fits its bound, and anything else decodes as invalid", () => {
		const done = encodeResultClaim({
			type: "done",
			summary: "ok",
			accept: { passed: true },
		});
		assert.deepEqual(decodeResultClaim(done), {
			type: "done",
			summary: "ok",
			accept: { passed: true },
		});
		assert.deepEqual(
			decodeResultClaim(
				encodeResultClaim({ type: "error", errorMessage: "boom" }),
			),
			{
				type: "error",
				errorMessage: "boom",
			},
		);
		const long = encodeResultClaim({ type: "done", summary: "é".repeat(9000) });
		assert.ok(Buffer.byteLength(long) <= FD_REPORT_LIMITS.messageBytes);
		const cut = decodeResultClaim(long);
		assert.equal(cut.type, "done");
		assert.ok(cut.type === "done" && cut.summary && /^é+$/.test(cut.summary));
		for (const message of [
			"done",
			"{}",
			'{"v":2,"type":"done"}',
			'{"v":1,"type":"maybe"}',
			"[1]",
			"null",
		])
			assert.deepEqual(
				decodeResultClaim(message),
				{ type: "invalid" },
				message,
			);
	});

	it("a claimed commit (P3-10) round-trips only as a full lower-case object ID", () => {
		for (const commit of ["a".repeat(40), "0".repeat(64)])
			assert.deepEqual(
				decodeResultClaim(encodeResultClaim({ type: "done", commit })),
				{ type: "done", commit },
			);
		for (const commit of [
			"a".repeat(39),
			"A".repeat(40),
			"HEAD",
			"a".repeat(41),
		])
			assert.throws(
				() => encodeResultClaim({ type: "done", commit }),
				/full lower-case object ID/,
			);
		// A claim this reporter did not write: a malformed commit is no claim at all.
		for (const commit of ['"HEAD"', "7", '"abc"', "null"])
			assert.deepEqual(
				decodeResultClaim(`{"v":1,"type":"done","commit":${commit}}`),
				{ type: "invalid" },
				commit,
			);
	});
});

describe("worker FD reporter: a summary that cannot fit", () => {
	it("returns the claim without its summary when even an empty one would break the bound", () => {
		// The claim without a summary fits (8180 bytes); with `"summary":""` it is 8193.
		const overhead = JSON.stringify({ v: 1, type: "done", accept: "" }).length;
		const accept = "a".repeat(8180 - overhead);
		// In a child with a deadline: an encoder that never returns must fail, not hang the suite.
		const script = `import { encodeResultClaim } from ${JSON.stringify(REPORTER)};
process.stdout.write(encodeResultClaim({ type: "done", accept: ${JSON.stringify(accept)}, summary: "x".repeat(100) }));`;
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				encoding: "utf8",
				timeout: 10_000,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			},
		);
		assert.equal(
			child.signal,
			null,
			"the encoder returned before its deadline",
		);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(Buffer.byteLength(child.stdout), 8180);
		assert.ok(Buffer.byteLength(child.stdout) <= FD_REPORT_LIMITS.messageBytes);
		assert.deepEqual(decodeResultClaim(child.stdout), {
			type: "done",
			accept,
		});
	});
});

describe("worker FD reporter: import and authority boundary", () => {
	it("its whole import closure is node:fs: no client, grant, engine, runtime or Pi package", () => {
		const imports = closure(REPORTER);
		assert.deepEqual([...imports.keys()], [REPORTER]);
		assert.deepEqual(imports.get(REPORTER), ["node:fs"]);
	});

	it("in a real child it writes to FD 3 only: nothing on stdout, no socket connection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-fd-report-"));
		const socket = join(dir, "sock");
		const grant = join(dir, "grant.json");
		writeFileSync(grant, '{"token":"synthetic"}\n', { mode: 0o600 });
		let connections = 0;
		const server = createServer((connection) => {
			connections++;
			connection.destroy();
		});
		await new Promise<void>((done) => server.listen(socket, done));
		try {
			const script = `import { fdReporterFromEnv, encodeResultClaim } from ${JSON.stringify(REPORTER)};
const reporter = fdReporterFromEnv();
reporter.report("help", "need input");
reporter.report("result", encodeResultClaim({ type: "done", summary: "finished" }));`;
			const child = spawn(
				process.execPath,
				["--input-type=module", "-e", script],
				{
					stdio: ["ignore", "pipe", "pipe", "pipe"],
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						PI_WORKER_REPORT_FD: "3",
						PI_WORKER_SOCKET: socket,
						PI_WORKER_GRANT_FILE: grant,
					},
				},
			);
			const out: Buffer[] = [];
			const fd3: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout?.on("data", (b: Buffer) => out.push(b));
			child.stderr?.on("data", (b: Buffer) => err.push(b));
			child.stdio[3]?.on("data", (b: Buffer) => fd3.push(Buffer.from(b)));
			const code = await new Promise<number | null>((done) =>
				child.once("close", done),
			);
			assert.equal(code, 0, Buffer.concat(err).toString("utf8"));
			assert.equal(Buffer.concat(out).length, 0);
			const lines = Buffer.concat(fd3).toString("utf8").split("\n");
			assert.equal(lines.pop(), "");
			assert.deepEqual(
				lines.map((line) => {
					const { kind, message } = JSON.parse(line);
					return [
						kind,
						kind === "result" ? decodeResultClaim(message).type : message,
					];
				}),
				[
					["help", "need input"],
					["result", "done"],
				],
			);
			assert.equal(connections, 0, "the reporter never reached B2");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
