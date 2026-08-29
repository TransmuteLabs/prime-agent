import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const DOWN = "\x1b[B";
const ENTER = "\r";

describe("model selector filter resets selection to top", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves selection to the first row in the All tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		let selectedModelId: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			(model) => {
				selectedModelId = model.id;
			},
			() => {},
			undefined,
			{ availableModels: harness.models },
		);

		// Move selection down two rows.
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);

		// Type a query that matches the three alpha models. The selection must
		// move back to the top row, not stay clamped at index 2.
		for (const char of "alpha") {
			selector.handleInput(char);
		}
		selector.handleInput(ENTER);

		expect(selectedModelId).toBe("alpha-1");
		// Sanity: the filter actually narrowed the list.
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).not.toContain("beta-1");
	});

	it("moves selection to the first row in the Scoped tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha1 = harness.getModel("alpha-1")!;
		const alpha2 = harness.getModel("alpha-2")!;
		const alpha3 = harness.getModel("alpha-3")!;

		// Scoped list is intentionally not in current-model-first order; the
		// current model (alpha-1) sits at index 2.
		let selectedModelId: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha1,
			harness.session.modelRuntime,
			[{ model: alpha2 }, { model: alpha3 }, { model: alpha1 }],
			(model) => {
				selectedModelId = model.id;
			},
			() => {},
			undefined,
			{ availableModels: harness.models },
		);

		// Type a query matching all three scoped models. Selection must move to
		// the top row, which ranking puts at the current model (alpha-1); staying
		// clamped at index 2 would select alpha-3 instead.
		for (const char of "alpha") {
			selector.handleInput(char);
		}
		selector.handleInput(ENTER);

		expect(selectedModelId).toBe("alpha-1");
	});
});
