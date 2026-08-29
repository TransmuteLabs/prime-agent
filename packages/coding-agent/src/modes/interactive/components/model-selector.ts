import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyMatch,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import {
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
} from "./menu-panel.ts";
import { shouldTreatAsBack } from "./modal-back.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

const ModelSearchMatchQuality = {
	ExactShortId: 0,
	ExactFullId: 1,
	PrefixOrToken: 2,
	Fuzzy: 3,
} as const;
type ModelSearchMatchQuality = (typeof ModelSearchMatchQuality)[keyof typeof ModelSearchMatchQuality];

interface ModelSearchMatch {
	quality: ModelSearchMatchQuality;
	score: number;
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[\s\-_.:/]+/g, "");
}

function getModelSearchFields(item: ModelItem): { shortId: string; fullIds: string[]; all: string[] } {
	const shortId = item.id.slice(item.id.lastIndexOf("/") + 1);
	const fullIds = [item.id, `${item.provider}/${item.id}`];
	return {
		shortId,
		fullIds,
		all: [shortId, ...fullIds, item.model.name, item.provider],
	};
}

function getBestFuzzyScore(queryTokens: string[], fields: string[]): number | null {
	let total = 0;
	for (const token of queryTokens) {
		let best = Number.POSITIVE_INFINITY;
		for (const field of fields) {
			const match = fuzzyMatch(token, field);
			if (match.matches) best = Math.min(best, match.score);
		}
		if (!Number.isFinite(best)) return null;
		total += best;
	}
	return total;
}

function scoreModelSearch(item: ModelItem, query: string): ModelSearchMatch | null {
	const queryTokens = query.trim().split(/\s+/);
	const normalizedQuery = normalizeModelSearchText(query);
	const normalizedTokens = queryTokens.map(normalizeModelSearchText).filter(Boolean);
	if (!normalizedQuery || normalizedTokens.length === 0) return null;

	const fields = getModelSearchFields(item);
	if (normalizeModelSearchText(fields.shortId) === normalizedQuery) {
		return { quality: ModelSearchMatchQuality.ExactShortId, score: 0 };
	}
	if (fields.fullIds.some((field) => normalizeModelSearchText(field) === normalizedQuery)) {
		return { quality: ModelSearchMatchQuality.ExactFullId, score: 0 };
	}

	const normalizedFields = fields.all.map(normalizeModelSearchText);
	const fieldTokens = fields.all
		.flatMap((field) => field.split(/[\s/_-]+/))
		.map(normalizeModelSearchText)
		.filter(Boolean);
	const fuzzyScore = getBestFuzzyScore(normalizedTokens, normalizedFields);
	const isPrefixOrToken = normalizedTokens.every(
		(token) =>
			normalizedFields.some((field) => field.startsWith(token)) ||
			fieldTokens.some((field) => field.startsWith(token)),
	);
	if (isPrefixOrToken && fuzzyScore !== null) {
		return { quality: ModelSearchMatchQuality.PrefixOrToken, score: fuzzyScore };
	}
	return fuzzyScore === null ? null : { quality: ModelSearchMatchQuality.Fuzzy, score: fuzzyScore };
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

export interface ModelSelectorOptions {
	availableModels?: ReadonlyArray<Model<any>>;
	configuredProviders?: ReadonlySet<string>;
	header?: Component;
	getHeaderRows?: () => number;
	subtitle?: string;
	getRows?: () => number;
	recentModels?: ReadonlyArray<string>;
}

type ModelScope = "all" | "scoped";

const PREFERRED_VISIBLE_MODELS = 10;
const MODEL_LIST_RESERVED_ROWS = {
	base: 7,
	detail: 2,
};
const MODEL_SCROLL_INDICATOR_ROWS = 1;
const MODEL_STATUS_ROWS = 2;
const MODEL_HELP_MIN_ROWS = 12;
const MODEL_DETAIL_MIN_ROWS = 14;
const MODEL_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private searchQuery = "";
	private currentModel?: Model<any>;
	private readonly modelSource: ModelRuntime | ModelRegistry;
	private readonly modelRuntime?: ModelRuntime;
	private readonly modelRegistry?: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private availableModels?: ReadonlyArray<Model<any>>;
	private configuredProviders?: ReadonlySet<string>;
	private recentRank: Map<string, number>;
	private errorMessage?: string;
	private refreshStatusMessage = "";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private defaultHintText?: Text;
	private panel: MenuPanel;
	private headerHelpContainer: Container;
	private warningText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
		reservedRows: MODEL_LIST_RESERVED_ROWS.base,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private responsiveLayoutKey = "";
	private readonly viewport: MenuViewportProvider;
	private readonly getHeaderRows: () => number;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelSource: ModelRuntime | ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		optionsOrOnSelectAsDefault?: ModelSelectorOptions | ((model: Model<any>) => void),
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelSource = modelSource;
		// Discriminated on the runtime because ModelRegistry is the prime-agent layer
		// still being folded into it; anything that is not the runtime is a registry.
		if (modelSource instanceof ModelRuntime) {
			this.modelRuntime = modelSource;
		} else {
			this.modelRegistry = modelSource;
		}
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		const options = typeof optionsOrOnSelectAsDefault === "function" ? {} : (optionsOrOnSelectAsDefault ?? {});
		if (typeof optionsOrOnSelectAsDefault === "function") {
			this.onSelectAsDefaultCallback = optionsOrOnSelectAsDefault;
		}
		this.availableModels = options.availableModels;
		this.configuredProviders = options.configuredProviders;
		this.recentRank = new Map((options.recentModels ?? []).map((key, i) => [key, i]));
		this.viewport = { getRows: options.getRows };
		this.getHeaderRows = options.header ? (options.getHeaderRows ?? (() => 2)) : () => 0;

		this.panel = new MenuPanel({
			title: "Models",
			subtitle: options.subtitle ?? "All models across supported providers.",
		});
		this.addChild(this.panel);
		if (options.header) {
			this.panel.addChild(options.header);
			this.panel.addChild(new Spacer(1));
		}

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		} else {
			const hintText = "Signed-in providers first. Other models prompt sign-in.";
			this.warningText = new Text(theme.fg("muted", hintText), 0, 0);
		}
		if (this.onSelectAsDefaultCallback) {
			this.defaultHintText = new Text(this.getDefaultHintText(), 0, 0);
		}
		this.headerHelpContainer = new Container();
		this.panel.addChild(this.headerHelpContainer);

		// Create search input
		this.searchInput = new MenuSearchInput("Search models");
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			this.handleConfirm();
		};
		this.panel.addChild(this.searchInput);

		this.panel.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		this.panel.addChild(this.listContainer);
		this.updateResponsiveLayout();

		// A catalog error older than this selector still applies to the rows it is about to draw.
		this.errorMessage = this.availableModels === undefined ? this.getSourceError() : undefined;
		this.loadModelsFromSnapshot();
		if (initialSearchInput) {
			this.filterModels(initialSearchInput);
		} else {
			this.updateList();
		}
		this.tui.requestRender();
		void this.refreshModels();
	}

	private getSnapshotModels(): ReadonlyArray<Model<any>> {
		if (this.availableModels !== undefined) return this.availableModels;
		if (this.modelRegistry) return this.modelRegistry.getAvailable();
		return this.modelRuntime!.getAvailableSnapshot();
	}

	private findModel(provider: string, id: string): Model<any> | undefined {
		if (this.modelRegistry) return this.modelRegistry.find(provider, id);
		return this.modelRuntime!.getModel(provider, id);
	}

	private getSourceError(): string | undefined {
		return this.modelRegistry ? this.modelRegistry.getError() : this.modelRuntime!.getError();
	}

	private hasConfiguredAuth(model: Model<any>): boolean {
		return this.modelRegistry
			? this.modelRegistry.hasConfiguredAuth(model)
			: this.modelRuntime!.hasConfiguredAuth(model.provider);
	}

	updateAvailableModels(availableModels: ReadonlyArray<Model<any>>): void {
		this.updateState(this.currentModel, availableModels);
	}

	/**
	 * Re-reads the model catalog (e.g. after a models.json hot reload or an
	 * auth change) and re-filters, preserving the selected model when possible.
	 */
	updateState(
		currentModel: Model<any> | undefined,
		availableModels: ReadonlyArray<Model<any>> | undefined = this.availableModels,
		configuredProviders: ReadonlySet<string> | undefined = this.configuredProviders,
	): void {
		this.currentModel = currentModel;
		this.availableModels = availableModels;
		this.configuredProviders = configuredProviders;
		const query = this.searchInput.getValue();
		const selectedKey = this.getSelectedModelKey();

		this.loadModelsFromSnapshot();
		this.filterModels(query);

		if (selectedKey) {
			const selectedIndex = this.filteredModels.findIndex((item) => this.getModelKey(item) === selectedKey);
			if (selectedIndex >= 0) {
				this.selectedIndex = selectedIndex;
				this.updateList();
			}
		}

		this.tui.requestRender();
	}

	private loadModelsFromSnapshot(): void {
		let availableModels: ReadonlyArray<Model<any>>;
		let models: ModelItem[];
		try {
			availableModels = this.getSnapshotModels();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		const availableModelsById = new Map(availableModels.map((model) => [`${model.provider}/${model.id}`, model]));
		this.scopedModels = this.scopedModels.map((scoped) => {
			const scopedModelId = `${scoped.model.provider}/${scoped.model.id}`;
			const refreshed =
				availableModelsById.get(scopedModelId) ??
				(this.availableModels !== undefined ? undefined : this.findModel(scoped.model.provider, scoped.model.id));
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
	}

	private async refreshModels(): Promise<void> {
		// An injected catalog belongs to whoever supplied it (a daemon-backed client);
		// refreshing the local source behind it would replace rows the caller owns.
		if (this.availableModels !== undefined) return;
		let timedOut = false;
		this.refreshStatusMessage = "Refreshing model catalogs…";
		this.refreshStatusSuccess = false;
		this.updateList();
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, MODEL_REFRESH_TIMEOUT_MS);
		try {
			const result = await refreshModelCatalogs(this.modelSource, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.getSourceError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private getModelKey(item: ModelItem): string {
		return `${item.provider}/${item.id}`;
	}

	private getSelectedModelKey(): string | undefined {
		const selected = this.filteredModels[this.selectedIndex];
		return selected ? this.getModelKey(selected) : undefined;
	}

	private recentRankOf(item: ModelItem): number {
		// Finite sentinel so subtracting two non-recent ranks yields 0, not NaN.
		return this.recentRank.get(`${item.provider}/${item.id}`) ?? Number.MAX_SAFE_INTEGER;
	}

	private isProviderConfigured(item: ModelItem): boolean {
		return this.configuredProviders?.has(item.provider) || this.hasConfiguredAuth(item.model);
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		sorted.sort((a, b) => {
			const configuredDiff = Number(this.isProviderConfigured(b)) - Number(this.isProviderConfigured(a));
			if (configuredDiff !== 0) return configuredDiff;
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
			const rankDiff = this.recentRankOf(a) - this.recentRankOf(b);
			if (rankDiff !== 0) return rankDiff;
			const providerDiff = a.provider.localeCompare(b.provider);
			if (providerDiff !== 0) return providerDiff;
			const aFeatured = a.model.featured === true;
			const bFeatured = b.model.featured === true;
			if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
			return a.id.localeCompare(b.id, undefined, { numeric: true });
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("app.model.toggleScope", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private getDefaultHintText(): string {
		return keyHint("app.model.selectAsDefault", "set as default");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		if (query.trim()) {
			const matches = this.activeModels.flatMap((item) => {
				const match = scoreModelSearch(item, query);
				return match ? [{ item, ...match }] : [];
			});
			matches.sort(
				(a, b) =>
					a.quality - b.quality ||
					a.score - b.score ||
					Number(this.isProviderConfigured(b.item)) - Number(this.isProviderConfigured(a.item)) ||
					Number(this.isDefaultModel(b.item.model)) - Number(this.isDefaultModel(a.item.model)) ||
					Number(modelsAreEqual(this.currentModel, b.item.model)) -
						Number(modelsAreEqual(this.currentModel, a.item.model)) ||
					this.recentRankOf(a.item) - this.recentRankOf(b.item) ||
					this.getModelKey(a.item).localeCompare(this.getModelKey(b.item), undefined, { numeric: true }),
			);
			const ranked = matches.map(({ item }) => item);
			if (this.isDefaultSearch(query)) {
				const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => this.getModelKey(item)));
				this.filteredModels = [
					...defaultItems,
					...ranked.filter((item) => !defaultKeys.has(this.getModelKey(item))),
				];
			} else {
				this.filteredModels = ranked;
			}
		} else {
			this.filteredModels = this.activeModels;
		}
		this.selectedIndex = queryChanged ? 0 : Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
		this.updateList();
	}

	override render(width: number): string[] {
		const previousLayoutKey = this.responsiveLayoutKey;
		this.updateResponsiveLayout();
		if (this.responsiveLayoutKey !== previousLayoutKey) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.updateResponsiveLayout();
		this.listContainer.clear();

		const maxVisible = this.listLayout.visibleItems;
		const selectedModelIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		const startIndex = Math.max(
			0,
			Math.min(selectedModelIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isConfigured = this.isProviderConfigured(item);
			const markers: string[] = [];
			if (modelsAreEqual(this.currentModel, item.model)) markers.push("current");
			if (this.isDefaultModel(item.model)) markers.push("default");
			if (!isConfigured) markers.push("sign in");
			const meta =
				markers.length === 0 ? undefined : theme.fg(isConfigured ? "success" : "warning", markers.join(" · "));

			this.listContainer.addChild(
				new MenuRow({
					primary: item.id,
					secondary: item.provider,
					meta,
					selected: isSelected,
				}),
			);
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${selectedModelIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected && this.shouldShowSelectedDetails()) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", selected.model.name), 0, 0));
			}
		}

		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", this.refreshStatusMessage), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.model.toggleScope")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			const selectableCount = this.getSelectableCount();
			if (selectableCount === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? selectableCount - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			const selectableCount = this.getSelectableCount();
			if (selectableCount === 0) return;
			this.selectedIndex = this.selectedIndex === selectableCount - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.handleConfirm();
		}
		// Escape / Ctrl+C, or left arrow when the search field is at its start
		else if (kb.matches(keyData, "tui.select.cancel") || shouldTreatAsBack(keyData, this.searchInput)) {
			this.dispose();
			this.onCancelCallback();
		}
		// Select and persist as the default model
		else if (this.onSelectAsDefaultCallback && kb.matches(keyData, "app.model.selectAsDefault")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	private handleConfirm(): void {
		const selectedModel = this.filteredModels[this.selectedIndex];
		if (selectedModel) {
			this.handleSelect(selectedModel.model);
			return;
		}
	}

	private getSelectableCount(): number {
		return this.filteredModels.length;
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private updateResponsiveLayout(): void {
		const showHeaderHelp = this.shouldShowHeaderHelp();
		let headerHelpRows = 0;
		this.headerHelpContainer.clear();
		if (showHeaderHelp) {
			if (this.scopeText && this.scopeHintText) {
				this.headerHelpContainer.addChild(this.scopeText);
				this.headerHelpContainer.addChild(this.scopeHintText);
				headerHelpRows += 2;
			} else if (this.warningText) {
				this.headerHelpContainer.addChild(this.warningText);
				headerHelpRows += 1;
			}
			if (this.defaultHintText) {
				this.headerHelpContainer.addChild(this.defaultHintText);
				headerHelpRows += 1;
			}
			this.headerHelpContainer.addChild(new Spacer(1));
			headerHelpRows += 1;
		}

		const headerRows = this.getHeaderRows();
		const reservedRows =
			MODEL_LIST_RESERVED_ROWS.base +
			headerRows +
			headerHelpRows +
			(this.shouldShowSelectedDetails() ? MODEL_LIST_RESERVED_ROWS.detail : 0) +
			(this.refreshStatusMessage ? MODEL_STATUS_ROWS : 0);
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
			totalItems: this.filteredModels.length,
			reservedRows,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: MODEL_SCROLL_INDICATOR_ROWS,
		});
		this.responsiveLayoutKey = [
			headerRows,
			showHeaderHelp ? "help" : "no-help",
			headerHelpRows,
			this.shouldShowSelectedDetails() ? "detail" : "no-detail",
			this.refreshStatusMessage ? "status" : "no-status",
			this.listLayout.compact ? "compact" : "comfortable",
			this.listLayout.visibleItems,
		].join(":");
	}

	private shouldShowHeaderHelp(): boolean {
		return this.hasRows(MODEL_HELP_MIN_ROWS);
	}

	private shouldShowSelectedDetails(): boolean {
		return this.hasRows(MODEL_DETAIL_MIN_ROWS);
	}

	private hasRows(minRows: number): boolean {
		const rows = this.viewport.getRows?.();
		return rows === undefined || !Number.isFinite(rows) || rows >= minRows;
	}
}
