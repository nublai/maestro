import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { gitEnvironment } from "../../maestro/core/git-environment.ts";

test("Git environment drops only repository overrides and copies its input", () => {
	const removed = [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_IMPLICIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_PREFIX",
		"GIT_SHALLOW_FILE",
		"GIT_GRAFT_FILE",
		"GIT_REPLACE_REF_BASE",
		"GIT_NO_REPLACE_OBJECTS",
		"GIT_CONFIG",
		"GIT_CONFIG_PARAMETERS",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0",
		"GIT_CONFIG_KEY_123",
		"GIT_CONFIG_VALUE_123",
	];
	const kept = [
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_NOSYSTEM",
		"HOME",
		"XDG_CONFIG_HOME",
		"PATH",
		"GIT_AUTHOR_NAME",
		"GIT_COMMITTER_EMAIL",
		"GIT_SSH_COMMAND",
		"GIT_ASKPASS",
		"GNUPGHOME",
	];
	const input = Object.freeze(
		Object.fromEntries([...removed, ...kept].map((key) => [key, "value"])),
	);
	const before = { ...input };
	const env = gitEnvironment(input);
	assert.notEqual(env, input);
	assert.deepEqual(input, before);
	assert.deepEqual(env, Object.fromEntries(kept.map((key) => [key, "value"])));
});
