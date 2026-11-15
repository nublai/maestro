import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Load the Pi factory facade (source TS or installed JS), call
 * createPiExtension per load with fake host hooks and print what each load
 * registers through a recording API in parent and child/deny-tool scopes,
 * plus the config asset it resolves and the configuration each load reads.
 * Used by test:package to compare the installed factory with its source.
 * It never runs a tool and never touches a terminal.
 */
interface Registered {
	name: string;
	description?: string;
	parameters?: unknown;
	renderCall?: unknown;
	renderResult?: unknown;
}

/** The only events this capture emits: a quit shutdown with a widget-less UI. */
interface ShutdownEvent {
	reason: "quit";
}
interface ShutdownContext {
	ui: { setWidget(): void };
}
type Handler = (
	event: ShutdownEvent,
	ctx: ShutdownContext,
) => Promise<void> | void;

export interface FactoryCapture {
	example: { path: string; text: string };
	statusEnabledPerLoad: boolean[];
	scopes: Record<
		"parent" | "child",
		{
			testSurface: string[];
			tools: Registered[];
			commands: Registered[];
			renderers: string[];
			events: [string, number][];
		}
	>;
}

export async function capturePiFactory(
	facade: string,
	configPath: string,
	agentDir: string,
): Promise<FactoryCapture> {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ["PI_SUBAGENT_ID", "PI_DENY_TOOLS"])
		delete process.env[name];
	const { createPiExtension } = await import(pathToFileURL(facade).href);
	const { getSubagentsConfigExamplePath } = await import(
		pathToFileURL(configPath).href
	);
	const statusEnabledPerLoad: boolean[] = [];
	const refusing = (): never => {
		throw new Error("capture: no terminal provider");
	};
	// Composed once per owner; every terminal operation refuses.
	const provider = () => ({
		name: "capture",
		isAvailable: () => false,
		setupHint: () => "capture: no terminal provider",
		...Object.fromEntries(
			[
				"createSurface",
				"runCommand",
				"readScreen",
				"closeSurface",
				"listSurfaces",
				"attachSurface",
				"createWorktreeSurface",
				"removeWorktreeSurface",
				"reportOpenedPrimaryWorkspace",
				"runScript",
				"inspectSurface",
				"sendKeys",
				"getProcessInfo",
				"waitForShellReady",
				"waitForSurfaceAbsence",
				"listWorktreeSurfaces",
				"focusWorkspace",
				"setTitle",
			].map((name) => [name, refusing]),
		),
	});
	const hostSurface = {
		resolve: () => ({ backend: "legacy" }),
		createProvider: provider,
		createLaunchProvider: provider,
	};
	const presentation = {
		createWidgets(deps: { statusConfig: { enabled: boolean } }) {
			statusEnabledPerLoad.push(deps.statusConfig.enabled);
			return {
				renderSubagentWidgetLines: () => [],
				updateWidget() {},
				startStatusRefresh() {},
				startWidgetRefresh() {},
				stopRefresh() {},
			};
		},
		borderLine: () => "",
		registerMessageRenderers(pi: {
			registerMessageRenderer(name: string, render: () => undefined): void;
		}) {
			pi.registerMessageRenderer("host-renderer", () => undefined);
		},
		toolRenderers: {
			subagent: { renderCall: refusing, renderResult: refusing },
		},
	};
	const load = async (env: Record<string, string>) => {
		Object.assign(process.env, env);
		const extension = createPiExtension({ hostSurface, presentation });
		const tools: Registered[] = [];
		const commands: Registered[] = [];
		const renderers: string[] = [];
		const handlers = new Map<string, Handler[]>();
		extension({
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: Registered) {
				tools.push({
					name: tool.name,
					description: tool.description,
					// Keeps the JSON-visible schema; TypeBox's symbol-keyed metadata is not compared.
					parameters: structuredClone(tool.parameters),
					renderCall: tool.renderCall !== undefined,
					renderResult: tool.renderResult !== undefined,
				});
			},
			registerCommand(name: string, command: { description?: string }) {
				commands.push({ name, description: command.description });
			},
			registerMessageRenderer(name: string) {
				renderers.push(name);
			},
			registerShortcut() {
				throw new Error("capture: unexpected shortcut");
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
			events: { on: () => () => {}, emit() {} },
		});
		for (const handler of handlers.get("session_shutdown") ?? [])
			await handler({ reason: "quit" }, { ui: { setWidget() {} } });
		for (const name of Object.keys(env)) delete process.env[name];
		return {
			testSurface: Object.keys(extension.__test__).sort(),
			tools,
			commands,
			renderers,
			events: [...handlers].map(
				([event, list]): [string, number] => [event, list.length],
			),
		};
	};
	const parent = await load({});
	const child = await load({
		PI_SUBAGENT_ID: "pin-child",
		PI_DENY_TOOLS: "subagent,subagent_resume",
	});
	// Each load reads configuration afresh (per-load factory, not module state).
	const configDir = join(agentDir, "herdr-agents");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ status: { enabled: false } }),
	);
	createPiExtension({ hostSurface, presentation });
	const example: string = getSubagentsConfigExamplePath();
	return {
		example: {
			path: example,
			text: existsSync(example) ? readFileSync(example, "utf8") : "",
		},
		statusEnabledPerLoad,
		scopes: { parent, child },
	};
}

if (process.argv[2] && process.argv[3] && process.argv[4]) {
	const capture = await capturePiFactory(
		process.argv[2],
		process.argv[3],
		process.argv[4],
	);
	process.stdout.write(JSON.stringify(capture) + "\n", () => process.exit(0));
} else if (process.argv[1] === fileURLToPath(import.meta.url))
	throw new Error(
		"Usage: capture-pi-factory <pi facade> <config-path module> <agent dir>",
	);
