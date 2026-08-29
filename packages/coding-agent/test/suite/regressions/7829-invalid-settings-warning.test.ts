import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../../src/core/agent-session-services.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

describe("issue #7829 invalid settings warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders startup diagnostics inside the transcript", async () => {
		const harness = await createHarness();
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
				{
					type: "warning",
					message: "Invalid settings file /tmp/settings.json: malformed JSON",
				},
			];
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				showError: (InteractiveMode.prototype as unknown as { showError(message: string): void }).showError,
				showStatus: (InteractiveMode.prototype as unknown as { showStatus(message: string): void }).showStatus,
				restorePromptStashOnOpen: vi.fn(),
				runStartupOnboarding: vi.fn(async () => {}),
				getModelFallbackWarningAction: vi.fn(() => "suppress"),
				getCurrentModel: vi.fn(() => undefined),
				getCurrentCwd: vi.fn(() => process.cwd()),
				settingsManager: harness.settingsManager,
				modelRegistry: { getError: () => undefined },
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				// Warnings carry the fork's glyph prefix, not pi's "Warning: " label.
				expect(render(chatContainer)).toContain("⚠ Invalid settings file /tmp/settings.json: malformed JSON");
			});
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			harness.cleanup();
		}
	});
});
