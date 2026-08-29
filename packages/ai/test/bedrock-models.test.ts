import { describe, expect, it } from "vitest";
import { complete, getModels } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

describe("Amazon Bedrock Models", () => {
	const models = getModels("amazon-bedrock");

	it("should get all available Bedrock models", () => {
		expect(models.length).toBeGreaterThan(0);
		console.log(`Found ${models.length} Bedrock models`);
	});

	it("exposes Claude Opus 5 through an inference profile only", () => {
		expect(models.some((model) => model.id === "global.anthropic.claude-opus-5")).toBe(true);
		expect(models.some((model) => model.id === "anthropic.claude-opus-5")).toBe(false);
	});

	if (hasBedrockCredentials() && process.env.BEDROCK_EXTENSIVE_MODEL_TEST) {
		for (const model of models) {
			it(`should make a simple request with ${model.id}`, { timeout: 10_000 }, async () => {
				const context: Context = {
					systemPrompt: "You are a helpful assistant. Be extremely concise.",
					messages: [
						{
							role: "user",
							content: "Reply with exactly: 'OK'",
							timestamp: Date.now(),
						},
					],
				};

				const response = await complete(model, context);

				expect(response.role).toBe("assistant");
				expect(response.content).toBeTruthy();
				expect(response.content.length).toBeGreaterThan(0);
				expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
				expect(response.usage.output).toBeGreaterThan(0);
				expect(response.errorMessage).toBeFalsy();

				const textContent = response.content
					.filter((b) => b.type === "text")
					.map((b) => (b.type === "text" ? b.text : ""))
					.join("")
					.trim();
				expect(textContent).toBeTruthy();
				console.log(`${model.id}: ${textContent.substring(0, 100)}`);
			});
		}
	}
});
