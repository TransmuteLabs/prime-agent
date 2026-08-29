import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type PrimeApiKeyCredential } from "../../../src/core/auth-storage.ts";
import { findInitialModel } from "../../../src/core/model-resolver.ts";
import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { allowNetwork } from "../../test-network-env.ts";

const PRIVATE_MODEL_ID = "internal/glm-5.2-fast";

function teamCredential(teamId: string, name: string): PrimeApiKeyCredential {
	return { type: "api_key", key: "prime-key", primeTeam: { teamId, name } };
}

function teamAuthStorage(teamId: string, name: string): AuthStorage {
	return AuthStorage.inMemory({ "prime-inference": teamCredential(teamId, name) });
}

function catalogResponse(ids: string[]): Response {
	return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

describe("ENG-4645 internal GLM configuration", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		// The Prime Inference catalog request is served by a local mock.
		allowNetwork();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	test("shows the private route when the selected team's catalog authorizes it", async () => {
		const fetchMock = vi.fn(async () => catalogResponse([PRIVATE_MODEL_ID]));
		vi.stubGlobal("fetch", fetchMock);
		const registry = await createInMemoryModelRegistry(teamAuthStorage("engineering-team", "Prime Engineering"));

		const models = await registry.refreshAvailableModels();

		expect(models.find((candidate) => candidate.id === PRIVATE_MODEL_ID)).toMatchObject({
			name: "GLM 5.2 Fast",
			api: "openai-completions",
			provider: "prime-inference",
			baseUrl: "https://api.pinference.ai/api/v1",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 131072,
		});
		expect(fetchMock).toHaveBeenCalledWith("https://api.pinference.ai/api/v1/models", {
			headers: {
				Authorization: "Bearer prime-key",
				"X-Prime-Team-ID": "engineering-team",
			},
			signal: expect.any(AbortSignal),
		});
	});

	test("hides the private route when the selected team's catalog omits it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([])),
		);
		const registry = await createInMemoryModelRegistry(teamAuthStorage("other-team", "Other Team"));

		const models = await registry.refreshAvailableModels();

		expect(models.some((model) => model.id === PRIVATE_MODEL_ID)).toBe(false);
		// The model stays in the full catalog; only the offered set is narrowed.
		expect(registry.getAll().some((model) => model.id === PRIVATE_MODEL_ID)).toBe(true);
	});

	test("hides the private route when no team is selected", async () => {
		const requestedUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				requestedUrls.push(String(input));
				return catalogResponse([PRIVATE_MODEL_ID]);
			}),
		);
		const registry = await createInMemoryModelRegistry(
			AuthStorage.inMemory({ "prime-inference": { type: "api_key", key: "prime-key" } }),
		);

		const models = await registry.refreshAvailableModels();

		expect(models.some((model) => model.id === PRIVATE_MODEL_ID)).toBe(false);
		// Without a team there is nothing to authorize against, so the catalog is never asked.
		expect(requestedUrls.some((url) => url.endsWith("/api/v1/models"))).toBe(false);
	});

	test("preserves authorization on transient failures only for the same team", async () => {
		let catalogAvailable = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				catalogAvailable ? catalogResponse([PRIVATE_MODEL_ID]) : new Response(null, { status: 503 }),
			),
		);
		const authStorage = teamAuthStorage("engineering-team", "Prime Engineering");
		const registry = await createInMemoryModelRegistry(authStorage);

		expect((await registry.refreshAvailableModels()).some((model) => model.id === PRIVATE_MODEL_ID)).toBe(true);
		catalogAvailable = false;
		// Past the decision's TTL, so the failing catalog request is actually made.
		vi.setSystemTime(Date.now() + 6 * 60_000);
		expect((await registry.refreshAvailableModels()).some((model) => model.id === PRIVATE_MODEL_ID)).toBe(true);

		authStorage.set("prime-inference", teamCredential("other-team", "Other Team"));

		expect((await registry.refreshAvailableModels()).some((model) => model.id === PRIVATE_MODEL_ID)).toBe(false);
	});

	test("selects an authorized private route from a saved default on cold start", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([PRIVATE_MODEL_ID])),
		);
		const registry = await createInMemoryModelRegistry(teamAuthStorage("engineering-team", "Prime Engineering"));

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "prime-inference",
			defaultModelId: PRIVATE_MODEL_ID,
			modelRuntime: getModelRuntime(registry),
		});

		expect(initial.model?.id).toBe(PRIVATE_MODEL_ID);
	});

	test("does not select a private route the selected team cannot access", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([])),
		);
		const registry = await createInMemoryModelRegistry(teamAuthStorage("other-team", "Other Team"));

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "prime-inference",
			defaultModelId: PRIVATE_MODEL_ID,
			modelRuntime: getModelRuntime(registry),
		});

		expect(initial.model?.id).not.toBe(PRIVATE_MODEL_ID);
	});

	test("offers a private route declared in models.json without a catalog check", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "internal-glm-"));
		tempDirs.push(tempDir);
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"prime-inference": {
						baseUrl: "https://api.pinference.ai/api/v1",
						api: "openai-completions",
						compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
						models: [
							{
								id: PRIVATE_MODEL_ID,
								name: "GLM 5.2 Fast",
								reasoning: true,
								contextWindow: 400000,
								maxTokens: 131072,
							},
						],
					},
				},
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([])),
		);
		const registry = await createModelRegistry(
			teamAuthStorage("engineering-team", "Prime Engineering"),
			modelsJsonPath,
		);

		expect(registry.getError()).toBeUndefined();
		expect(registry.getAvailable().some((model) => model.id === PRIVATE_MODEL_ID)).toBe(true);
		expect(registry.find("prime-inference", PRIVATE_MODEL_ID)?.compat).not.toMatchObject({ thinkingFormat: "zai" });
	});
});
