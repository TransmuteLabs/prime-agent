import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

/** The warning reads stored credentials through the registry facade, not a session runtime. */
function createModelRegistry(credential: { type: "oauth" } | undefined, apiKey?: string) {
	return {
		authStorage: { get: vi.fn().mockReturnValue(credential) },
		getApiKeyForProvider: vi.fn().mockResolvedValue(apiKey),
	};
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const modelRegistry = createModelRegistry(undefined, "sk-ant-oat01-test");
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry,
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});
		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(modelRegistry.getApiKeyForProvider).toHaveBeenCalledTimes(1);
	});

	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const modelRegistry = createModelRegistry({ type: "oauth" });
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry,
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const modelRegistry = createModelRegistry(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			modelRegistry,
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "openai",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const modelRegistry = createModelRegistry(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			modelRegistry,
			showWarning: vi.fn(),
		};

		await (InteractiveMode as any).prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(fakeThis, {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRegistry.authStorage.get).not.toHaveBeenCalled();
		expect(modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
	});
});
