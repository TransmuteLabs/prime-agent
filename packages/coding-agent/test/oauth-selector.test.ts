import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AuthStatus, AuthStorage } from "../src/core/auth-storage.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function renderSelector(
		providers: { id: string; name: string; authType: "oauth" | "api_key" }[],
		authStorage: AuthStorage = AuthStorage.inMemory(),
		getAuthStatus?: (providerId: string) => AuthStatus,
	): string {
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			providers,
			() => {},
			() => {},
			getAuthStatus,
		);
		return stripAnsi(selector.render(120).join("\n"));
	}

	it("renders an option without auth as unconfigured", () => {
		const output = renderSelector([{ id: "google", name: "Google", authType: "api_key" }]);
		expect(output).toContain("unconfigured");
	});

	it("shows a stored credential as configured", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 });
		const output = renderSelector([{ id: "anthropic", name: "Anthropic", authType: "oauth" }], authStorage);
		expect(output).toContain("configured");
		expect(output).not.toContain("unconfigured");
	});

	it("shows OAuth auth distinctly in the API key selector", () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 });
		const output = renderSelector([{ id: "anthropic", name: "Anthropic", authType: "api_key" }], authStorage);
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const output = renderSelector([{ id: "openai", name: "OpenAI", authType: "api_key" }], undefined, () => ({
			configured: false,
			source: "environment",
			label: "OPENAI_API_KEY",
		}));
		expect(output).toContain("env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows models.json API key auth as configured", () => {
		const output = renderSelector(
			[{ id: "local-proxy", name: "local-proxy", authType: "api_key" }],
			undefined,
			() => ({ configured: true, source: "models_json_key" }),
		);
		expect(output).toContain("key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const output = renderSelector([{ id: "op-proxy", name: "op-proxy", authType: "api_key" }], undefined, () => ({
			configured: true,
			source: "models_json_command",
		}));
		expect(output).toContain("command in models.json");
	});
});
