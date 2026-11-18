/**
 * Subprocess for the SIGKILL cuts: runs the shared OutcomeStore workload on
 * the real filesystem and kills itself before or after one file operation.
 *
 *   outcome-store-child.ts <dir> trace            print every operation and ack
 *   outcome-store-child.ts <dir> cut <n> <phase>  SIGKILL around operation n
 *   outcome-store-child.ts <dir> hold             hold the writer lock until stdin ends
 *   outcome-store-child.ts <dir> try              hold it like `hold`, or print `locked <code>`
 *
 * Output lines go straight to fd 1, so they are on the pipe before a kill.
 */
import { writeSync } from "node:fs";
import {
	nodeOutcomeStoreFs,
	type OutcomeStoreFs,
} from "../../maestro/runtime/file-outcome-store.ts";
import { openScenarioStore, runScenario } from "./outcome-store-scenario.ts";

const [dir, mode, at, phase] = process.argv.slice(2);
if (!dir || !mode) throw new Error("usage: <dir> trace|cut|hold|try");

function say(line: string): void {
	writeSync(1, `${line}\n`);
}

let index = 0;
const target = mode === "cut" ? Number(at) : -1;

function around<A extends unknown[], R>(
	name: string,
	call: (...args: A) => R,
): (...args: A) => R {
	return (...args) => {
		const current = index++;
		if (mode === "trace") say(`op ${current} ${name}`);
		if (current === target && phase === "before")
			process.kill(process.pid, "SIGKILL");
		const value = call(...args);
		if (current === target && phase === "after")
			process.kill(process.pid, "SIGKILL");
		return value;
	};
}

const base = nodeOutcomeStoreFs;
const fs: OutcomeStoreFs = {
	mkdirSync: around("mkdir", base.mkdirSync),
	openSync: around("open", base.openSync),
	writeSync: around("write", base.writeSync),
	fsyncSync: around("fsync", base.fsyncSync),
	ftruncateSync: around("ftruncate", base.ftruncateSync),
	closeSync: around("close", base.closeSync),
	readFileSync: around("read", base.readFileSync),
	renameSync: around("rename", base.renameSync),
	linkSync: around("link", base.linkSync),
	unlinkSync: around("unlink", base.unlinkSync),
};

if (mode === "hold" || mode === "try") {
	const store = await openScenarioStore(dir, undefined, mode).catch(
		(error: Error & { code?: string }) => {
			if (mode === "hold") throw error;
			say(`locked ${error.code}`);
			process.exit(0);
		},
	);
	say("ready");
	process.stdin.resume();
	process.stdin.on("end", () => {
		void store.close().then(() => {
			say("released");
			process.exit(0);
		});
	});
} else {
	const store = await openScenarioStore(dir, fs, "a");
	say("ack 0");
	await runScenario(store, (step) => say(`ack ${step}`));
	await store.close();
	say("done");
}
