import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const USAGE: Usage = {
	input: 10,
	output: 20,
	cacheRead: 30,
	cacheWrite: 40,
	totalTokens: 100,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
};

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: unknown,
	event: Record<string, unknown>,
) => Promise<void>;

const startCompactionLoader = Reflect.get(InteractiveMode.prototype, "startCompactionLoader") as (
	this: unknown,
	reason: string,
	customInstructions?: string,
) => void;

const reserveIdleStatusLine = Reflect.get(InteractiveMode.prototype, "reserveIdleStatusLine") as (
	this: unknown,
) => void;

/** The summary path reaches the notice helpers through `this`, so both travel with the fake. */
function createSummaryRenderThis(showCostNotices: boolean) {
	return {
		chatContainer: new Container(),
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => undefined,
		settingsManager: { getShowCacheMissNotices: () => showCostNotices },
		addSummaryCostNotice: Reflect.get(InteractiveMode.prototype, "addSummaryCostNotice"),
		addCompactionCostNotice: Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice"),
	};
}

function createFakeThis(overrides: Record<string, unknown> = {}) {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: new AgentActivityTracker(),
		updateWorkingLoaderMessage: vi.fn(),
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		startCompactionLoader(this: Record<string, unknown>, reason: string, customInstructions?: string) {
			startCompactionLoader.call(this, reason, customInstructions);
		},
		reserveIdleStatusLine(this: Record<string, unknown>) {
			reserveIdleStatusLine.call(this);
		},
		workingVisible: true,
		stopWorkingLoader: vi.fn(),
		syncWorkingLoader: vi.fn(),
		defaultEditor: {},
		options: { tuiMode: "normal" },
		idleStatus: { render: () => [""], invalidate: () => {} },
		statusContainer: new Container(),
		chatContainer: { clear: vi.fn() },
		rebuildChatFromMessages: vi.fn(function (this: { chatContainer: { clear(): void } }) {
			this.chatContainer.clear();
			return Promise.resolve();
		}),
		addMessageToChat: vi.fn(),
		refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), getClearOnShrink: () => false, terminal: { setProgress: vi.fn() } },
		...overrides,
	};
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage: USAGE });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage: USAGE,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage: USAGE });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	// A summary rebuilt from history is the only carrier of its own billing figure,
	// so the cost notice has to come off the message rather than off the live event.
	test("prices a summary rebuilt from session history", () => {
		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: unknown,
			message: unknown,
		) => void;
		const fakeThis = createSummaryRenderThis(true);

		addMessageToChat.call(
			fakeThis,
			createCompactionSummaryMessage("summary", 123, "2025-01-02T00:00:00Z", undefined, undefined, USAGE),
		);

		const output = stripAnsi(fakeThis.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compacted from 123 tokens");
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
	});

	test("omits the cost line for a summary that carries no usage", () => {
		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: unknown,
			message: unknown,
		) => void;
		const fakeThis = createSummaryRenderThis(true);

		addMessageToChat.call(fakeThis, createCompactionSummaryMessage("summary", 123, "2025-01-02T00:00:00Z"));

		const output = stripAnsi(fakeThis.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compacted from 123 tokens");
		expect(output).not.toContain("tokens billed");
	});

	test("shows an automatic compaction loader for the full operation", async () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({ statusContainer });

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "threshold" });

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Auto-compacting");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		expect(statusContainer.children).toHaveLength(0);
	});

	test.each([
		{ name: "rebuilds successful compaction from its single persisted summary", refresh: "succeeds" },
		{ name: "keeps stale chat and reports a failed post-compaction refresh", refresh: "fails" },
	] as const)("$name", async ({ refresh }) => {
		const fakeThis = createFakeThis(
			refresh === "fails"
				? { rebuildChatFromMessages: vi.fn().mockRejectedValue(new Error("context unavailable")) }
				: {},
		);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "requested",
			result: { tokensBefore: 123, summary: "summary", usage: USAGE },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(refresh === "succeeds" ? 1 : 0);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		if (refresh === "fails") {
			expect(fakeThis.showError).toHaveBeenCalledWith(
				"Compaction succeeded, but the transcript could not be refreshed: context unavailable",
			);
		} else {
			expect(fakeThis.showError).not.toHaveBeenCalled();
		}
	});

	test("restarts the working loader when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			updateWorkingLoaderMessage: vi.fn(),
			workingVisible: true,
			loadingAnimation: undefined as unknown,
			startWorkingLoader: vi.fn(function (this: { loadingAnimation: unknown }) {
				this.loadingAnimation = {};
			}),
			stopWorkingLoader: vi.fn(function (this: { loadingAnimation: unknown }) {
				this.loadingAnimation = undefined;
			}),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.startWorkingLoader).toHaveBeenCalledTimes(1);
		expect(fakeThis.stopWorkingLoader).not.toHaveBeenCalled();

		// A second turn of the same run must not restart the loader and reset its elapsed time.
		await handleEvent.call(fakeThis, { type: "turn_start" });
		expect(fakeThis.startWorkingLoader).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.startWorkingLoader).toHaveBeenCalledTimes(1);
		expect(fakeThis.stopWorkingLoader).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(3);
	});

	test("shows manual warning-severity outcomes as warnings, not errors", async () => {
		const fakeThis = createFakeThis();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Session is too short to compact",
			errorSeverity: "warning",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith("Session is too short to compact");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("restores the compaction loader from state when no start event was seen", () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({
			statusContainer,
			connectionState: { isCompacting: true },
			isAgentCompacting() {
				return true;
			},
			loadingAnimation: undefined,
			workingVisible: true,
			isAgentStreaming: () => false,
			stopWorkingLoader: vi.fn(),
			startWorkingLoader: vi.fn(),
		});

		(Reflect.get(InteractiveMode.prototype, "syncWorkingLoader") as (this: unknown) => void).call(fakeThis);

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Compacting context");
	});
});
