import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("ENG-4620 fast mode empty resume", () => {
	let harness: Harness | undefined;
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			session.dispose();
		}
		harness?.cleanup();
		harness = undefined;
	});

	it("restores fast mode before the first message", async () => {
		harness = await createHarness({
			provider: "openai-codex",
			models: [{ id: "gpt-5.4" }],
			persistSession: true,
		});
		harness.session.dispose();
		const currentHarness = harness;

		const model: Model<"openai-codex-responses"> = {
			...currentHarness.getModel(),
			api: "openai-codex-responses",
		};
		const createSession = () =>
			createAgentSession({
				cwd: currentHarness.tempDir,
				modelRuntime: currentHarness.modelRuntime,
				model,
				resourceLoader: createTestResourceLoader(),
				sessionManager: currentHarness.sessionManager,
				settingsManager: currentHarness.settingsManager,
			});

		const { session } = await createSession();
		sessions.push(session);
		session.setServiceTier("priority");
		expect(session.messages).toHaveLength(0);
		session.dispose();

		const { session: resumedSession } = await createSession();
		sessions.push(resumedSession);

		expect(resumedSession.serviceTier).toBe("priority");
		expect(resumedSession.sessionManager.buildSessionContext().serviceTier).toBe("priority");
	});
});
