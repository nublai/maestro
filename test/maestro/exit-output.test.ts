import "../isolated-agent-dir.ts";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as runtime from "../../maestro/runtime/index.ts";
import type {
	DefaultRunSessionOptions,
	PiCompletedMetadata,
	PiLaunchInput,
	PiRunRecord,
} from "../../maestro/runtime/pi-run-session-types.ts";
import { FakeSurfaceProvider } from "../../maestro/surfaces/fake/fake-surface-provider.ts";
import { launchOperationsFromSurface } from "../../maestro/adapters/pi/launch-operations.ts";
import { FileWakeRegistry } from "../../maestro/core/wake.ts";
import { SupervisionCoordinator } from "../../maestro/core/supervision.ts";
import {
	EXIT_OUTPUT_LINE_CHARS,
	EXIT_OUTPUT_MAX_CHARS,
	EXIT_OUTPUT_MAX_LINES,
	EXIT_OUTPUT_READ_TIMEOUT_MS,
	extractExitOutput,
	readWithin,
	redactSecrets,
} from "../../maestro/adapters/pi/exit-output.ts";
import {
	renderParentMessage,
	resolveResultPresentation,
} from "../../pi-extension/subagents/presentation.ts";

// Supplemental #149 tests (not migrated identities): a child that exits before
// its session starts reports its last terminal lines, not only an exit code.

const SCRIPT = "/tmp/a/subagent-scripts/Echo-1234.sh";
const LOAD_ERROR =
	'Error: Failed to load extension "/x/index.ts": Failed to load extension: Invalid subagent status config in /h/.pi/agent/herdr-agents/config.json: status must be an object';
const HINT = 'Hint: Start without extensions using "pi -ne".';

test("extracts the child's lines between its launch line and the exit marker", () => {
	const screen = [
		"old output from an earlier command",
		`$ bash '${SCRIPT}'`,
		"\u001b[31m" + LOAD_ERROR + "\u001b[0m",
		"\t" + HINT,
		"",
		"__SUBAGENT_DONE_1__",
		"$ ",
	].join("\r\n");
	assert.equal(extractExitOutput(screen, SCRIPT), `${LOAD_ERROR}\n ${HINT}`);
	// Without a launch line (a Core terminal), everything before the marker.
	assert.equal(
		extractExitOutput(`${LOAD_ERROR}\n${HINT}\n__SUBAGENT_DONE_1__\n`, SCRIPT),
		`${LOAD_ERROR}\n${HINT}`,
	);
	assert.equal(
		extractExitOutput(`$ bash '${SCRIPT}'\n__SUBAGENT_DONE_1__`, SCRIPT),
		undefined,
	);
	assert.equal(extractExitOutput("", SCRIPT), undefined);
});

test("bounds the relayed output by lines, line length and total size", () => {
	const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	const lines = extractExitOutput(many)!.split("\n");
	assert.equal(lines.length, EXIT_OUTPUT_MAX_LINES);
	assert.equal(lines.at(-1), "line 29");
	const long = extractExitOutput("x".repeat(5_000))!;
	assert.equal(long.length, EXIT_OUTPUT_LINE_CHARS);
	assert.ok(long.endsWith("…"));
	// Words, not one opaque run: equal-width rows are rejoined for masking.
	const wide = Array.from({ length: 12 }, (_, i) => `${i} ${"y ".repeat(200)}`);
	const bounded = extractExitOutput(wide.join("\n"))!;
	assert.ok(bounded.length <= EXIT_OUTPUT_MAX_CHARS, String(bounded.length));
	// The newest lines survive the character bound.
	assert.ok(bounded.split("\n").at(-1)!.startsWith("11 "));
});

test("never echoes credential-shaped values", () => {
	const secrets = {
		openai: "sk-proj-AbCdEf0123456789AbCdEf0123456789",
		anthropic: "sk-ant-api03-AbCdEf0123456789AbCdEf0123456789",
		github: "ghp_AbCdEf0123456789AbCdEf0123456789AbCd",
		bearer: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
		env: "hunter2-very-secret",
		query: "Zm9vYmFyYmF6cXV4",
		userinfo: "p4ssw0rd",
		opaque: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
	};
	const screen = [
		`Error: 401 invalid api key ${secrets.openai}`,
		`provider rejected key ${secrets.anthropic}`,
		`git: token ${secrets.github}`,
		`Authorization: Bearer ${secrets.bearer}`,
		`OPENAI_API_KEY=${secrets.env} PASSWORD: "${secrets.env}"`,
		`GET https://api.example.com/v1?alt=json&key=${secrets.query}&x=1`,
		`proxy https://user:${secrets.userinfo}@proxy.example.com:8080`,
		`session ${secrets.opaque}`,
		"__SUBAGENT_DONE_1__",
	].join("\n");
	const output = extractExitOutput(screen)!;
	for (const [name, secret] of Object.entries(secrets))
		assert.ok(!output.includes(secret), `${name} leaked: ${output}`);
	assert.match(output, /\[redacted\]/);
	// Ordinary diagnostics are kept as they are.
	assert.equal(redactSecrets(LOAD_ERROR), LOAD_ERROR);
	assert.equal(redactSecrets(HINT), HINT);
});

// Credential shapes the relay must mask. Built at run time so no literal
// credential-shaped string sits in the source.
interface Credential {
	line: (secret: string) => string;
	secret: string;
}
const b64 = "wJalrXUtnFEMI/K7MDENG/bPxRfiCY+EXAMPLE1K";
const CREDENTIALS = {
	asiaAccessKey: {
		line: (s) => `aws: using temporary credentials ${s} for us-east-1`,
		secret: ["AS", "IA", "ZK7Q2EXAMPLE4XNM"].join(""),
	},
	akiaAccessKey: {
		line: (s) => `InvalidClientTokenId: access key ${s} is not valid`,
		secret: ["AK", "IA", "IOSFODNN7EXAMPLE"].join(""),
	},
	awsSecretKey: {
		line: (s) => `SignatureDoesNotMatch for secret ${s} (check clock)`,
		secret: b64,
	},
	awsSecretKeyEnv: {
		line: (s) => `export AWS_SECRET_ACCESS_KEY=${s}`,
		secret: b64.split("").reverse().join(""),
	},
	shortJwt: {
		line: (s) => `session rejected: ${s} expired`,
		secret: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "c2lnbmF0dXJlX3g"].join(
			".",
		),
	},
	letterJwt: {
		line: (s) => `id_token ${s}`,
		secret: [
			"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
			"eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIiwic3ViIjoiMTIzNDU2Nzg5MCJ9",
			"QWxsTGV0dGVyc0lnbmF0dXJlQWJjZGVmZ2hpamtsbW5vcHFy".replace(/\d/g, "x"),
		].join("."),
	},
	lowercaseBearer: {
		line: (s) => `> authorization: bearer ${s}`,
		secret: ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiIyIn0", ""].join("."),
	},
	bearerOpaque: {
		line: (s) => `curl -H "Authorization: Bearer ${s}" failed`,
		secret: "mF_9.B5f-4.1JqM",
	},
	openai: {
		line: (s) => `Error: 401 invalid api key ${s}`,
		secret: [
			"sk",
			"proj",
			"AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789",
		].join("-"),
	},
	anthropic: {
		line: (s) => `provider rejected key ${s}`,
		secret: ["sk", "ant", "api03", "AbCdEf0123456789AbCdEf0123456789"].join(
			"-",
		),
	},
	github: {
		line: (s) => `git: token ${s} lacks scope`,
		secret: ["ghp", "AbCdEf0123456789AbCdEf0123456789AbCd"].join("_"),
	},
	envValue: {
		line: (s) => `OPENAI_API_KEY=${s} was rejected`,
		secret: "hunter2-very-secret-value",
	},
	query: {
		line: (s) => `GET https://api.example.com/v1?alt=json&key=${s}&x=1`,
		secret: "Zm9vYmFyYmF6cXV4Zm9vYmFy",
	},
	userinfo: {
		line: (s) => `proxy https://user:${s}@proxy.example.com:8080 refused`,
		secret: "p4ssw0rd-long-enough",
	},
	opaque: {
		line: (s) => `session ${s} closed`,
		secret: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
	},
} satisfies Record<string, Credential>;

/** A terminal `columns` wide shows a long line as several visual lines. */
function wrap(text: string, columns = 80): string {
	return text
		.split("\n")
		.flatMap((line) => {
			if (line.length === 0) return [line];
			const rows: string[] = [];
			for (let at = 0; at < line.length; at += columns)
				rows.push(line.slice(at, at + columns));
			return rows;
		})
		.join("\n");
}

/** Rows trimmed and joined as a terminal wrap joins them. */
function unwrapped(text: string): string {
	return text
		.split("\n")
		.map((row) => row.trimEnd())
		.join("");
}

function occurrences(text: string, piece: string): number {
	let count = 0;
	for (
		let at = text.indexOf(piece);
		at !== -1;
		at = text.indexOf(piece, at + 1)
	)
		count++;
	return count;
}

/**
 * No piece of `secret` three or more characters long survives in `output`,
 * letters included: a word-like edge of a wrapped credential ("abc",
 * "object") counts as a leak. `printed` is the text the secret was printed in;
 * a piece may appear in `output` only as often as that text, with every copy
 * of the secret cut out, already holds it ("key" in "invalid api key"). Rows
 * are joined as a terminal wrap joins them, so a piece split across rows is
 * still found, and each "[redacted]" counts as a cut.
 */
function assertMasked(
	output: string,
	name: string,
	secret: string,
	printed: string,
) {
	const source = unwrapped(printed);
	assert.ok(source.includes(secret), `${name}: the secret was not printed`);
	const around = source.replaceAll(secret, "\0");
	const shown = unwrapped(output).replaceAll("[redacted]", "\0");
	assert.ok(!shown.includes(secret), `${name} leaked: ${output}`);
	for (let at = 0; at + 3 <= secret.length; at++) {
		const piece = secret.slice(at, at + 3);
		assert.ok(
			occurrences(shown, piece) <= occurrences(around, piece),
			`${name} leaked "${piece}": ${output}`,
		);
	}
}

test("masks AWS keys, JWTs of any length and every listed credential shape", () => {
	for (const [name, { line, secret }] of Object.entries(CREDENTIALS)) {
		const output = extractExitOutput(`${line(secret)}\n__SUBAGENT_DONE_1__`)!;
		assertMasked(output, name, secret, line(secret));
		assert.match(output, /\[redacted\]/, name);
		assertMasked(redactSecrets(line(secret)), name, secret, line(secret));
	}
	for (const prefix of [
		"AKIA",
		"ASIA",
		"ABIA",
		"ACCA",
		"AGPA",
		"AIDA",
		"AIPA",
		"ANPA",
		"ANVA",
		"APKA",
		"AROA",
		"ASCA",
		"A3T7",
	]) {
		const key = `${prefix}QWERTY23UIOPASDF`;
		const printed = `key ${key} denied`;
		assertMasked(redactSecrets(printed), prefix, key, printed);
	}
});

test("masks a credential an 80-column terminal wrap splits across lines", () => {
	for (const [name, { line, secret }] of Object.entries(CREDENTIALS)) {
		const text = line(secret);
		const start = text.indexOf(secret);
		// Split near each end and in the middle of the credential; cut 0 wraps
		// on the space before it, which the trimmed row loses.
		for (const cut of new Set([
			0,
			1,
			3,
			Math.floor(secret.length / 2),
			secret.length - 3,
			secret.length - 1,
		])) {
			const pad = (((80 - start - cut) % 80) + 80) % 80;
			const screen = wrap(
				`Error: provider failed\n${"~".repeat(pad)}${text}\nHint: retry\n__SUBAGENT_DONE_1__`,
			);
			const rows = screen.split("\n");
			const row = rows.findIndex(
				(r) =>
					r.length === 80 &&
					r.endsWith(secret.slice(Math.max(0, cut - 80), cut)),
			);
			assert.ok(
				row !== -1 && rows[row + 1].startsWith(secret.slice(cut, cut + 80)),
				`${name} cut ${cut}`,
			);
			const output = extractExitOutput(screen)!;
			assertMasked(output, `${name} cut ${cut}`, secret, screen);
			assert.ok(output.endsWith("Hint: retry"), output);
			assert.ok(output.startsWith("Error: provider failed\n"), output);
		}
	}
});

// Credentials whose first or last characters look like an ordinary word. A
// relay that shows a word-like piece at a row join, as nublai/maestro#4 did,
// leaks that piece; these keep such edges under test.
const WORD_EDGES = {
	opaqueWordHead: {
		line: (s) => `session ${s} closed`,
		secret: "abcdef0123456789abcdef0123456789abcdef01234",
	},
	opaqueLongWordHead: {
		line: (s) => `session ${s} closed`,
		secret: "abcdef0123456789abcdef0123456789abcdef01234567",
	},
	opaquePasswordHead: {
		line: (s) => `session ${s} closed`,
		secret: "passwordcorrect0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
	},
	opaqueHexTail: {
		line: (s) => `session ${s} closed`,
		secret: `${"0123456789".repeat(4)}abcdefab`,
	},
	opaqueWordBothEnds: {
		line: (s) => `session ${s} closed`,
		secret: `object${"0123456789AbCdEf".repeat(5)}Retry`,
	},
	openaiWordTail: {
		line: (s) => `Error: 401 invalid api key ${s}`,
		secret: ["sk", "proj", "AbCdEf0123456789AbCdEf0123456789object"].join("-"),
	},
	skUpperTail: {
		line: (s) => `provider rejected key ${s}`,
		secret: ["sk", "AbCdEf0123456789AbCdREADME"].join("-"),
	},
	jwtWordTail: {
		line: (s) => `session rejected: ${s} expired`,
		secret: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "object"].join("."),
	},
	envWordTail: {
		line: (s) => `OPENAI_API_KEY=${s} was rejected`,
		secret: "zzobject",
	},
	githubWordHead: {
		line: (s) => `git: token ${s} lacks scope`,
		secret: ["ghp", "AbCdEf0123456789AbCdEf0123456789AbCdEf01"].join("_"),
	},
	bearerCapitalTail: {
		line: (s) => `curl -H "Authorization: Bearer ${s}" failed`,
		secret: "AbCdEf0123456789Retry",
	},
	queryWordTail: {
		line: (s) => `GET https://api.example.com/v1?alt=json&key=${s}&x=1`,
		secret: "Zm9vYmFyYmF6cXV4object,",
	},
} satisfies Record<string, Credential>;

/** A wrapped screen as a terminal read returns it: LF, CRLF, or CRLF with SGR. */
const READS = {
	lf: (rows: string[]) => rows.join("\n"),
	crlf: (rows: string[]) => rows.join("\r\n"),
	ansi: (rows: string[]) =>
		rows
			.map((row) => (row ? `\u001b[2m${row}\u001b[0m\u001b]0;pi\u0007` : row))
			.join("\r\n"),
} satisfies Record<string, (rows: string[]) => string>;

test("masks every credential shape at every wrap offset in 40 to 200 columns, read as LF, CRLF or ANSI", () => {
	const credentials = { ...CREDENTIALS, ...WORD_EDGES };
	for (const columns of [40, 80, 100, 120, 200])
		for (const [name, { line, secret }] of Object.entries(credentials)) {
			const text = line(secret);
			const start = text.indexOf(secret);
			for (let cut = 0; cut < secret.length; cut++) {
				const pad = (((columns - start - cut) % columns) + columns) % columns;
				const rows = wrap(
					`Error: provider failed\n${"~".repeat(pad)}${text}\nHint: retry\n__SUBAGENT_DONE_1__`,
					columns,
				).split("\n");
				const at = `${name} at ${columns} columns, cut ${cut}`;
				assert.ok(
					rows.some(
						(r, row) =>
							r.length === columns &&
							r.endsWith(secret.slice(Math.max(0, cut - columns), cut)) &&
							rows[row + 1].startsWith(secret.slice(cut, cut + columns)),
					),
					at,
				);
				for (const [form, read] of Object.entries(READS)) {
					const output = extractExitOutput(read(rows))!;
					assertMasked(output, `${at} (${form})`, secret, rows.join("\n"));
					assert.ok(output.startsWith("Error: provider failed\n"), output);
					// Documented limit: when the credential's last row is full width,
					// the next line is joined to it, and a word glued to the end of the
					// credential-shaped run ("Hint", or "Hint:" when the rule takes the
					// colon) is masked with it.
					const last = output.split("\n").at(-1)!;
					const glued =
						rows[rows.indexOf("Hint: retry") - 1].length === columns;
					assert.ok(
						last === "Hint: retry" ||
							(glued && /^\[redacted\]:? retry$/.test(last)),
						`${at}: ${output}`,
					);
				}
			}
		}
});

// pi-herdr-agents#150: the widest row is a whole error line that did not wrap,
// and the next line holds a credential. The relay cannot tell that row from a
// wrapped one, so it joins them. Documented limit: the error's last word,
// glued to the credential-shaped run, is masked with it ("status must be an
// [redacted]"). The secret stays masked and the rest of the error survives.
const OPENAI_ENV = (secret: string) => `OPENAI_API_KEY=${secret}`;
const OPENAI_SECRET = ["sk", "proj", "AbCdEf0123456789AbCdEf0123456789"].join(
	"-",
);
const ERROR_PREFIX = "Invalid subagent status config in";

test("masks a credential on the line after a long unwrapped error and keeps the error's prefix", () => {
	const screen = `$ bash '${SCRIPT}'\n${LOAD_ERROR}\n${OPENAI_ENV(OPENAI_SECRET)}\n__SUBAGENT_DONE_1__\n`;
	const kept = LOAD_ERROR.slice(0, LOAD_ERROR.lastIndexOf(" ") + 1);
	assert.ok(kept.includes(ERROR_PREFIX));
	for (const [form, read] of Object.entries(READS)) {
		const output = extractExitOutput(read(screen.split("\n")), SCRIPT)!;
		const [error, credential, ...rest] = output.split("\n");
		assert.ok(error.startsWith(kept), `${form}: ${output}`);
		assert.ok(error.includes(ERROR_PREFIX), `${form}: ${output}`);
		assert.deepEqual(rest, [], form);
		assert.match(credential, /\[redacted\]/, form);
		assertMasked(
			output,
			`next-line credential (${form})`,
			OPENAI_SECRET,
			screen,
		);
	}
});

test("keeps ordinary paths and diagnostics while masking", () => {
	for (const ordinary of [
		LOAD_ERROR,
		HINT,
		"    at loadExtension (/home/dev/projects/maestro/node_modules/pi/dist/loader.js:42:13)",
		"Cannot find module /Users/Alice/Library/Application/Support/pi/agent/extensions/index.ts",
		"see src/components/settings/ModelPicker2/index.tsx for details",
		"authorization failed: check your config",
	])
		assert.equal(redactSecrets(ordinary), ordinary);
	const wrapped = wrap(
		`${"x".repeat(70)} ${LOAD_ERROR}\n${HINT}\n__SUBAGENT_DONE_1__`,
	);
	assert.equal(
		extractExitOutput(wrapped)!.replace(/\s/g, ""),
		`${"x".repeat(70)} ${LOAD_ERROR}${HINT}`.replace(/\s/g, ""),
	);
});

test("bounds a terminal read that never settles", async () => {
	const started = Date.now();
	assert.equal(
		await readWithin(() => new Promise<string>(() => {}), 20),
		undefined,
	);
	assert.ok(Date.now() - started < 1_000);
	assert.equal(await readWithin(() => "done", 20), "done");
	assert.equal(
		await readWithin(() => Promise.reject(new Error("gone")), 20),
		undefined,
	);
	assert.equal(
		await readWithin(() => {
			throw new Error("gone");
		}, 20),
		undefined,
	);
});

async function withRunSession(
	run: (f: {
		dir: string;
		provider: FakeSurfaceProvider;
		session: ReturnType<typeof runtime.createDefaultRunSession>;
		input: PiLaunchInput;
		settled: PiCompletedMetadata[];
		latest: () => PiRunRecord;
	}) => Promise<void>,
) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "maestro-149-exit-")));
	const parent = join(dir, "parent.jsonl");
	writeFileSync(
		parent,
		JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) +
			"\n",
	);
	mkdirSync(join(dir, "sessions"));
	const provider = new FakeSurfaceProvider();
	const paneConfig = { mode: "tab", direction: "right", maxPerTab: 4 } as const;
	const operations = launchOperationsFromSurface(provider, paneConfig);
	operations.waitForShellReady = async () => {};
	operations.runScript = (_id, _command, options) => options.scriptPath;
	const coordinator = new SupervisionCoordinator(
		async () => ({
			complete: true,
			panes: provider
				.listSurfaces()
				.map((s) => ({ paneId: s.id, workspaceId: "fixture" })),
		}),
		(id) => provider.inspectSurface(id),
		false,
		new FileWakeRegistry(),
	);
	const settled: PiCompletedMetadata[] = [];
	let latest: PiRunRecord | undefined;
	const options: DefaultRunSessionOptions = {
		configDir: dir,
		configExamplePath: fileURLToPath(
			new URL("../../config.json.example", import.meta.url),
		),
		infrastructure: {
			surfaceProvider: provider,
			launchOperations: operations,
			supervision: coordinator,
		},
		forcePolling: false,
		roles: [],
		getLaunchSnapshot: () => ({
			parent: {
				cwd: dir,
				invocationCwd: dir,
				sessionFile: parent,
				sessionId: "parent",
				sessionDir: join(dir, "sessions"),
				agentDir: dir,
			},
			parentRuntime: { provider: "test", modelId: "one", thinking: "high" },
			paneConfig,
			modelRegistry: {
				find: (p, id) => ({ provider: p, id, reasoning: true }),
				available: () => [],
				hasConfiguredAuth: () => true,
				supportedThinkingLevels: () => ["off", "high"],
				clampThinkingLevel: (_model, level) => level,
			},
		}),
		hooks: {
			onSpawned(record) {
				latest = record;
			},
			onSettled(_record, result) {
				settled.push(result);
			},
		},
		persistent: {
			send: () => ({ error: "test policy" }),
			stop: () => ({ error: "test policy" }),
			drain() {},
		},
	};
	const session = runtime.createDefaultRunSession(options);
	const input: PiLaunchInput = {
		task: {
			id: "early-exit",
			name: "Echo",
			prompt: "bounded",
			role: "",
			cwd: dir,
			behavior: { autoExit: true, persistent: false },
		},
		role: {
			name: "",
			version: "1",
			description: "fixture",
			systemPrompt: "",
			allowedTools: [],
		},
		plans: [
			{
				provider: "test",
				modelId: "one",
				model: "test/one",
				thinking: "high",
				modelSource: "request",
				thinkingSource: "parent",
			},
		],
		resolved: {},
		identity: {
			id: "public-early-exit",
			logicalId: "logical-early-exit",
			generationId: "generation-early-exit",
			taskId: "inbox-early-exit",
		},
	};
	try {
		await run({
			dir,
			provider,
			session,
			input,
			settled,
			latest: () => latest!,
		});
	} finally {
		await session.shutdown("quit");
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A run surface without the run's directory, timestamps, ids and hashes. They
 * are not from the screen; cutting them out keeps a three-character piece of a
 * credential from matching one by chance.
 */
function plain(surface: string, dir: string): string {
	return surface
		.replaceAll(dir, "\0")
		.replace(/\d{4}-\d\d-\d\dT\d\d[:-]\d\d[:-]\d\d[.-]\d{3}Z/g, "\0")
		.replace(/\b[0-9a-f]{64}\b/g, "\0")
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{4}\b/g, "\0");
}

function delivered(result: PiCompletedMetadata): string {
	return renderParentMessage(
		resolveResultPresentation(
			{ ...result, sessionFile: result.sessionFile },
			result.name,
		),
	);
}

test("a child that exits before its session starts reports its last terminal lines to the parent", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		f.provider.appendScreen(
			record.surface,
			`$ bash '${record.launchScriptFile}'\n${LOAD_ERROR}\n${HINT}\n__SUBAGENT_DONE_1__\n`,
		);
		await wait;
		assert.equal(f.settled.length, 1);
		const result = f.settled[0];
		assert.equal(result.exitCode, 1);
		assert.equal(result.errorMessage, undefined, "not a provider error");
		assert.equal(
			result.summary,
			`Sub-agent exited with code 1 before its session started. Last output:\n${LOAD_ERROR}\n${HINT}`,
		);
		const text = delivered(result);
		assert.match(text, /Sub-agent "Echo" failed \(exit code 1\)\./);
		assert.ok(text.includes("status must be an object"), text);
		assert.ok(text.includes("pi -ne"), text);
	}));

test("a wrapped early-exit tail reaches the parent masked, and the ledger and logs stay clean", () =>
	withRunSession(async (f) => {
		const relayed = (
			[
				"asiaAccessKey",
				"awsSecretKey",
				"shortJwt",
				"lowercaseBearer",
				"openai",
			] as const
		).map((name) => [name, CREDENTIALS[name]] as const);
		const logged: string[] = [];
		const original = {
			log: console.log,
			error: console.error,
			warn: console.warn,
			info: console.info,
			debug: console.debug,
		};
		for (const method of ["log", "error", "warn", "info", "debug"] as const)
			console[method] = (...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
		let screen = "";
		try {
			const handle = await f.session.spawnPi(f.input);
			const record = f.latest();
			const wait = f.session.supervise(handle, f.input.task);
			// Each credential straddles the 80-column wrap.
			const printed = relayed.map(([, { line, secret }]) => {
				const text = line(secret);
				return `${"~".repeat(80 - text.indexOf(secret) - 5)}${text}`;
			});
			screen = wrap(
				`$ bash '${record.launchScriptFile}'\n${printed.join("\n")}\n__SUBAGENT_DONE_1__\n`,
			);
			f.provider.appendScreen(record.surface, screen);
			await wait;
		} finally {
			Object.assign(console, original);
		}
		const result = f.settled[0];
		assert.match(result.summary, /before its session started\. Last output:/);
		assert.ok(result.summary.includes("temporary credentials"), result.summary);
		const text = delivered(result);
		assert.ok(text.includes("temporary credentials"), text);
		const ledger = readFileSync(
			join(f.dir, "herdr-agents", "outcomes.jsonl"),
			"utf8",
		);
		assert.match(ledger, /"failed"/);
		const files = readdirSync(f.dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
		assert.ok(files.length > 0);
		for (const [name, { secret }] of relayed) {
			assertMasked(result.summary, name, secret, screen);
			assertMasked(plain(text, f.dir), name, secret, screen);
			assertMasked(
				plain(ledger, f.dir),
				`${name} in the ledger`,
				secret,
				screen,
			);
			assertMasked(logged.join("\n"), `${name} in logs`, secret, screen);
			for (const file of files)
				assertMasked(
					plain(file, f.dir),
					`${name} in a run file`,
					secret,
					screen,
				);
		}
	}));

test("an unwrapped error followed by a credential line reaches the parent masked, with the error's prefix", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		const screen = `$ bash '${record.launchScriptFile}'\n${LOAD_ERROR}\n${OPENAI_ENV(OPENAI_SECRET)}\n__SUBAGENT_DONE_1__\n`;
		f.provider.appendScreen(record.surface, screen);
		await wait;
		assert.equal(f.settled.length, 1);
		const result = f.settled[0];
		const kept = LOAD_ERROR.slice(0, LOAD_ERROR.lastIndexOf(" ") + 1);
		assert.ok(
			result.summary.startsWith(
				`Sub-agent exited with code 1 before its session started. Last output:\n${kept}`,
			),
			result.summary,
		);
		const text = delivered(result);
		assert.ok(text.includes(ERROR_PREFIX), text);
		assertMasked(result.summary, "summary", OPENAI_SECRET, screen);
		assertMasked(plain(text, f.dir), "parent message", OPENAI_SECRET, screen);
	}));

test(
	"an early exit whose terminal read never settles still settles",
	{ timeout: EXIT_OUTPUT_READ_TIMEOUT_MS + 10_000 },
	() =>
		withRunSession(async (f) => {
			const handle = await f.session.spawnPi(f.input);
			const record = f.latest();
			const wait = f.session.supervise(handle, f.input.task);
			const read = f.provider.readScreen.bind(f.provider);
			// The 40-line exit read hangs; any other read is answered.
			Object.defineProperty(f.provider, "readScreen", {
				value: (id: string, lines?: number) =>
					id === record.surface && lines !== undefined && lines > 20
						? new Promise<string>(() => {})
						: read(id, lines),
			});
			f.provider.appendScreen(
				record.surface,
				`$ bash '${record.launchScriptFile}'\nboom\n__SUBAGENT_DONE_1__\n`,
			);
			await wait;
			assert.equal(f.settled[0].summary, "Sub-agent exited with code 1");
		}),
);

test("an early exit with nothing printed keeps the plain exit-code summary", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		f.provider.appendScreen(
			record.surface,
			`$ bash '${record.launchScriptFile}'\n__SUBAGENT_DONE_1__\n`,
		);
		await wait;
		assert.equal(f.settled[0].summary, "Sub-agent exited with code 1");
	}));

test("a child whose session started is reported from its transcript, not its terminal", () =>
	withRunSession(async (f) => {
		const handle = await f.session.spawnPi(f.input);
		const record = f.latest();
		const wait = f.session.supervise(handle, f.input.task);
		writeFileSync(
			record.sessionFile,
			[
				{ type: "session", version: 3, id: record.id, cwd: f.dir },
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "go" }] },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		f.provider.appendScreen(record.surface, "noise\n__SUBAGENT_DONE_1__\n");
		await wait;
		assert.equal(f.settled[0].summary, "Sub-agent exited with code 1");
	}));
