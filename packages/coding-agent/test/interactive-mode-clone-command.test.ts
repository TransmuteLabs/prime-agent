import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CloneCommandContext = {
	// The leaf and the fork both come from the connection: /clone works the same
	// against a daemon-hosted session as against a local one.
	agentConnection: {
		getSessionTree: () => Promise<{ leafId: string | null }>;
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
	renderCurrentSessionState: () => Promise<void>;
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn(async () => {});
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context: CloneCommandContext = {
			agentConnection: { getSessionTree: async () => ({ leafId: "leaf-123" }), fork },
			renderCurrentSessionState,
			editor: { setText },
			showStatus,
			showError,
			ui: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(renderCurrentSessionState).toHaveBeenCalledOnce();
		expect(setText).toHaveBeenCalledWith("");
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			agentConnection: { getSessionTree: async () => ({ leafId: null }), fork },
			renderCurrentSessionState: vi.fn(async () => {}),
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(showError).not.toHaveBeenCalled();
	});
});
