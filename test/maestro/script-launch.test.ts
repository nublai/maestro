import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildScriptLaunchCommand,
	classifyPaneShell,
	isWslBashLauncher,
	powerShellQuote,
	type PaneShell,
} from "../../maestro/core/script-launch.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

const CJK_BASH = "D:\\工具 箱\\王小明's Git\\bin\\bash.exe";

const WIN_SCRIPT = "C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh";

const WSL_BASH = "C:\\Windows\\System32\\bash.exe";

const SCRIPT_UNIX = "/tmp/it's here/cmd-1.sh";

const BARE_UNIX = `bash '/tmp/it'\\''s here/cmd-1.sh'`;

function win(
	paneShell: PaneShell | undefined,
	bash: string | undefined,
	scriptPath = WIN_SCRIPT,
) {
	return buildScriptLaunchCommand({
		scriptPath,
		platform: "win32",
		paneShell,
		resolveShell: () => bash,
	});
}

describe("buildScriptLaunchCommand per pane shell", () => {
	it("calls an absolute bash through PowerShell's & operator", () => {
		assert.equal(
			win("powershell", GIT_BASH),
			`& 'C:\\Program Files\\Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("keeps spaces, CJK characters and quotes intact for PowerShell", () => {
		assert.equal(
			win("powershell", CJK_BASH),
			`& 'D:\\工具 箱\\王小明''s Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
		// PowerShell also ends a literal at typographic single quotes.
		assert.equal(powerShellQuote("a‘b’c‚d‛e"), "'a‘‘b’’c‚‚d‛‛e'");
	});

	it("double-quotes both paths for cmd.exe", () => {
		assert.equal(
			win("cmd", CJK_BASH),
			`"D:\\工具 箱\\王小明's Git\\bin\\bash.exe" "C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh"`,
		);
	});

	it("refuses a cmd.exe line whose path cmd would expand", () => {
		for (const bad of [
			"C:\\a%PATH%\\bash.exe",
			"C:\\a!x!\\bash.exe",
			'C:\\a"b\\bash.exe',
		]) {
			assert.throws(() => win("cmd", bad), /cmd\.exe pane.*", % or !/s);
			assert.throws(() => win("cmd", GIT_BASH, bad), /cmd\.exe pane/);
		}
		// The same paths are fine for the shells that do not expand them.
		assert.match(win("powershell", "C:\\a%PATH%\\bash.exe"), /^& /);
		assert.match(win("posix", "C:\\a!x!\\bash.exe"), /^'C:/);
	});

	it("POSIX-quotes the Windows paths for Git Bash and sh", () => {
		assert.equal(
			win("posix", CJK_BASH),
			`'D:\\工具 箱\\王小明'\\''s Git\\bin\\bash.exe' 'C:\\Users\\王 小明\\AppData\\Local\\Temp\\cmd-1.sh'`,
		);
	});

	it("keeps the old bare line for an unknown shell and never resolves bash", () => {
		const resolveShell = () => {
			throw new Error("must not resolve without a known pane shell");
		};
		for (const paneShell of [undefined]) {
			assert.equal(
				buildScriptLaunchCommand({
					scriptPath: SCRIPT_UNIX,
					platform: "win32",
					paneShell,
					resolveShell,
				}),
				BARE_UNIX,
			);
		}
	});

	it("fails clearly once an absolute path would be typed and no bash resolves", () => {
		for (const paneShell of ["powershell", "cmd"] as const) {
			assert.throws(
				() => win(paneShell, undefined),
				/No bash found.*shellPath/s,
			);
			assert.throws(
				() =>
					buildScriptLaunchCommand({
						scriptPath: WIN_SCRIPT,
						platform: "win32",
						paneShell,
					}),
				/No bash found/,
			);
		}
	});

	it("refuses the WSL launcher and says how to point shellPath at Git", () => {
		for (const wsl of [WSL_BASH, "c:/windows/sysnative/BASH.EXE"]) {
			for (const paneShell of ["powershell", "cmd"] as const) {
				assert.throws(
					() => win(paneShell, wsl),
					/WSL launcher.*shellPath.*Scoop or MSYS2.*LOCALAPPDATA/s,
				);
			}
		}
	});

	it("keeps the bare line in a Git Bash pane when no usable bash resolves", () => {
		const bare = `bash '${WIN_SCRIPT}'`;
		assert.equal(win("posix", undefined), bare);
		assert.equal(win("posix", WSL_BASH), bare);
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				paneShell: "posix",
			}),
			bare,
		);
		assert.equal(
			buildScriptLaunchCommand({
				scriptPath: WIN_SCRIPT,
				platform: "win32",
				paneShell: "posix",
				resolveShell: () => {
					throw new Error("No bash shell found.");
				},
			}),
			bare,
		);
		// PowerShell and cmd panes would hit WSL or nothing, so they still refuse.
		for (const paneShell of ["powershell", "cmd"] as const) {
			assert.throws(
				() =>
					buildScriptLaunchCommand({
						scriptPath: WIN_SCRIPT,
						platform: "win32",
						paneShell,
						resolveShell: () => {
							throw new Error("No bash shell found.");
						},
					}),
				/No bash shell found/,
			);
		}
	});

	it("leaves darwin and linux as a bare bash and never resolves a shell", () => {
		for (const platform of ["darwin", "linux"] as const) {
			for (const paneShell of [
				undefined,
				"powershell",
				"cmd",
				"posix",
			] as const) {
				assert.equal(
					buildScriptLaunchCommand({
						scriptPath: SCRIPT_UNIX,
						platform,
						paneShell,
						resolveShell: () => {
							throw new Error("must not resolve off Windows");
						},
					}),
					BARE_UNIX,
				);
			}
		}
	});

	it("recognises only the WSL launcher paths", () => {
		assert.equal(isWslBashLauncher(WSL_BASH), true);
		assert.equal(isWslBashLauncher("C:/Windows/Sysnative/bash.exe"), true);
		assert.equal(isWslBashLauncher(GIT_BASH), false);
		assert.equal(isWslBashLauncher("C:\\Windows\\System32\\bash.cmd"), false);
	});

	it("quotes PowerShell literals by doubling single quotes", () => {
		assert.equal(powerShellQuote("a'b"), "'a''b'");
	});
});

describe("classifyPaneShell", () => {
	it("maps the process names Windows Herdr reports", () => {
		assert.equal(classifyPaneShell("powershell.exe"), "powershell");
		assert.equal(classifyPaneShell("pwsh.exe"), "powershell");
		assert.equal(classifyPaneShell("PWSH"), "powershell");
		assert.equal(classifyPaneShell("cmd.exe"), "cmd");
		assert.equal(classifyPaneShell("bash.exe"), "posix");
		assert.equal(classifyPaneShell("sh.exe"), "posix");
		assert.equal(
			classifyPaneShell("C:\\Program Files\\Git\\bin\\bash.exe"),
			"posix",
		);
	});

	it("leaves everything else unknown", () => {
		for (const name of [
			"nu.exe",
			"zsh.exe",
			"fish",
			"",
			undefined,
			"cmd.exe.bak",
		]) {
			assert.equal(classifyPaneShell(name), undefined);
		}
	});
});
