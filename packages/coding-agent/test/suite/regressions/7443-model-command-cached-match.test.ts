import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const findExactModelMatch = Reflect.get(InteractiveMode.prototype, "findExactModelMatch") as (
	this: object,
	searchTerm: string,
) => Promise<Model<Api> | undefined>;

function createContext(cachedModels: readonly Model<Api>[], refreshedModels: readonly Model<Api>[] | undefined) {
	return {
		getScopedModelState: () => [],
		getCachedModelCandidates: () => [...cachedModels],
		getModelSelectorRefreshPromise: vi.fn((_options?: { force?: boolean }): Promise<Model<Api>[]> | undefined =>
			refreshedModels === undefined ? undefined : Promise.resolve([...refreshedModels]),
		),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	};
}

describe("issue #7443 /model cached match", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("matches the availability snapshot without starting a catalog refresh", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const context = createContext(harness.models, undefined);

		const model = await findExactModelMatch.call(context, harness.models[0].id);

		expect(model?.id).toBe("cached");
		expect(context.getModelSelectorRefreshPromise).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("refreshes the catalog only after a cache miss", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const context = createContext(harness.models, []);

		await expect(findExactModelMatch.call(context, "not-cached")).resolves.toBeUndefined();

		expect(context.getModelSelectorRefreshPromise).toHaveBeenCalledOnce();
		expect(context.getModelSelectorRefreshPromise.mock.calls[0]?.[0]).toEqual({ force: true });
		expect(context.showStatus).toHaveBeenCalledWith("Refreshing model catalogs…");
	});

	it("finds a model that only the refreshed catalog knows", async () => {
		harness = await createHarness({
			models: [
				{ id: "cached", name: "Cached" },
				{ id: "refreshed", name: "Refreshed" },
			],
		});
		const context = createContext([harness.models[0]], harness.models);

		const model = await findExactModelMatch.call(context, "refreshed");

		expect(model?.id).toBe("refreshed");
		expect(context.showStatus).toHaveBeenCalledWith("Refreshing model catalogs…");
	});
});
