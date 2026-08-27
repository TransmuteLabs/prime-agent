import { beforeAll, describe, expect, it, test, vi } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const config: SettingsConfig = {
	autoCompact: true,
	idleEvictionMinutes: 90,
	defaultModel: "not set",
	availableDefaultModels: [],
	showImages: true,
	imageWidthCells: 80,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	enableBuiltinSkills: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "sse",
	httpIdleTimeoutMs: 300_000,
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	modelThinkingLevels: {},
	currentTheme: "dark",
	terminalTheme: "dark",
	availableThemes: ["dark"],
	hideThinkingBlock: false,
	mermaidRenderingMode: "off",
	showCacheMissNotices: true,
	collapseChangelog: true,
	enableInstallTelemetry: true,
	doubleEscapeAction: "tree",
	treeFilterMode: "user-only",
	showHardwareCursor: false,
	editorPaddingX: 0,
	outputPad: 0,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	defaultProjectTrust: "ask",
	clearOnShrink: false,
	showTerminalProgress: false,
	tuiMode: "regular",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	warnings: {},
};

const callbacks: SettingsCallbacks = {
	onAutoCompactChange: () => {},
	onIdleEvictionMinutesChange: () => {},
	onShowImagesChange: () => {},
	onImageWidthCellsChange: () => {},
	onAutoResizeImagesChange: () => {},
	onBlockImagesChange: () => {},
	onEnableSkillCommandsChange: () => {},
	onEnableBuiltinSkillsChange: () => {},
	onSteeringModeChange: () => {},
	onFollowUpModeChange: () => {},
	onTransportChange: () => {},
	onHttpIdleTimeoutMsChange: () => {},
	onModelThinkingLevelChange: () => {},
	onModelThinkingLevelRemove: () => {},
	onThemeChange: () => {},
	onHideThinkingBlockChange: () => {},
	onMermaidRenderingModeChange: () => {},
	onShowCacheMissNoticesChange: () => {},
	onCollapseChangelogChange: () => {},
	onEnableInstallTelemetryChange: () => {},
	onDoubleEscapeActionChange: () => {},
	onTreeFilterModeChange: () => {},
	onShowHardwareCursorChange: () => {},
	onEditorPaddingXChange: () => {},
	onOutputPadChange: () => {},
	onAutocompleteMaxVisibleChange: () => {},
	onQuietStartupChange: () => {},
	onDefaultProjectTrustChange: () => {},
	onClearOnShrinkChange: () => {},
	onShowTerminalProgressChange: () => {},
	onTuiModeChange: () => {},
	onFullscreenExitOutputChange: () => {},
	onFullscreenScrollbarChange: () => {},
	onFullscreenCopyOnSelectChange: () => {},
	onWarningsChange: () => {},
	onCancel: () => {},
};

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const fullscreenConfig: SettingsConfig = {
			...config,
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
		};
		const fullscreenCallbacks = {
			...callbacks,
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		};

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(fullscreenConfig, fullscreenCallbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	test("cycles a custom idle eviction value to the next numeric option", () => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: 120 },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenCalledWith(180);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Idle worker eviction");
	});

	test.each([0.5, 1.5])("round-trips a fractional idle eviction value of %s", (value) => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: value },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		// Cycle through every option and back onto the custom fractional value.
		for (let index = 0; index < 7; index++) list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenLastCalledWith(value);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(String(value));
	});
});
