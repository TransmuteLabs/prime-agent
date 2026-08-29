import { describe, expect, it } from "vitest";
import {
	getOpenRouterReasoningCapabilities,
	getOpenRouterThinkingLevelMap,
} from "../scripts/openrouter-reasoning-options.ts";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, ModelThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function openRouterModel(thinkingLevelMap?: ThinkingLevelMap): Model<"openai-completions"> {
	return {
		id: "stealth/ox-alpha",
		name: "Ox Alpha",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: { thinkingFormat: "openrouter" },
	};
}

async function capturePayload(model: Model<"openai-completions">, reasoning?: ModelThinkingLevel) {
	let payload: { reasoning?: { effort?: string } } | undefined;
	await streamSimple(model, context, {
		apiKey: "test",
		reasoning,
		onPayload: (request) => {
			payload = request as { reasoning?: { effort?: string } };
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error("OpenRouter payload was not captured");
	return payload;
}

describe("getOpenRouterThinkingLevelMap", () => {
	it("marks mandatory reasoning and unsupported efforts unavailable", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: true,
				default_enabled: true,
				supported_efforts: ["max", "high", "low"],
				default_effort: "max",
			}),
		).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("still marks off unavailable when OpenRouter omits effort metadata", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true })).toEqual({ off: null });
	});

	it("keeps off available while restricting optional models to supported efforts", () => {
		expect(
			getOpenRouterThinkingLevelMap({
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["high", "low"],
			}),
		).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("does not add metadata for optional models without effort controls", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false })).toBeUndefined();
	});
});

function supportedLevels(thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"]) {
	const model = {
		reasoning: true,
		thinkingLevelMap,
	} as Model<"openai-completions">;
	return getSupportedThinkingLevels(model);
}

function catalogEntry(reasoning: Record<string, unknown>, supportsReasoning = true) {
	return {
		supported_parameters: supportsReasoning ? ["tools", "reasoning"] : ["tools"],
		reasoning,
	};
}

describe("getOpenRouterReasoningCapabilities", () => {
	it("exposes exactly the published efforts and hides off for mandatory reasoning", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			catalogEntry({
				mandatory: true,
				supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
			}),
		);

		expect(capabilities).toEqual({
			mandatory: true,
			supportsReasoningEffort: true,
			thinkingLevelMap: {
				off: null,
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		});
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("keeps off and only the advertised sparse efforts for optional reasoning", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			catalogEntry({ mandatory: false, supported_efforts: ["high", "none"] }),
		);

		expect(capabilities?.supportsReasoningEffort).toBe(true);
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["off", "high"]);
	});

	it("treats null efforts as accepting every gateway effort", () => {
		const optional = getOpenRouterReasoningCapabilities(catalogEntry({ mandatory: false, supported_efforts: null }));
		const mandatory = getOpenRouterReasoningCapabilities(catalogEntry({ mandatory: true, supported_efforts: null }));

		expect(optional?.supportsReasoningEffort).toBe(true);
		expect(mandatory?.supportsReasoningEffort).toBe(true);
		expect(supportedLevels(optional?.thinkingLevelMap)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(supportedLevels(mandatory?.thinkingLevelMap)).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("uses a single active toggle when effort selection is not exposed", () => {
		const optional = getOpenRouterReasoningCapabilities(catalogEntry({ mandatory: false }));
		const mandatory = getOpenRouterReasoningCapabilities(catalogEntry({ mandatory: true }));

		expect(optional?.supportsReasoningEffort).toBe(false);
		expect(supportedLevels(optional?.thinkingLevelMap)).toEqual(["off", "high"]);
		expect(supportedLevels(mandatory?.thinkingLevelMap)).toEqual(["high"]);
	});

	it("falls back to an enabled toggle for malformed effort lists", () => {
		const capabilities = getOpenRouterReasoningCapabilities(
			catalogEntry({ mandatory: false, supported_efforts: ["unexpected", 123] }),
		);

		expect(capabilities?.supportsReasoningEffort).toBe(false);
		expect(supportedLevels(capabilities?.thinkingLevelMap)).toEqual(["off", "high"]);
	});

	it("ignores the over-reported reasoning object when the route lacks the reasoning parameter", () => {
		expect(
			getOpenRouterReasoningCapabilities(catalogEntry({ mandatory: true, supported_efforts: ["high"] }, false)),
		).toBeUndefined();
	});
});

describe("OpenRouter mandatory reasoning payloads", () => {
	const mandatoryMap = getOpenRouterThinkingLevelMap({
		mandatory: true,
		supported_efforts: ["max", "high", "low"],
	});

	it("omits reasoning when a background call does not request it", async () => {
		expect(await capturePayload(openRouterModel(mandatoryMap))).not.toHaveProperty("reasoning");
	});

	it("still sends an explicitly selected supported effort", async () => {
		expect(await capturePayload(openRouterModel(mandatoryMap), "low")).toMatchObject({
			reasoning: { effort: "low" },
		});
	});

	it("leaves the provider default alone when no reasoning preference is expressed", async () => {
		expect(await capturePayload(openRouterModel())).not.toHaveProperty("reasoning");
	});

	it("continues to explicitly disable reasoning for optional models", async () => {
		expect(await capturePayload(openRouterModel(), "off")).toMatchObject({
			reasoning: { effort: "none" },
		});
	});
});
