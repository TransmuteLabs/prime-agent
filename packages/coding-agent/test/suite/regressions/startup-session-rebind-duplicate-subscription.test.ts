import { describe, expect, it, vi } from "vitest";
import type { SessionActionSnapshot } from "../../../src/core/session-action-store.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const EMPTY_SESSION_ACTIONS: SessionActionSnapshot = { queuedCount: 0, steering: [], followUps: [] };

type RebindContext = {
	sessionEventGeneration: number;
	unsubscribe?: () => void;
	bindLocalSessionExtensions: boolean;
	toolDefinitionCache: { clear: () => void };
	applyRuntimeSettings: () => void;
	renderSessionStateNow: () => Promise<void>;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	agentConnection: { getState: () => Promise<{ sessionActions: SessionActionSnapshot }> };
	patchConnectionState: (patch: { sessionActions: SessionActionSnapshot }) => void;
	refreshQueueSelectionFromState: () => void;
	updatePendingMessagesDisplay: () => void;
	refreshHeartbeatCatalog: () => Promise<void>;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
	setGoalAnnouncementBaseline: (state: unknown) => void;
	getGoalState: () => unknown;
	syncGoalTray: (state: unknown) => void;
	syncWorkingLoader: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

/** Let the pending microtasks of a rebind run without resolving its bind barrier. */
async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
	}
}

describe("overlapping startup and replacement session rebinds", () => {
	it("does not subscribe from the stale startup rebind", async () => {
		let resolveStartupBind!: () => void;
		let resolveReplacementBind!: () => void;

		const startupBind = new Promise<void>((resolve) => {
			resolveStartupBind = resolve;
		});
		const replacementBind = new Promise<void>((resolve) => {
			resolveReplacementBind = resolve;
		});

		const subscribeToAgent = vi.fn();
		const updateTerminalTitle = vi.fn();
		let bindCount = 0;

		const context: RebindContext = {
			sessionEventGeneration: 0,
			bindLocalSessionExtensions: true,
			toolDefinitionCache: { clear: () => {} },
			applyRuntimeSettings: () => {},
			renderSessionStateNow: async () => {},
			bindCurrentSessionExtensions: () => {
				bindCount += 1;
				return bindCount === 1 ? startupBind : replacementBind;
			},
			subscribeToAgent,
			agentConnection: { getState: async () => ({ sessionActions: EMPTY_SESSION_ACTIONS }) },
			patchConnectionState: () => {},
			refreshQueueSelectionFromState: () => {},
			updatePendingMessagesDisplay: () => {},
			refreshHeartbeatCatalog: async () => {},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor: () => {},
			updateTerminalTitle,
			setGoalAnnouncementBaseline: () => {},
			getGoalState: () => undefined,
			syncGoalTray: () => {},
			syncWorkingLoader: () => {},
		};

		const startupRebind = interactiveModePrototype.rebindCurrentSession.call(context);
		expect(bindCount).toBe(1);

		// A replacement session advances the generation before it rebinds.
		context.sessionEventGeneration += 1;
		const replacementRebind = interactiveModePrototype.rebindCurrentSession.call(context, {
			renderBeforeBind: true,
		});
		// The replacement renders before it binds, so its bind starts one microtask turn later.
		await flush();

		expect(bindCount).toBe(2);
		expect(subscribeToAgent).toHaveBeenCalledTimes(1);

		resolveStartupBind();
		await startupRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).not.toHaveBeenCalled();

		resolveReplacementBind();
		await replacementRebind;

		expect(subscribeToAgent).toHaveBeenCalledTimes(1);
		expect(updateTerminalTitle).toHaveBeenCalledTimes(1);
	});
});
