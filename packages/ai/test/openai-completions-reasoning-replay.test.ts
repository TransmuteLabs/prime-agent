import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "deferredToolsMode" | "thinkingTokenBudgetField"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

function buildModel(): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(content: AssistantMessage["content"]): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "repro-provider",
				model: "repro-model",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 2,
			} satisfies AssistantMessage,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions reasoning replay", () => {
	it("replays thinking into the field recorded by thinkingSignature", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.content).toBe("answer");
		expect(assistant.reasoning).toBe("step by step");
	});

	// Replay targets the field the provider itself used, recorded as the signature; a block with
	// no signature names no field, so none is invented. Cross-model thinking never reaches here
	// unsigned - transform-messages converts it to text before the provider sees it.
	it("invents no reasoning field for unsigned thinking", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning).toBeUndefined();
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe("answer");
	});

	// A provider that rejects a missing reasoning_content gets an empty one rather than thinking
	// text attributed to a field it never produced.
	it("sends an empty reasoning_content when the provider requires the field", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBe("");
		expect(assistant.content).toBe("answer");
	});

	it("keeps signed thinking in its own field and still satisfies a required reasoning_content", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning).toBe("step by step");
		expect(assistant.reasoning_content).toBe("");
	});

	it("sanitizes unpaired surrogates in replayed reasoning", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "before\ud800after" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content as string).not.toContain("\ud800");
	});

	it("replays signed thinking alongside a tool call", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "deciding to call a tool", thinkingSignature: "reasoning" },
				{ type: "toolCall", id: "call-1", name: "search", arguments: { q: "x" } },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning).toBe("deciding to call a tool");
		expect(Array.isArray(assistant.tool_calls)).toBe(true);
	});
});
