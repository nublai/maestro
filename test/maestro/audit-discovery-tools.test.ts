import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	getAgentConfigDir,
	getSubagentsConfigPath,
} from "../../pi-extension/subagents/config-path.ts";

test("host config paths use Pi's public agent-directory resolver", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		for (const value of [
			undefined,
			"",
			"~",
			"~/custom-agent",
			"relative/agent",
			"/tmp/custom-agent",
		]) {
			if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = value;
			assert.equal(getAgentConfigDir(), getAgentDir(), String(value));
			assert.equal(
				getSubagentsConfigPath(),
				join(getAgentDir(), "herdr-agents", "config.json"),
			);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
