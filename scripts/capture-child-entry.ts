import { pathToFileURL } from "node:url";

/**
 * Load a child extension entry (source TS or installed JS) and print the tools
 * and handlers it registers through a capture-only API. Used by test:package to
 * compare the emitted protocol-only child with its source; it never runs a tool.
 */
export interface ChildRegistration {
	tools: {
		name: string;
		label: string;
		description: string;
		parameters: object;
	}[];
	events: string[];
}

export async function captureChildEntry(
	entry: string,
): Promise<ChildRegistration> {
	const module = await import(pathToFileURL(entry).href);
	const registration: ChildRegistration = { tools: [], events: [] };
	module.default({
		on(event: string) {
			registration.events.push(event);
		},
		registerTool(tool: ChildRegistration["tools"][number]) {
			registration.tools.push({
				name: tool.name,
				label: tool.label,
				description: tool.description,
				// Keeps the JSON-visible schema; TypeBox's symbol-keyed metadata is not compared.
				parameters: structuredClone(tool.parameters),
			});
		},
		getAllTools: () => [],
		sendUserMessage() {},
		events: { on() {}, emit() {} },
	});
	return registration;
}

if (process.argv[2]) {
	// A persistent child arms an inbox poller at load; exit once the capture is printed.
	process.stdout.write(
		JSON.stringify(await captureChildEntry(process.argv[2])) + "\n",
		() => process.exit(0),
	);
}
