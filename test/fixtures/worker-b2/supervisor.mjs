/**
 * The real-B2 fixture for the worker ExecProvider (P3-7): pi-worker's own
 * supervisor, B2 app, router, validators, grants, receipts, journal and event
 * hub, built from a pinned local checkout (`MAESTRO_PI_WORKER_CHECKOUT`, its
 * `npm run build` output), serving one private Unix socket. Hosts are
 * deterministic, never pi and never a model: the parent and a foreign worker
 * run pi-worker's in-process test host; every typed child is a real
 * subprocess (`child-host.mjs`) with the FD 3 report pipe the production
 * LineHost gives it, written by Maestro's FD reporter.
 *
 * Topology (root decision Q3/P2-8 B): an owner repository, the parent root a
 * linked worktree of it, and owner-prepared slots: locked linked worktrees of
 * the same repository at `PARENT/.piw-slots/<name>`, each on its own
 * `refs/heads/maestro/<name>` at the exact base. The parent is a typed root
 * worker with a running execution; the provider's grant is Maestro's method
 * profile scoped to that parent and its root.
 *
 * Control: one JSON request per stdin line `{id, op, args}`, one reply per
 * stdout line `{id, ok, result | error}`. Synthetic environment only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = process.env.MAESTRO_PI_WORKER_CHECKOUT;
if (!checkout) throw new Error("MAESTRO_PI_WORKER_CHECKOUT is required");
const dist = (path) =>
	import(pathToFileURL(join(checkout, "packages/worker/dist", path)).href);

const { fixture } = await dist("test/supervisor-fixture.js");
const { createApp } = await dist("src/b2/app.js");
const { createB2Server, listenPrivate } = await dist("src/b2/server.js");
const { GrantStore, writeBearerFile } = await dist("src/grants/store.js");
const { LineHost, childEnv } = await dist("src/host/host.js");
const { CHANNEL_METHODS } = await dist("src/supervisor/channel.js");

const childHost = new URL("./child-host.mjs", import.meta.url).pathname;
/** What a typed child inherits: synthetic, never this process's environment. */
const CHILD_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	HOME: process.env.HOME ?? "/nonexistent",
	LANG: "C",
};

let f;
let server;
const children = new Map();
let launched = 0;
let uncertainNext = false;

function gitIn(home) {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		LANG: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return (cwd, ...args) =>
		execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
}

function launch(l) {
	if (!l.create.parent) return undefined;
	const host = new LineHost(
		process.execPath,
		[childHost, JSON.stringify({ sessionDir: l.sessionDir })],
		{
			cwd: l.cwd,
			env: childEnv(CHILD_ENV, l.create.parent.task_id),
			report: true,
			prefix: l.prefix,
		},
	);
	const record = { host, prompts: [], workerId: l.workerId };
	const request = host.request.bind(host);
	const lose = uncertainNext;
	uncertainNext = false;
	host.request = async (command) => {
		if (command.type === "prompt")
			record.prompts.push({
				command_id: command.command_id,
				message: command.message,
			});
		const response = await request(command);
		// The prompt reached the child; its reply is lost.
		if (lose && command.type === "prompt") throw new Error("lost_prompt_reply");
		return response;
	};
	children.set(l.workerId, record);
	launched++;
	return host;
}

async function start({ profile, slots = 4 }) {
	f = fixture({ launch });
	const base = realpathSync(f.dir);
	const repo = join(base, "repo");
	const root = join(base, "parent");
	const git = gitIn(base);
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Fixture owner");
	git(repo, "config", "user.email", "owner@example.invalid");
	writeFileSync(join(repo, "note"), "base\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "base");
	writeFileSync(
		join(repo, ".git", "info", "exclude"),
		".piw-agent/\n.piw-worker/\n.piw-slots/\n.piw-maestro/\n",
	);
	const baseSha = git(repo, "rev-parse", "HEAD");
	git(repo, "worktree", "add", "-qb", "job/parent", root, "HEAD");
	mkdirSync(join(root, ".piw-slots"));
	const slotList = [];
	for (let i = 0; i < slots; i++) {
		const name = `s${i}`;
		const path = join(root, ".piw-slots", name);
		const branch = `refs/heads/maestro/${name}`;
		git(repo, "worktree", "add", "-qb", `maestro/${name}`, path, baseSha);
		git(repo, "worktree", "lock", "--reason", "owner slot", path);
		slotList.push({ name, branch, baseSha });
	}
	const spec = {
		environment: { id: "parent", revision: 1, allowed_methods: profile },
		role: "parent",
		tools: ["read", "bash", "edit", "write"],
		denied_tools: [],
		resources: { extensions: [], skills: [] },
		grant_methods: profile,
		seed_mode: "standalone",
	};
	const made = await f.supervisor.create({
		command_id: "parent-create",
		cwd: root,
		host: "sdk",
		provider: "p",
		model: "m",
		thinking: "off",
		launch_spec: spec,
	});
	if (made.state !== "delivered") throw new Error("parent create failed");
	const p = f.supervisor.get(made.worker_id);
	const prompted = await f.supervisor.prompt(p.worker_id, {
		command_id: "parent-run",
		worker_epoch: p.worker_epoch,
		session_id: p.session_id,
		binding_revision: p.binding_revision,
		message: "orchestrate",
	});
	if (prompted.state !== "delivered") throw new Error("parent prompt failed");
	const grants = new GrantStore(f.dir);
	const { token } = grants.register({
		caller: "maestro-parent",
		scope: { worker_ids: [p.worker_id], cwd_roots: [root] },
		methods: profile,
		grant_id: "maestro-parent",
	});
	const grantFile = join(f.dir, "maestro.grant.json");
	writeBearerFile(grantFile, token);
	server = createB2Server(
		createApp({ supervisor: f.supervisor, grants }).handle,
	);
	const socketPath = join(f.dir, "b2.sock");
	await listenPrivate(server, socketPath);
	return {
		socketPath,
		grantFile,
		root,
		repo,
		baseSha,
		parentWorkerId: p.worker_id,
		slots: slotList,
		channelMethods: [...CHANNEL_METHODS],
	};
}

async function foreign() {
	const cwd = join(realpathSync(f.dir), "foreign");
	mkdirSync(cwd);
	const made = await f.supervisor.create({
		command_id: "foreign-create",
		cwd,
		provider: "p",
		model: "m",
		thinking: "off",
	});
	return { workerId: made.worker_id, commandId: "foreign-create" };
}

function child(workerId) {
	const record = children.get(workerId);
	if (!record) throw new Error("no such child");
	return record;
}

async function settledExit(workerId) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const row = f.supervisor.get(workerId);
		if (row.status !== "ready" && row.status !== "starting") return row.status;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("child exit not recorded");
}

const ops = {
	start,
	foreign,
	acquisitions: async () => launched,
	print: async ({ workerId, text }) => {
		await child(workerId).host.request({ type: "fixture_print", text });
	},
	report: async ({ workerId, kind, message }) =>
		(
			await child(workerId).host.request({
				type: "fixture_report",
				kind,
				message,
			})
		).data,
	env: async ({ workerId }) =>
		(await child(workerId).host.request({ type: "fixture_env" })).data,
	exit: async ({ workerId }) => {
		await child(workerId).host.request({ type: "fixture_exit" });
		return settledExit(workerId);
	},
	blockStop: async ({ workerId }) => {
		child(workerId).host.stop = async () => false;
	},
	uncertainNextLaunch: async () => {
		uncertainNext = true;
	},
	prompts: async ({ workerId }) => child(workerId).prompts,
	row: async ({ workerId }) => f.supervisor.get(workerId),
	shutdown: async () => {
		if (server) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(() => resolve()));
		}
		for (const { host } of children.values()) {
			host.stop = LineHost.prototype.stop;
		}
		if (f) {
			await f.supervisor.shutdown();
			f.cleanup();
		}
		return true;
	},
};

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	pending += chunk;
	for (;;) {
		const nl = pending.indexOf("\n");
		if (nl < 0) break;
		const line = pending.slice(0, nl);
		pending = pending.slice(nl + 1);
		void serve(JSON.parse(line));
	}
});

async function serve({ id, op, args }) {
	try {
		const result = await ops[op](args ?? {});
		process.stdout.write(
			`${JSON.stringify({ id, ok: true, result: result ?? null })}\n`,
		);
		if (op === "shutdown") process.exit(0);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
	}
}

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
