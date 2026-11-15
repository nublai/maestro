import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";

/** Archive structured identities and raw per-file coverage, not application output. */
export default async function* baselineReporter(
	events: AsyncIterable<TestEvent>,
) {
	for await (const event of events) {
		if (event.type === "test:pass" || event.type === "test:fail") {
			const data = event.data;
			yield `${JSON.stringify({ type: event.type, name: data.name, nesting: data.nesting, testId: data.testId, parentId: data.parentId, kind: data.details.type, file: data.file ? relative(process.cwd(), data.file) : null, line: data.line, column: data.column, skip: data.skip ?? false, todo: data.todo ?? false })}\n`;
		}
		if (event.type === "test:coverage") {
			yield `${JSON.stringify({ type: event.type, files: event.data.summary.files.map((file) => ({ ...file, path: relative(process.cwd(), file.path) })), totals: event.data.summary.totals })}\n`;
		}
		if (event.type === "test:summary") {
			yield `${JSON.stringify({ type: event.type, data: event.data })}\n`;
		}
	}
}
