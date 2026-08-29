/**
 * Steering is delivered into the run it was aimed at through the agent's own steering queue, so a
 * message queued mid-run rides that run instead of stopping it and starting a second one. What the
 * loop has not started yet still belongs to the session: an abort takes it back.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

type SteeringInternals = {
	_deliverQueuedSteeringIntoActiveRun: () => Promise<void>;
};

/** Tool that parks the run between turns, which is where a steer arrives in practice. */
function gatedTool(gate: Promise<void>): AgentTool {
	return {
		name: "park",
		label: "park",
		description: "parks the run",
		parameters: Type.Object({}),
		execute: async () => {
			await gate;
			return { content: [{ type: "text" as const, text: "parked" }], details: {} };
		},
	};
}

describe("steering delivery into an active run", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers a steer queued mid-run into that same run", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({ tools: [gatedTool(gate)] });
		harnesses.push(harness);
		let steeredRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("park", {}), { stopReason: "toolUse" }),
			(context) => {
				steeredRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after steering");
			},
		]);

		const promptPromise = harness.session.prompt("run the tool");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		const steerPromise = harness.session.steer("change direction");
		release();
		await promptPromise;
		await steerPromise;

		expect(steeredRequest).toContain("change direction");
		expect(getUserTexts(harness)).toEqual(["run the tool", "change direction"]);
		// A second agent_start would mean the run was stopped and restarted for the steer.
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns a handed-over steer to the queue when an abort beats the loop to it", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({ tools: [gatedTool(gate)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("park", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unreachable"),
		]);

		const promptPromise = harness.session.prompt("run the tool");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		void harness.session.steer("change direction").catch(() => undefined);
		await vi.waitFor(() => expect(harness.session.getSteeringMessages()).toContain("change direction"));

		// Hand it over exactly as the turn boundary does, then abort before the loop can poll it.
		await (harness.session as unknown as SteeringInternals)._deliverQueuedSteeringIntoActiveRun();
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		harness.session.requestAbort();
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getSteeringMessages()).toContain("change direction");
		expect(harness.session.queuedActionCount).toBe(1);

		release();
		await harness.session.abort();
		await promptPromise.catch(() => undefined);
	});
});
