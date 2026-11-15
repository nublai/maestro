import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiExtension } from "../../pi-extension/subagents/extension.ts";
import type { PiPresentationHooks } from "../../pi-extension/subagents/presentation-hooks.ts";
import type { HostSurfaceBinding } from "../../maestro/runtime/host-surface-binding.ts";
import type { SurfaceProvider } from "../../maestro/core/surface-provider.ts";
import {
	loadHerdrConfig,
	selectHerdrBinding,
} from "../../maestro/core/config/herdr-config.ts";

export {
	hasWorkingSubagents,
	shouldDeliverSubagentCompletion,
	selectCompletionApi,
	shouldPreserveSubagentsOnShutdown,
	cleanupSubagentsForShutdown,
	shouldAdvanceToFallback,
} from "../../pi-extension/subagents/extension.ts";

/**
 * Test-only composition entry for migrated cases that imported the upstream
 * terminal entry (`pi-extension/subagents/index.ts`). It calls the real
 * `createPiExtension` once per module load, as that entry does, with test
 * hooks in place of the terminal host's:
 *
 * - presentation records refresh calls and registers nothing; widget and
 *   message rendering stay upstream, so their assertions are not migrated;
 * - the binding resolves the unchanged core selection, and its providers refuse
 *   every terminal operation. A case that launches without injected
 *   infrastructure therefore fails here and stays upstream with the Herdr host.
 */
export const presentationCalls: string[] = [];

const terminalOnly = (what: string) => () => {
	throw new Error(`${what} is terminal presentation; it stays upstream`);
};

export const testPresentation: PiPresentationHooks = {
	createWidgets() {
		return {
			renderSubagentWidgetLines: terminalOnly("renderSubagentWidgetLines"),
			updateWidget: () => presentationCalls.push("updateWidget"),
			startStatusRefresh: () => presentationCalls.push("startStatusRefresh"),
			startWidgetRefresh: () => presentationCalls.push("startWidgetRefresh"),
			stopRefresh: () => presentationCalls.push("stopRefresh"),
		};
	},
	borderLine: terminalOnly("borderLine"),
	registerMessageRenderers() {},
};

/** A provider with no terminal: never available, and every operation refuses. */
export function refusingProvider(): SurfaceProvider {
	const refuse = (): never => {
		throw new Error("Test host: no terminal provider");
	};
	return {
		name: "test-host",
		isAvailable: () => false,
		setupHint: () => "Test host: no terminal provider",
		createSurface: refuse,
		runCommand: refuse,
		readScreen: refuse,
		closeSurface: refuse,
		listSurfaces: refuse,
		attachSurface: refuse,
		createWorktreeSurface: refuse,
		removeWorktreeSurface: refuse,
		reportOpenedPrimaryWorkspace: refuse,
		runScript: refuse,
		inspectSurface: refuse,
		sendKeys: refuse,
		getProcessInfo: refuse,
		waitForShellReady: refuse,
		waitForSurfaceAbsence: refuse,
		listWorktreeSurfaces: refuse,
		focusWorkspace: refuse,
		setTitle: refuse,
	};
}

export const testHostSurface: HostSurfaceBinding = {
	resolve: (configDir, examplePath, platform = process.platform) =>
		selectHerdrBinding(
			loadHerdrConfig(join(configDir, "herdr-agents"), examplePath),
			process.env,
			platform,
		),
	createProvider: refusingProvider,
	createLaunchProvider: refusingProvider,
};

const extension = createPiExtension({
	hostSurface: testHostSurface,
	presentation: testPresentation,
	configAssetRoot: fileURLToPath(new URL("../../", import.meta.url)),
});

export const __test__ = extension.__test__;
export default extension;
