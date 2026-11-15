import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertSameHerdrBinding,
	selectHerdrBinding,
} from "../../maestro/core/config/herdr-config.ts";
import {
	AcquisitionUncertainError,
	isAcquisitionUncertainError,
} from "../../maestro/core/surface-provider.ts";

test("Core auto selection requires native terminal context and prefers terminal endpoint", () => {
	// Selection where Core is supported; Windows refuses Core itself
	// (windows-support-scope.test.ts).
	const linux = "linux";
	assert.deepEqual(
		selectHerdrBinding("auto", { HC_SOCKET: "/socket", HERDR_ENV: "1" }, linux),
		{ backend: "legacy" },
	);
	assert.deepEqual(
		selectHerdrBinding("legacy", { HC_TERMINAL_ID: "t1" }, linux),
		{
			backend: "legacy",
		},
	);
	assert.deepEqual(
		selectHerdrBinding(
			"auto",
			{
				HC_TERMINAL_ID: "t1",
				HC_TERMINAL_SOCKET: "/preferred",
				HC_SOCKET: "/fallback",
			},
			linux,
		),
		{ backend: "core", socket: "/preferred", parentTerminal: "t1" },
	);
	assert.deepEqual(
		selectHerdrBinding(
			"core",
			{
				HC_TERMINAL_ID: "t1",
				HC_SOCKET: "/fallback",
			},
			linux,
		),
		{ backend: "core", socket: "/fallback", parentTerminal: "t1" },
	);
	for (const env of [
		{},
		{ HC_SOCKET: "/only" },
		{ HC_TERMINAL_ID: "remote/t1", HC_SOCKET: "/x" },
		{ HC_TERMINAL_ID: "t1", HC_SOCKET: "relative" },
		{ HC_TERMINAL_ID: "t1" },
	])
		assert.throws(
			() => selectHerdrBinding("core", env, linux),
			/native HC_TERMINAL_ID/,
		);
	assert.throws(
		() => selectHerdrBinding("auto", { HC_TERMINAL_ID: "t1" }, linux),
		/native HC_TERMINAL_ID/,
	);
	assertSameHerdrBinding({ backend: "legacy" }, { backend: "legacy" });
	assert.throws(
		() =>
			assertSameHerdrBinding(
				{ backend: "legacy" },
				{ backend: "core", socket: "/x", parentTerminal: "t1" },
			),
		/restart/,
	);
});

test("Core execution-start uncertainty remains structurally recognizable across reloads", () => {
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("owned", {
				kind: "execution-start",
				observedSurfaceId: "t2",
				acquiredSurfaceId: "t2",
			}),
		),
	);
	for (const observedSurfaceId of [undefined, "t3"])
		assert.equal(
			isAcquisitionUncertainError(
				new AcquisitionUncertainError("invalid", {
					kind: "execution-start",
					observedSurfaceId,
					acquiredSurfaceId: "t2",
				}),
			),
			false,
		);
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("uncertain", { kind: "execution-start" }),
		),
	);
	assert.ok(
		isAcquisitionUncertainError(
			new AcquisitionUncertainError("uncertain", {
				kind: "execution-start",
				observedSurfaceId: "t2",
			}),
		),
	);
	assert.equal(
		isAcquisitionUncertainError({
			code: "PIHA_ACQUISITION_UNCERTAIN",
			name: "Error",
			message: "x",
			uncertainty: { kind: "execution-start", observedSurfaceId: "user/name" },
		}),
		false,
	);
});
