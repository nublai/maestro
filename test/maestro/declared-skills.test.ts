import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatDeclaredSkillsEnv,
	parseDeclaredSkills,
	parseDeclaredSkillsEnv,
} from "../../maestro/core/declared-skills.ts";

describe("declared skill names", () => {
	it("splits, trims and dedupes a declaration, and round-trips it through the env", () => {
		const names = parseDeclaredSkills(" tdd, review-notes ,tdd,, a1 ");
		assert.deepEqual(names, ["tdd", "review-notes", "a1"]);
		assert.equal(formatDeclaredSkillsEnv(names), '["tdd","review-notes","a1"]');
		assert.deepEqual(
			parseDeclaredSkillsEnv(formatDeclaredSkillsEnv(names)),
			names,
		);
		assert.deepEqual(parseDeclaredSkills(undefined), []);
		assert.equal(formatDeclaredSkillsEnv([]), "[]");
	});

	it("refuses a name outside Pi's skill-name rules with an actionable error", () => {
		assert.throws(
			() => parseDeclaredSkills("tdd, ../etc"),
			/Invalid skill name "\.\.\/etc".*lowercase letters, digits and single hyphens/,
		);
		assert.doesNotThrow(() => parseDeclaredSkills("a".repeat(64)));
		assert.throws(
			() => parseDeclaredSkills("a".repeat(65)),
			/Invalid skill name/,
		);
	});

	it("reads an absent, empty or malformed env as no skills", () => {
		for (const raw of [undefined, "", "[]", "tdd", "{}", '"tdd"', "[1]", "["]) {
			assert.deepEqual(parseDeclaredSkillsEnv(raw), [], String(raw));
		}
		assert.deepEqual(parseDeclaredSkillsEnv('["tdd", 3, "../x", "ok"]'), [
			"tdd",
			"ok",
		]);
	});
});
