import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persists the aborted response before running the requested manual compaction", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage(`second response:${"x".repeat(4000)}`);
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({ summary: "manual summary" });
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		// Threshold compaction stops the agent loop at the turn boundary here (reserveTokens 999
		// of a 1000-token window), so it runs before the manual request exists. The manual
		// compaction must still run exactly once, on its own, and must not fail.
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "manual")).toHaveLength(1);
		const manualEnds = harness.eventsOfType("compaction_end").filter((event) => event.reason === "manual");
		expect(manualEnds).toHaveLength(1);
		expect(manualEnds[0]).toMatchObject({ aborted: false, willRetry: false });
		expect(manualEnds[0].errorMessage).toBeUndefined();
		expect(harness.sessionManager.getEntries().at(-1)?.type).toBe("compaction");
	});
});
