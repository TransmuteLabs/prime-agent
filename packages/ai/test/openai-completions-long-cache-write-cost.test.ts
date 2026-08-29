import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	usage: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: mockState.usage };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function anthropicRoutedModel(): Model<"openai-completions"> {
	return {
		id: "anthropic/claude-test",
		name: "Claude Test",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		// 1.25x input is the 5m write rate the catalog publishes; a 1h write bills 2x input.
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 4096,
		compat: { cacheControlFormat: "anthropic", supportsLongCacheRetention: true },
	};
}

async function runWithCacheRetention(cacheRetention: "short" | "long") {
	const s = streamOpenAICompletions(anthropicRoutedModel(), context, {
		apiKey: "test",
		cacheRetention,
	});
	return await s.result();
}

describe("openai-completions cache write pricing", () => {
	beforeEach(() => {
		mockState.usage = {
			prompt_tokens: 1_100,
			completion_tokens: 0,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_000 },
		};
	});

	it("bills a 1h cache write at twice the input rate", async () => {
		const result = await runWithCacheRetention("long");

		expect(result.usage.cacheWrite).toBe(1_000);
		expect(result.usage.cacheWrite1h).toBe(1_000);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((3 * 2 * 1_000) / 1_000_000, 12);
	});

	it("bills a 5m cache write at the catalog write rate", async () => {
		const result = await runWithCacheRetention("short");

		expect(result.usage.cacheWrite).toBe(1_000);
		expect(result.usage.cacheWrite1h).toBeUndefined();
		expect(result.usage.cost.cacheWrite).toBeCloseTo((3.75 * 1_000) / 1_000_000, 12);
	});
});
