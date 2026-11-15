import { readManifest } from "./check-copy-fidelity.ts";

// Actual tool/docs/schema checks arrive with the contract in M4, not in M1.
const manifest = readManifest(
	new URL("../provenance/copy-manifest.json", import.meta.url),
);
if (
	manifest.entries.some((entry) =>
		entry.destination.startsWith("pi-extension/"),
	)
) {
	throw new Error(
		"Install the actual-factory tool docs gate before extracting tools",
	);
}
console.log(
	"No tools extracted: actual-factory docs/schema checks pending M4.",
);
