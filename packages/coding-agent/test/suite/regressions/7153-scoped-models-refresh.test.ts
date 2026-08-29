import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const showModelsSelector = Reflect.get(InteractiveMode.prototype, "showModelsSelector") as (this: object) => void;

function openSelector(harness: Harness, cachedModels: readonly Model<Api>[]) {
	let resolveRefresh: ((models: readonly Model<Api>[]) => void) | undefined;
	let selector: ScopedModelsSelectorComponent | undefined;
	let dispose: (() => void) | undefined;
	const done = vi.fn();
	const context = {
		getCachedModelCandidates: () => [...cachedModels],
		// The connection refresh has no signal of its own; the selector's dispose is what
		// keeps a late catalog from writing into a closed component.
		getModelSelectorRefreshPromise: vi.fn(
			() =>
				new Promise<readonly Model<Api>[]>((resolve) => {
					resolveRefresh = resolve;
				}),
		),
		getScopedModelState: () => [],
		getScopedModelsFromModelIds: Reflect.get(InteractiveMode.prototype, "getScopedModelsFromModelIds"),
		agentConnection: { setScopedModels: vi.fn() },
		patchConnectionState: vi.fn(),
		settingsManager: harness.settingsManager,
		showError: vi.fn(),
		showStatus: vi.fn(),
		showSelector: (
			factory: (close: () => void) => {
				component: ScopedModelsSelectorComponent;
				dispose?: () => void;
			},
		) => {
			const close = () => {
				dispose?.();
				done();
			};
			const created = factory(close);
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: vi.fn(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
	};

	showModelsSelector.call(context);
	if (!selector) throw new Error("Expected scoped-model selector to open");
	return {
		done,
		selector,
		refreshStarted: () => context.getModelSelectorRefreshPromise.mock.calls.length > 0,
		complete(models: readonly Model<Api>[]) {
			if (!resolveRefresh) throw new Error("Expected model refresh to start");
			resolveRefresh(models);
		},
	};
}

describe("issue #7153 scoped models refresh", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("renders cached models immediately and updates after background refresh", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0]]);

		const initial = stripAnsi(refresh.selector.render(100).join("\n"));
		expect(initial).toContain("cached");
		expect(initial).toContain("Refreshing model catalogs…");
		expect(initial).not.toContain("refreshed");

		refresh.complete(harness.models);
		await vi.waitFor(() => {
			const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
			expect(rendered).toContain("refreshed");
			expect(rendered).toContain("Model catalogs refreshed.");
		});
	});

	it("ignores a background refresh that lands after the selector closes", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const refresh = openSelector(harness, [harness.models[0]]);
		expect(refresh.refreshStarted()).toBe(true);

		refresh.selector.handleInput("\x1b");
		expect(refresh.done).toHaveBeenCalledOnce();

		refresh.complete(harness.models);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rendered = stripAnsi(refresh.selector.render(100).join("\n"));
		expect(rendered).not.toContain("refreshed");
		expect(rendered).toContain("Refreshing model catalogs…");
	});
});
