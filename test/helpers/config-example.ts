import { fileURLToPath } from "node:url";

/** Test-only asset lookup; no production config discovery or module initialization. */
export function getSubagentsConfigExamplePath(): string {
	return fileURLToPath(new URL("../../config.json.example", import.meta.url));
}
