/**
 * The last lines a child Pi printed when it exited before its session started
 * (#149). Pi writes a startup failure, such as an extension that fails to
 * load, to stderr, which is the child's terminal; the host reads that terminal
 * once and relays a bounded, redacted tail so a failure carries its reason.
 */

/** Terminal lines read once after an early exit. */
export const EXIT_OUTPUT_SCREEN_LINES = 40;
/** Most lines relayed. */
export const EXIT_OUTPUT_MAX_LINES = 12;
/** Most characters per relayed line. */
export const EXIT_OUTPUT_LINE_CHARS = 300;
/** Most characters relayed in total. */
export const EXIT_OUTPUT_MAX_CHARS = 2_000;

const TERMINAL_SENTINEL = /__SUBAGENT_DONE_\d+__/;
// CSI and OSC escape sequences; then, per line, any remaining control.
const ANSI_ESCAPE =
	// oxlint-disable-next-line no-control-regex -- terminal escapes start with ESC.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROL = /\p{Cc}/gu;

const REDACTED = "[redacted]";
const SECRET_PATTERNS: [RegExp, string][] = [
	// user:password@ in a URL
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
	// key, token, signature or password query parameters
	[
		/([?&][^\s=&#]*(?:key|token|sig|signature|secret|password|auth)[^\s=&#]*=)[^\s&#"']+/gi,
		`$1${REDACTED}`,
	],
	// Authorization: Bearer/Basic <credential>
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
	// NAME=value, "name": "value" and name: value for credential-like names
	[
		/(\b[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|credential|authorization)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
		`$1${REDACTED}`,
	],
	// Well-known credential prefixes
	[
		/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b/g,
		REDACTED,
	],
];
// A long opaque run with both letters and digits: likely a key or token.
const OPAQUE_RUN = /[A-Za-z0-9+_=-]{40,}/g;

/** Mask credential-shaped substrings. Best effort: it errs toward masking. */
export function redactSecrets(line: string): string {
	let text = line;
	for (const [pattern, replacement] of SECRET_PATTERNS)
		text = text.replace(pattern, replacement);
	return text.replace(OPAQUE_RUN, (run) =>
		/\d/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run,
	);
}

function clip(line: string, max: number): string {
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * The child's output from a terminal tail: the lines after the launch line
 * (the last line naming `launchScriptFile`, when present) and before the exit
 * marker, cleaned, redacted and bounded. Undefined when nothing is left.
 */
export function extractExitOutput(
	screen: string,
	launchScriptFile?: string,
): string | undefined {
	let lines = screen
		.replace(ANSI_ESCAPE, "")
		.split(/\r?\n|\r/)
		.map((line) => line.replace(/\t/g, " ").replace(CONTROL, "").trimEnd());
	const marker = lines.findLastIndex((line) => TERMINAL_SENTINEL.test(line));
	if (marker !== -1) lines = lines.slice(0, marker);
	const launchName = launchScriptFile?.split(/[\\/]/).pop();
	if (launchName) {
		const launch = lines.findLastIndex((line) => line.includes(launchName));
		if (launch !== -1) lines = lines.slice(launch + 1);
	}
	const tail = lines
		.filter((line) => line.trim() !== "")
		.slice(-EXIT_OUTPUT_MAX_LINES);
	const kept: string[] = [];
	let chars = 0;
	// Newest lines first, so the character bound drops the oldest.
	for (let index = tail.length - 1; index >= 0; index--) {
		const relayed = clip(redactSecrets(tail[index]), EXIT_OUTPUT_LINE_CHARS);
		if (chars + relayed.length > EXIT_OUTPUT_MAX_CHARS) break;
		chars += relayed.length + 1;
		kept.unshift(relayed);
	}
	return kept.length > 0 ? kept.join("\n") : undefined;
}
