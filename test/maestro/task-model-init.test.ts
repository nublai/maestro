import "../clean-host-env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectApprovalOffers,
	openApprovalOffer,
	selectApprovalRoute,
} from "../../maestro/core/config/task-model-init.ts";

function ready(toolName: string, instructions: string, cancel = () => {}) {
	return { kind: "ready", destination: { toolName, instructions }, cancel };
}

describe("approval offer collection and selection", () => {
	it("routes zero offers to the writer, one to its owner, and anything else nowhere", () => {
		const offer = (owner: string) => ({ owner, open: () => undefined });
		const route = (...raws: unknown[]) =>
			selectApprovalRoute(
				collectApprovalOffers((accept) => {
					for (const raw of raws) accept(raw);
				}),
			);
		assert.deepEqual(route(), { kind: "direct" });
		const one = route(offer("only"));
		assert.equal(one.kind, "offer");
		assert.equal(one.kind === "offer" && one.offer.owner, "only");
		assert.deepEqual(route(offer("b"), offer("a")), {
			kind: "refused",
			reason:
				"more than one extension offered to approve task-model writes (a, b); keep one loaded",
		});
		const malformed: Array<[unknown, string]> = [
			[undefined, "an empty offer"],
			[{ owner: "two words", open: () => {} }, "an offer without a printable"],
			[{ owner: "", open: () => {} }, "an offer without a printable"],
			[{ owner: "p" }, "p offered no open function"],
			[{ owner: "p", open: "not callable" }, "p offered no open function"],
		];
		for (const [raw, expected] of malformed) {
			const result = route(offer("valid"), raw);
			assert.equal(result.kind, "refused", JSON.stringify(raw));
			assert.match(
				result.kind === "refused" ? result.reason : "",
				new RegExp(`^an approval listener answered with ${expected}`),
			);
		}
	});

	it("records offers only while emit runs and invokes none of them", () => {
		let late: ((offer: any) => string) | undefined;
		let opened = 0;
		const collected = collectApprovalOffers((accept) => {
			late = accept;
			accept({
				owner: "p",
				open: () => {
					opened += 1;
				},
			});
		});
		assert.equal(collected.offers.length, 1);
		assert.equal(opened, 0, "collection never opens an offer");
		assert.equal(late?.({ owner: "q", open: () => {} }), "closed");
		assert.equal(collected.offers.length, 1, "a late offer is ignored");
		assert.equal(collected.problems.length, 0);
	});

	it("opens a ready offer and copies its destination", () => {
		const raw = {
			owner: "p",
			open: () => ready("tool_1", "  Use tool_1.  "),
		};
		const [offer] = collectApprovalOffers((accept) => {
			accept(raw);
		}).offers;
		raw.open = () => ready("other", "swapped");
		const opened = openApprovalOffer(offer);
		assert.equal(opened.kind, "ready");
		assert.deepEqual(opened.kind === "ready" && opened.destination, {
			toolName: "tool_1",
			instructions: "Use tool_1.",
		});
	});
});
