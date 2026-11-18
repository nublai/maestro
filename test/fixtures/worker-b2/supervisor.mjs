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
let grants;
let socketPath;
const children = new Map();
let launched = 0;
let uncertainNext = false;
/** The parent's in-process host (P3-9): counts the prompts it really received. */
let parentHost;
let parentId;
let serial = 0;

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

async function start({ profile, slots = 4, evictable = false }) {
	// `evictable`: no minimum receipt age, so `evictReceipts` can evict at once.
	f = fixture(evictable ? { launch, retention: { minAgeMs: 0 } } : { launch });
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
	parentHost = f.hosts.at(-1);
	parentId = made.worker_id;
	installParentHooks(parentHost);
	const p = f.supervisor.get(made.worker_id);
	const prompted = await f.supervisor.prompt(p.worker_id, {
		command_id: "parent-run",
		worker_epoch: p.worker_epoch,
		session_id: p.session_id,
		binding_revision: p.binding_revision,
		message: "orchestrate",
	});
	if (prompted.state !== "delivered") throw new Error("parent prompt failed");
	grants = new GrantStore(f.dir);
	const { token } = grants.register({
		caller: "maestro-parent",
		scope: { worker_ids: [p.worker_id], cwd_roots: [root] },
		methods: profile,
		grant_id: "maestro-parent",
	});
	const grantFile = join(f.dir, "maestro.grant.json");
	writeBearerFile(grantFile, token);
	socketPath = join(f.dir, "b2.sock");
	await listenB2();
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

/** Serves B2 for the current supervisor on the fixture's socket. */
async function listenB2() {
	server = createB2Server(
		createApp({ supervisor: f.supervisor, grants }).handle,
	);
	await listenPrivate(server, socketPath);
}

async function unserve() {
	if (!server) return;
	server.closeAllConnections();
	await new Promise((resolve) => server.close(() => resolve()));
	server = undefined;
}

/**
 * The parent host's test controls (P3-9): the next prompt's reply is lost
 * (pi-worker's own `failure`: the prompt starts, its reply never comes back),
 * or the next prompt never replies at all (a hung pi, for a B2 restart
 * between dispatch and reply).
 */
const parentControl = { lose: false, hang: false };
function installParentHooks(host) {
	const request = host.request.bind(host);
	host.request = async (command) => {
		if (command.type === "prompt") {
			host.failure = parentControl.lose;
			parentControl.lose = false;
			if (parentControl.hang) {
				parentControl.hang = false;
				host.commands.push(command);
				host.prompts++;
				host.emit("event", { type: "agent_start" });
				return new Promise(() => {});
			}
		}
		return request(command);
	};
}

function parentBinding() {
	const row = f.supervisor.get(parentId);
	return {
		worker_epoch: row.worker_epoch,
		session_id: row.session_id,
		binding_revision: row.binding_revision,
	};
}

async function waitFor(check, what) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
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
	// ---- P3-9: the parent as a delivery target ----
	/** pi settles the parent's running turn: it is idle and takes input again. */
	parentIdle: async () => {
		parentHost.emit("event", { type: "agent_settled" });
		await waitFor(
			() => f.supervisor.get(parentId).foreground === "idle",
			"an idle parent",
		);
	},
	/** The prompts pi itself received on the parent, in order. */
	parentPrompts: async () =>
		parentHost.commands
			.filter((c) => c.type === "prompt")
			.map((c) => ({ command_id: c.command_id, message: c.message })),
	parentLoseNextReply: async () => {
		parentControl.lose = true;
	},
	parentHangNextPrompt: async () => {
		parentControl.hang = true;
	},
	/** The owner resolves the parent's fence (owner authority, never Maestro's). */
	parentResolve: async ({ disposition = "abandon" }) => {
		const row = f.supervisor.get(parentId);
		if (!row.fence) throw new Error("parent is not fenced");
		const receipt = await f.supervisor.resolveUnknown(parentId, {
			command_id: `owner-resolve-${++serial}`,
			...parentBinding(),
			uncertain_command_id: row.fence.command_id,
			fence_generation: row.fence.fence_generation,
			disposition,
		});
		if (receipt.state !== "delivered")
			throw new Error(`resolve failed: ${receipt.error ?? receipt.state}`);
		return f.supervisor.get(parentId).fence;
	},
	/** The owner starts a new session on the parent: a rebound parent. */
	parentNewSession: async () => {
		const receipt = await f.supervisor.newSession(parentId, {
			command_id: `owner-new-${++serial}`,
			...parentBinding(),
		});
		if (receipt.state !== "delivered")
			throw new Error(`new session failed: ${receipt.error ?? receipt.state}`);
		return f.supervisor.get(parentId).session_id;
	},
	/** The owner stops the parent. */
	parentStop: async () => {
		const receipt = await f.supervisor.stop(parentId, {
			command_id: `owner-stop-${++serial}`,
			...parentBinding(),
		});
		return f.supervisor.get(parentId).status ?? receipt.state;
	},
	/** B2 goes away (the socket stops answering) and comes back. */
	unserve: async () => {
		await unserve();
	},
	serve: async () => {
		await listenB2();
	},
	/**
	 * The supervisor restarts as after SIGKILL: a new instance recovers the
	 * same journal (live workers' generations end), and B2 serves again.
	 */
	restart: async () => {
		await unserve();
		await f.restart();
		await listenB2();
		return f.supervisor.get(parentId).status;
	},
	/** Retention compacts now: every evictable receipt goes; returns the expired ids. */
	evictReceipts: async () =>
		f.supervisor.receipts.compact({ goal: { receipts: 0, bytes: 0 } }),
	/** A grant of Maestro's profile scoped to another worker only. */
	grantFor: async ({ workerId, profile }) => {
		const id = `scoped-${++serial}`;
		const { token } = grants.register({
			caller: id,
			scope: { worker_ids: [workerId], cwd_roots: [] },
			methods: profile,
			grant_id: id,
		});
		const file = join(f.dir, `${id}.grant.json`);
		writeBearerFile(file, token);
		return file;
	},
	workers: async () => f.supervisor.list().length,
	shutdown: async () => {
		await unserve();
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
