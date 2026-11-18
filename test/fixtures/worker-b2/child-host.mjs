/**
 * A typed worker child for the real-B2 fixture: pi-worker's host protocol on
 * stdin/stdout (not pi, not a model), with its report written to the FD 3 pipe
 * the supervisor gave it, by Maestro's own FD reporter. Every prompt is
 * handled at once (the worker settles it); the fixture drives the rest through
 * `fixture_*` commands: print an assistant line, report, exit.
 *
 * argv[2]: JSON `{ sessionDir }`. Synthetic environment only.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fdReporterFromEnv } from "../../../maestro/adapters/worker/fd-report.ts";

const { sessionDir } = JSON.parse(process.argv[2] ?? "{}");
const sessionId = `child-${process.pid}-${Date.now().toString(36)}`;
const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
let last = null;
let serial = 0;
const reporter = fdReporterFromEnv(process.env);

function open() {
	if (existsSync(sessionFile)) return;
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
	);
}

function append(entry) {
	open();
	const id = `e${++serial}`;
	appendFileSync(
		sessionFile,
		`${JSON.stringify({ ...entry, id, parentId: last, timestamp: new Date().toISOString() })}\n`,
	);
	last = id;
	// pi's selected leaf moved: the supervisor's history watermark follows it into the file.
	process.stdout.write(
		`${JSON.stringify({ type: "host_leaf", leafId: id })}\n`,
	);
}

function message(role, text) {
	const body = {
		role,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
	if (role === "assistant") body.stopReason = "stop";
	append({ type: "message", message: body });
}

function reply(id, success, data, extra = {}) {
	const response = { type: "response", id, success, ...extra };
	if (data) response.data = data;
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	for (;;) {
		const nl = pending.indexOf("\n");
		if (nl < 0) break;
		const line = pending.slice(0, nl);
		pending = pending.slice(nl + 1);
		let c;
		try {
			c = JSON.parse(line);
		} catch {
			continue;
		}
		handle(c);
	}
});

function handle(c) {
	switch (c.type) {
		case "get_state":
			open();
			return reply(c.id, true, { sessionId, sessionFile, leafId: last });
		case "inventory":
			return reply(c.id, true, {
				extensions: [],
				extension_errors: [],
				skills: [],
				tools: [],
				active_tools: [],
				commands: [],
			});
		case "prompt":
			message("user", String(c.message));
			return reply(c.id, true, { disposition: "handled" });
		case "fixture_print":
			message("assistant", String(c.text));
			return reply(c.id, true, {});
		case "fixture_report": {
			if (!reporter)
				return reply(c.id, false, undefined, { error: "no_report_fd" });
			const sent = reporter.report(c.kind, String(c.message));
			return reply(c.id, true, { report_id: sent.report_id });
		}
		case "fixture_env":
			return reply(c.id, true, {
				report_fd: process.env.PI_WORKER_REPORT_FD ?? null,
				has_socket: process.env.PI_WORKER_SOCKET !== undefined,
				has_grant: process.env.PI_WORKER_GRANT_FILE !== undefined,
			});
		case "fixture_exit":
			reply(c.id, true, {});
			setImmediate(() => process.exit(0));
			return;
		default:
			return reply(c.id, true, { sessionId, sessionFile, cancelled: false });
	}
}
