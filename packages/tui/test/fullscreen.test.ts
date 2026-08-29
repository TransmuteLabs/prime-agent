import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Box } from "../src/components/box.ts";
import { Markdown } from "../src/components/markdown.ts";
import { ScrollView, type ScrollViewScrollbar } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class InputComponent extends TestComponent {
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

class SelectionOverlay extends TestComponent {
	private selected = 0;

	override render(width: number): string[] {
		return ["first", "second"].map((label, index) => {
			const line = label.padEnd(width);
			return index === this.selected ? `\x1b[48;5;238m${line}\x1b[49m` : line;
		});
	}

	handleInput(_data: string): void {
		this.selected = (this.selected + 1) % 2;
	}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";
const PAGE_UP = "\x1b[5~";
const HOME = "\x1bOH";
const END = "\x1bOF";

interface Setup {
	terminal: LoggingVirtualTerminal;
	tui: TuiAltScreen;
	chat: TestComponent;
	dock: TestComponent;
	scrollView: ScrollView;
}

function setup(transcriptLines: string[], cols = 40, rows = 10, options: TuiAltScreenOptions = {}): Setup {
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TuiAltScreen(terminal, undefined, undefined, options);
	const chat = new TestComponent();
	chat.lines = transcriptLines;
	const dock = new TestComponent();
	dock.lines = ["> prompt", "footer"];
	const scrollView = new ScrollView(chat, { follow: "end", primary: true });
	tui.setLayoutRoot(
		new VStack([
			{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
			{ component: dock, basis: "auto", minSize: 1 },
		]),
	);
	tui.start();
	return { terminal, tui, chat, dock, scrollView };
}

interface TableSetup extends Omit<Setup, "chat"> {
	chat: Container;
	markdown: Markdown;
}

interface TableSetupOptions {
	cols?: number;
	rows?: number;
	tui?: TuiAltScreenOptions;
	leadingLines?: string[];
	boxPaddingY?: number;
	scrollbar?: ScrollViewScrollbar;
}

/** Columns of one screen row the terminal is showing in reverse video. */
function inverseColumns(terminal: VirtualTerminal, row: number): number[] {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	if (!line) return [];
	const columns: number[] = [];
	for (let col = 0; col < line.length; col++) {
		if (line.getCell(col)?.isInverse()) columns.push(col);
	}
	return columns;
}

/** The columns a set of cells occupies, as the terminal should show them highlighted. */
function cellColumns(regions: ReadonlyArray<{ col: number; width: number }>): number[] {
	const columns = new Set<number>();
	for (const region of regions) {
		for (let col = region.col; col < region.col + region.width; col++) columns.add(col);
	}
	return [...columns].sort((a, b) => a - b);
}

/** The single contiguous inverse run of a screen row, as a half-open column range. */
function inverseRange(terminal: VirtualTerminal, row: number): { start: number; end: number } | undefined {
	const columns = inverseColumns(terminal, row);
	if (columns.length === 0) return undefined;
	const start = columns[0];
	const end = columns[columns.length - 1] + 1;
	assert.strictEqual(columns.length, end - start, `row ${row} highlight is not contiguous: ${columns.join(",")}`);
	return { start, end };
}

/** A transcript holding a single markdown table, nested the way message components nest one. */
function setupTable(markdownText: string, options: TableSetupOptions = {}): TableSetup {
	const cols = options.cols ?? 40;
	const rows = options.rows ?? 12;
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TuiAltScreen(terminal, undefined, undefined, options.tui ?? {});
	const markdown = new Markdown(markdownText, 0, 0, defaultMarkdownTheme);
	const box = new Box(1, options.boxPaddingY ?? 0);
	box.addChild(markdown);
	const chat = new Container();
	for (const line of options.leadingLines ?? []) {
		const leading = new TestComponent();
		leading.lines = [line];
		chat.addChild(leading);
	}
	chat.addChild(box);
	const dock = new TestComponent();
	dock.lines = ["> prompt", "footer"];
	const scrollView = new ScrollView(chat, {
		follow: "end",
		primary: true,
		...(options.scrollbar ? { scrollbar: options.scrollbar } : {}),
	});
	tui.setLayoutRoot(
		new VStack([
			{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
			{ component: dock, basis: "auto", minSize: 1 },
		]),
	);
	tui.start();
	return { terminal, tui, chat, dock, scrollView, markdown };
}

function copyOptions(copies: string[]): TuiAltScreenOptions {
	return {
		copySelection: async (text) => {
			copies.push(text);
			return true;
		},
	};
}

function lines(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("TUI fullscreen mode", () => {
	// TODO(prime-port): "renders terminal images as compact metadata fallbacks" requires compact image metadata in the alternate screen.
	// TuiAltScreen emits Kitty placements instead of replacing them with metadata.
	// Restore when alternate-screen image fallback policy is configurable.

	// TODO(prime-port): "restores inline rendering after leaving fullscreen" requires fullscreen to be a mode toggle on one TUI instance.
	// TuiAltScreen owns the alternate-screen lifetime and has no inline mode to return to.
	// Restore when one instance can switch between inline and alternate-screen rendering.

	// TODO(prime-port): "uses compact metadata for images in fullscreen overlays" requires compact overlay image metadata.
	// TuiAltScreen preserves Kitty image placement behavior in overlays.
	// Restore when alternate-screen overlays can request metadata-only image rendering.

	// TODO(prime-port): "hides the follow hint while following" requires a composited follow hint.
	// TuiAltScreen exposes follow state but has no "to follow" compositor.
	// Restore when the alternate-screen viewport provides a follow hint.

	// TODO(prime-port): "keeps focused overlay selection within visible overlay text" requires overlay-local drag clamping.
	// TuiAltScreen selection is a rectangle over the composited screen.
	// Restore when focused overlays can constrain selection to their own text.

	// TODO(prime-port): "does not select text from an unfocused visible overlay" requires focus-aware overlay selection exclusion.
	// TuiAltScreen selects visible composited text without overlay focus metadata.
	// Restore when selection can exclude unfocused overlay regions.

	// TODO(prime-port): "does not auto-scroll a horizontal selection on the top row" requires horizontal-drag-aware edge handling.
	// TuiAltScreen derives auto-scroll direction from pointer row alone.
	// Restore when horizontal drags on an edge row can suppress auto-scroll.

	// TODO(prime-port): "can stop without leaving alt screen or flushing fullscreen content" requires alternate-screen handoff.
	// TuiAltScreen exits the alternate screen for both stop branches.
	// Restore when stop can preserve an active alternate screen for a successor.

	// TODO(prime-port): "ignores preserve requests when no alternate screen is active" requires mode-dependent preserve handling.
	// A TuiAltScreen instance owns an alternate-screen session whenever it is started.
	// Restore with alternate-screen handoff support on a mode-switching instance.

	// TODO(prime-port): "can pass viewport keys to the focused component" requires disabling viewport controls.
	// TuiAltScreen always consumes unmodified page keys unless a capturing overlay is focused.
	// Restore when viewport key handling can be disabled.

	it("keeps the window pinned to the bottom while following", async () => {
		const { terminal, tui, chat } = setup(lines(20));
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, true);

		chat.lines = lines(25);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[7], "Line 24", "window follows appended content");
		assert.strictEqual(viewport[8], "> prompt", "dock stays pinned");
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("wheel up unfollows and freezes the window while content appends", async () => {
		const { terminal, tui, chat } = setup(lines(20), 40, 10, { wheelScrollLines: 3 });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "wheel scrolls up 3 lines");
		assert.strictEqual(tui.isFollowingOutput, false);

		chat.lines = lines(40);
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "appended content does not move the window");
		assert.strictEqual(viewport[8], "> prompt", "dock stays visible");
		assert.strictEqual(tui.isFollowingOutput, false);

		tui.stop();
	});

	it("scrolling back to the bottom resumes following", async () => {
		const { terminal, tui, chat } = setup(lines(20), 40, 10, { wheelScrollLines: 3 });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, false);

		terminal.sendInput(WHEEL_DOWN);
		await terminal.waitForRender();
		assert.strictEqual(tui.isFollowingOutput, true);

		chat.lines = lines(22);
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 21");

		tui.stop();
	});

	it("page and home/end keys scroll the window while the editor keeps focus", async () => {
		const { terminal, tui } = setup(lines(30));
		const editor = new InputComponent();
		tui.setFocus(editor);
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 18");

		terminal.sendInput(HOME);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 0");
		assert.strictEqual(tui.isFollowingOutput, false);

		terminal.sendInput(END);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 29");
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("a");
		assert.deepStrictEqual(editor.inputs, ["a"], "viewport navigation keeps editor focus");

		tui.stop();
	});

	it("row-diffs frames: only changed rows are repainted", async () => {
		const { terminal, tui, chat } = setup(lines(20));
		await terminal.waitForRender();
		terminal.clearWrites();

		chat.lines = [...lines(19), "Line 19 changed"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "no full clear for a single-line change");
		assert.ok(writes.includes("\x1b[8;1H"), "repaints the changed row (window row 8)");
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.strictEqual(repaintedRows.length, 1, "exactly one row repainted");
		assert.strictEqual(terminal.getViewport()[7], "Line 19 changed");

		tui.stop();
	});

	it("resize repaints the whole frame and clamps the scroll position", async () => {
		const { terminal, tui } = setup(lines(30));
		await terminal.waitForRender();

		tui.scrollToTop();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 20);
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "resize forces a full frame repaint");
		assert.strictEqual(tui.viewportTop, 0, "scroll position remains clamped at the top");
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 0");
		assert.strictEqual(viewport[18], "> prompt", "dock re-anchored to the new bottom");

		tui.stop();
	});

	it("repaints only changed rows when navigating a focused overlay", async () => {
		const { terminal, tui } = setup(lines(20));
		await terminal.waitForRender();

		tui.showOverlay(new SelectionOverlay(), { anchor: "center", width: 20 });
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.sendInput("j");
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.ok(!writes.includes("\x1b[2J"), "overlay navigation should not clear the screen");
		assert.strictEqual(repaintedRows.length, 2, "only the old and new selected rows should repaint");

		tui.stop();
	});

	it("suspends fullscreen mouse tracking while a visible overlay requests native mouse", async () => {
		const { terminal, tui } = setup(lines(20), 80, 10);
		await terminal.waitForRender();
		assert.match(terminal.getWrites(), /\x1b\[\?100[23]h/);

		terminal.clearWrites();
		const overlay = new InputComponent();
		overlay.lines = ["https://example.com/login"];
		const handle = tui.showOverlay(overlay, {
			anchor: "center",
			width: 40,
			suspendFullscreenMouse: true,
		});
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[?1000l"));

		terminal.clearWrites();
		handle.setHidden(true);
		await terminal.waitForRender();
		assert.match(terminal.getWrites(), /\x1b\[\?100[23]h/);

		terminal.clearWrites();
		handle.setHidden(false);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[?1000l"));

		terminal.clearWrites();
		handle.hide();
		await terminal.waitForRender();
		assert.match(terminal.getWrites(), /\x1b\[\?100[23]h/);

		tui.stop();
	});

	it("drag-selecting focused overlay text copies from the fullscreen frame", async () => {
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 80, 10, copyOptions(copies));
		await terminal.waitForRender();

		const url = "https://example.com/login";
		const overlay = new InputComponent();
		overlay.lines = ["Sign-in link", url];
		tui.showOverlay(overlay, { anchor: "center", width: 40 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible in the focused overlay");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "overlay selection is highlighted while dragging");

		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);
		assert.deepStrictEqual(overlay.inputs, [], "mouse reports are consumed before overlay input handlers");

		tui.stop();
	});

	it("maps focused overlay selection to the painted viewport slice", async () => {
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 80, 5, copyOptions(copies));
		await terminal.waitForRender();

		const url = "https://example.com/visible";
		const overlay = new InputComponent();
		overlay.lines = [url, "overlay row 1", "overlay row 2", "overlay row 3", "overlay row 4", "overlay row 5"];
		tui.showOverlay(overlay, { anchor: "top-left", width: 40 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible after the over-tall frame is sliced");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("copies an active frame selection if focus changes before release", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setup(lines(20), 80, 10, copyOptions(copies));
		await terminal.waitForRender();

		const url = "https://example.com/focus-change";
		const overlay = new InputComponent();
		overlay.lines = ["Sign-in link", url];
		tui.showOverlay(overlay, { anchor: "center", width: 44 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes(url));
		assert.notStrictEqual(row, -1, "URL is visible in the focused overlay");
		const col = viewport[row]!.indexOf(url);
		const startX = col + 1;
		const endX = startX + url.length;
		const y = row + 1;

		terminal.sendInput(`\x1b[<0;${startX};${y}M`);
		terminal.sendInput(`\x1b[<32;${endX};${y}M`);
		tui.setFocus(chat);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${endX};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("does not copy lower overlay text covered by a higher overlay", async () => {
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 80, 10, copyOptions(copies));
		await terminal.waitForRender();

		const lowerUrl = "https://lower.example/login";
		const lower = new InputComponent();
		lower.lines = [lowerUrl];
		tui.showOverlay(lower, { anchor: "bottom-left", width: 32 });

		const upper = new InputComponent();
		upper.lines = ["TOP"];
		tui.showOverlay(upper, { anchor: "bottom-left", width: 32 });
		await terminal.waitForRender();

		const row = terminal.getViewport().findIndex((line) => line.startsWith("TOP"));
		assert.notStrictEqual(row, -1, "higher overlay is visible");
		const y = row + 1;
		terminal.sendInput(`\x1b[<0;1;${y}M`);
		terminal.sendInput(`\x1b[<32;32;${y}M`);
		terminal.sendInput(`\x1b[<0;32;${y}m`);
		await terminal.waitForRender();

		assert.strictEqual(copies.length, 1, "visible upper overlay text is selected");
		assert.ok(!copies[0]!.includes(lowerUrl), "covered lower URL is absent from copied text");

		tui.stop();
	});

	it("maps focused overlay transcript fallback to the painted viewport slice", async () => {
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 40, 5, copyOptions(copies));
		await terminal.waitForRender();

		const overlay = new InputComponent();
		overlay.lines = ["", "", "", "", "", ""];
		tui.showOverlay(overlay, { anchor: "top-left", width: 1 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("18"), "top painted row is shifted by the over-tall overlay");
		const col = viewport[0]!.indexOf("18");
		const startX = col + 1;
		const endX = startX + 2;

		terminal.sendInput(`\x1b[<0;${startX};1M`);
		terminal.sendInput(`\x1b[<32;${endX};1M`);
		terminal.sendInput(`\x1b[<0;${endX};1m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, ["18"]);

		tui.stop();
	});

	it("exit restores the primary screen and flushes fullscreen-era content into scrollback", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const chat = new TestComponent();
		chat.lines = lines(5);
		const dock = new TestComponent();
		dock.lines = ["> prompt", "footer"];
		const scrollView = new ScrollView(chat, { follow: "end", primary: true });
		tui.setLayoutRoot(
			new VStack([
				{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");

		chat.lines = lines(30);
		tui.requestRender();
		await terminal.waitForRender();
		tui.stop();
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		const writes = terminal.getWrites();
		const exitIndex = writes.lastIndexOf("\x1b[?1049l");
		assert.ok(exitIndex >= 0, "alternate screen is exited");
		assert.ok(writes.indexOf("Line 29", exitIndex) > exitIndex, "fullscreen-era content is written after the exit");
		// The scroll entry is 30 rows tall in a 10-row terminal, so the whole transcript only
		// survives the exit if the flush renders the document at its content height.
		const primaryBuffer = terminal.getScrollBuffer().join("\n");
		assert.ok(primaryBuffer.includes("Line 0"), "the transcript from before the append is in scrollback");
		assert.ok(primaryBuffer.includes("Line 29"), "the appended content is in the primary buffer");
		assert.ok(primaryBuffer.includes("footer"), "the dock is in the primary buffer");
	});

	it("auto-scrolls downward while selecting at the transcript edge", async () => {
		const copies: string[] = [];
		const { terminal, tui, scrollView } = setup(lines(30), 40, 10, copyOptions(copies));
		await terminal.waitForRender();

		tui.scrollToTop();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;4M");
		terminal.sendInput("\x1b[<32;8;8M");
		await waitFor(() => scrollView.scrollTop > 0);
		await terminal.waitForRender();

		const { scrollTop } = scrollView;
		terminal.sendInput("\x1b[<0;8;8m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [
			lines(30)
				.slice(3, scrollTop + 8)
				.join("\n"),
		]);

		tui.stop();
	});

	it("drag-selecting dock text copies from the user input area", async () => {
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 40, 10, copyOptions(copies));
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;9M");
		terminal.sendInput("\x1b[<32;9;9M");
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "dock selection highlighted while dragging");

		terminal.sendInput("\x1b[<0;9;9m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["prompt"]);

		tui.stop();
	});

	it("clicking a bare URL opens it when OSC 8 metadata is absent", async () => {
		const transcript = lines(20);
		transcript[12] = "see https://example.com/docs here";
		const opened: string[] = [];
		const { terminal, tui } = setup(transcript, 40, 10, { openUrl: (url) => opened.push(url) });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;6;1M");
		transcript[12] = "updated without the URL";
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;6;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(opened, ["https://example.com/docs"]);

		tui.stop();
	});

	it("clicking a hyperlink after a tab opens the painted target", async () => {
		const transcript = lines(20);
		transcript[12] = "\t\x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\";
		const opened: string[] = [];
		const { terminal, tui } = setup(transcript, 40, 10, { openUrl: (url) => opened.push(url) });
		await terminal.waitForRender();

		const paintedLine = terminal.getViewport()[0]!;
		const x = paintedLine.indexOf("docs") + 1;
		assert.ok(x > 0, "hyperlink text is visible after tab expansion");
		terminal.sendInput(`\x1b[<0;${x};1M`);
		terminal.sendInput(`\x1b[<0;${x};1m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(opened, ["https://example.com/docs"]);

		tui.stop();
	});

	it("does not open a link when a drag returns to its press cell", async () => {
		const transcript = lines(20);
		transcript[12] = "see \x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\ here";
		const opened: string[] = [];
		const copies: string[] = [];
		const { terminal, tui } = setup(transcript, 40, 10, {
			openUrl: (url) => opened.push(url),
			...copyOptions(copies),
		});
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;9;1M");
		terminal.sendInput("\x1b[<32;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);
		assert.deepStrictEqual(opened, []);

		tui.stop();
	});

	it("does not open a link when a focused-overlay drag returns to its press cell", async () => {
		const opened: string[] = [];
		const copies: string[] = [];
		const { terminal, tui } = setup(lines(20), 80, 10, {
			openUrl: (url) => opened.push(url),
			...copyOptions(copies),
		});
		await terminal.waitForRender();

		const overlay = new InputComponent();
		overlay.lines = ["\x1b]8;;https://example.com/docs\x1b\\docs\x1b]8;;\x1b\\"];
		tui.showOverlay(overlay, { anchor: "center", width: 20 });
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes("docs"));
		assert.notStrictEqual(row, -1);
		const x = viewport[row]!.indexOf("docs") + 1;
		const y = row + 1;
		terminal.sendInput(`\x1b[<0;${x};${y}M`);
		terminal.sendInput(`\x1b[<32;${x + 4};${y}M`);
		terminal.sendInput(`\x1b[<32;${x};${y}M`);
		terminal.sendInput(`\x1b[<0;${x};${y}m`);
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);
		assert.deepStrictEqual(opened, []);
		assert.deepStrictEqual(overlay.inputs, []);

		tui.stop();
	});

	it("rejects malformed or control-character hyperlink URLs", async () => {
		const transcript = lines(20);
		transcript[12] =
			"\x1b]8;;https://example.com/\x00bad\x1b\\nul\x1b]8;;\x1b\\ " +
			"\x1b]8;;https://[invalid\x1b\\malformed\x1b]8;;\x1b\\ " +
			"\x1b]8;;https://example.com/bad\x1b\\c1\x1b]8;;\x1b\\";
		const opened: string[] = [];
		const { terminal, tui } = setup(transcript, 40, 10, { openUrl: (url) => opened.push(url) });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;15;1M");
		terminal.sendInput("\x1b[<0;15;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(opened, []);

		tui.stop();
	});

	it("clicking a hyperlink in the dock opens it", async () => {
		const opened: string[] = [];
		const { terminal, tui, dock } = setup(lines(20), 40, 10, { openUrl: (url) => opened.push(url) });
		dock.lines = ["\x1b]8;;https://example.com/login\x07sign in\x1b]8;;\x07", "footer"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const row = viewport.findIndex((line) => line.includes("sign in"));
		assert.notStrictEqual(row, -1);
		const x = viewport[row]!.indexOf("sign in") + 1;
		const y = row + 1;
		terminal.sendInput(`\x1b[<0;${x};${y}M`);
		terminal.sendInput(`\x1b[<0;${x};${y}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(opened, ["https://example.com/login"]);

		tui.stop();
	});

	it("copies a wrapped table cell unwrapped, whichever of its lines the drag ends on", async () => {
		const copies: string[] = [];
		const url = "https://example.com/this/is/a/very/long/path";
		const { terminal, tui, chat } = setupTable(
			`| URL | Status |
| --- | --- |
| ${url} | should-not-copy |`,
			{ rows: 12, tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		const contentLines = chat.render(40);
		const regions = chat
			.getSelectionRegions()
			.filter((region) => region.row === 1 && region.column === 0)
			.sort((a, b) => a.segment - b.segment);
		assert.ok(regions.length > 1, "URL cell should wrap across physical lines");
		assert.ok(contentLines.length <= 10, "table should fit without scrolling");

		const first = regions[0];
		const last = regions.at(-1)!;
		// Release on the cell's own last character, not past its padding: the drag crossed the
		// wrap, so the cell is copied unwrapped rather than sliced along the rendered lines.
		const lastCellText = stripTerminalSequences(
			sliceByColumn(contentLines[last.line], last.col, last.width, true),
		).trimEnd();
		const lastVisibleCol = last.col + visibleWidth(lastCellText) - 1;
		assert.ok(lastVisibleCol < last.col + last.width, "probe must end inside the cell, not on its padding");
		terminal.sendInput(`\x1b[<0;${first.col + 1};${first.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${lastVisibleCol + 1};${last.line + 1}M`);
		await terminal.waitForRender();

		for (const region of regions) {
			assert.deepStrictEqual(
				inverseRange(terminal, region.line),
				{ start: region.col, end: region.col + region.width },
				`line ${region.line} should highlight exactly the cell`,
			);
		}

		terminal.sendInput(`\x1b[<0;${lastVisibleCol + 1};${last.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [url]);

		tui.stop();
	});

	it("copies only the covered columns while a drag stays on one line of a cell", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		chat.render(40);
		const cell = chat.getSelectionRegions().find((region) => region.row === 1 && region.column === 0)!;
		terminal.sendInput(`\x1b[<0;${cell.col + 2};${cell.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${cell.col + 4};${cell.line + 1}M`);
		await terminal.waitForRender();
		assert.deepStrictEqual(inverseRange(terminal, cell.line), { start: cell.col + 1, end: cell.col + 4 });

		terminal.sendInput(`\x1b[<0;${cell.col + 4};${cell.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["ver"]);

		tui.stop();
	});

	it("copies table selections as tab-separated content without borders", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score | City |
| --- | --- | --- |
| Avery | 87 | Seattle |
| Jordan | 92 | Austin |
| Morgan | 74 | Boston |`,
			{ rows: 14, tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		const contentLines = chat.render(40);
		const regions = chat.getSelectionRegions();
		const { tableTop: top, tableBottom: bottom, tableLeft: left, tableRight: right } = regions[0];
		terminal.sendInput(`\x1b[<0;${left};${top + 1}M`);
		terminal.sendInput(`\x1b[<32;${right};${bottom + 1}M`);
		await terminal.waitForRender();

		// Every cell of the table is highlighted and nothing else is: borders and the gaps
		// between columns stay untouched.
		for (const region of regions) {
			const highlighted = new Set(inverseColumns(terminal, region.line));
			for (let col = region.col; col < region.col + region.width; col++) {
				assert.ok(highlighted.has(col), `cell column ${col} of line ${region.line} should be highlighted`);
			}
		}
		for (let line = top; line <= bottom; line++) {
			const borderColumns = [...stripAnsi(contentLines[line])]
				.map((char, index) => (/[\u2502\u250c\u2510\u2514\u2518\u251c\u2524]/.test(char) ? index : -1))
				.filter((index) => index >= 0);
			const highlighted = new Set(inverseColumns(terminal, line));
			for (const col of borderColumns) {
				assert.ok(!highlighted.has(col), `border column ${col} of line ${line} must not be highlighted`);
			}
		}

		terminal.sendInput(`\x1b[<0;${right};${bottom + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\tCity\nAvery\t87\tSeattle\nJordan\t92\tAustin\nMorgan\t74\tBoston"]);
		assert.ok(!/[\u250c\u252c\u2510\u251c\u253c\u2524\u2514\u2534\u2518\u2502\u2500]/.test(copies[0]));

		tui.stop();
	});

	it("selects a single table column without the neighbouring column", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |
| Jordan | 92 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		chat.render(40);
		const regions = chat.getSelectionRegions();
		const header = regions.find((region) => region.row === 0 && region.column === 1)!;
		const lastRow = regions.find((region) => region.row === 2 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${header.col + 1};${header.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${lastRow.col + 1};${lastRow.line + 1}M`);
		await terminal.waitForRender();
		const firstColumn = regions.find((region) => region.row === 0 && region.column === 0)!;
		assert.deepStrictEqual(inverseRange(terminal, header.line), {
			start: header.col,
			end: header.col + header.width,
		});
		assert.ok(
			!new Set(inverseColumns(terminal, firstColumn.line)).has(firstColumn.col),
			"the neighbouring column must stay unhighlighted",
		);

		terminal.sendInput(`\x1b[<0;${lastRow.col + 1};${lastRow.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Score\n87\n92"]);

		tui.stop();
	});

	it("selects the same cells when the drag runs backwards", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		chat.render(40);
		const regions = chat.getSelectionRegions();
		const header = regions.find((region) => region.row === 0 && region.column === 0)!;
		const lastCell = regions.find((region) => region.row === 1 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${lastCell.col + 1};${lastCell.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${header.col + 1};${header.line + 1}M`);
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${header.col + 1};${header.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\nAvery\t87"]);

		tui.stop();
	});

	it("offsets table cells by the transcript components and padding rendered above them", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{
				rows: 16,
				tui: copyOptions(copies),
				leadingLines: ["header one", "header two", "header three"],
				boxPaddingY: 1,
			},
		);
		await terminal.waitForRender();

		const contentLines = chat.render(40);
		const regions = chat.getSelectionRegions();
		const cell = regions.find((region) => region.row === 1 && region.column === 0)!;
		const renderedRow = contentLines.findIndex((line) => line.includes("Avery"));
		const borderRow = contentLines.findIndex((line) => stripAnsi(line).includes("\u250c"));
		assert.ok(renderedRow >= 4, "the table must render below the preceding components and the box padding");
		assert.strictEqual(cell.line, renderedRow, "cell lines are transcript lines, not component-local ones");
		assert.strictEqual(regions[0].tableTop, borderRow, "table bounds must be offset with the cells");

		const scoreCell = regions.find((region) => region.row === 1 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${cell.col + 1};${cell.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${scoreCell.col + 1};${scoreCell.line + 1}M`);
		await terminal.waitForRender();
		assert.deepStrictEqual(
			inverseColumns(terminal, cell.line),
			cellColumns([cell, scoreCell]),
			"both cells are highlighted and the border between them is not",
		);

		terminal.sendInput(`\x1b[<0;${scoreCell.col + 1};${scoreCell.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Avery\t87"]);

		tui.stop();
	});

	it("selects table cells when the scrollbar reserves a content column", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies), scrollbar: "always" },
		);
		await terminal.waitForRender();

		const regions = chat.render(39) && chat.getSelectionRegions();
		const header = regions.find((region) => region.row === 0 && region.column === 0)!;
		const cell = regions.find((region) => region.row === 1 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${header.col + 1};${header.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${cell.col + 1};${cell.line + 1}M`);
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${cell.col + 1};${cell.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\nAvery\t87"]);

		tui.stop();
	});

	it("selects table cells in a scrolled transcript", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat, scrollView } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ rows: 10, tui: copyOptions(copies), leadingLines: lines(20, "Filler") },
		);
		await terminal.waitForRender();
		assert.ok(scrollView.scrollTop > 0, "transcript must be scrolled for this to mean anything");

		chat.render(40);
		const regions = chat.getSelectionRegions();
		const header = regions.find((region) => region.row === 0 && region.column === 0)!;
		const cell = regions.find((region) => region.row === 1 && region.column === 1)!;
		const screenRow = (line: number) => line - scrollView.scrollTop;
		terminal.sendInput(`\x1b[<0;${header.col + 1};${screenRow(header.line) + 1}M`);
		terminal.sendInput(`\x1b[<32;${cell.col + 1};${screenRow(cell.line) + 1}M`);
		await terminal.waitForRender();
		const headerRow = regions.filter((region) => region.line === header.line);
		assert.deepStrictEqual(
			inverseColumns(terminal, screenRow(header.line)),
			cellColumns(headerRow),
			"the whole header row of the table is highlighted on its screen row",
		);

		terminal.sendInput(`\x1b[<0;${cell.col + 1};${screenRow(cell.line) + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\nAvery\t87"]);

		tui.stop();
	});

	it("drops a table selection when the anchor cell is replaced mid-drag", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat, markdown } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		chat.render(40);
		const cell = chat.getSelectionRegions().find((region) => region.row === 1 && region.column === 0)!;
		const scoreCell = chat.getSelectionRegions().find((region) => region.row === 1 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${cell.col + 1};${cell.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${scoreCell.col + 1};${scoreCell.line + 1}M`);
		await terminal.waitForRender();
		assert.ok(inverseColumns(terminal, cell.line).length > 0, "the drag is highlighting cells");

		// Table identity is positional, so a rewrite that puts a different table in the same slot
		// must not hand the drag a stranger's cells.
		markdown.setText(`| Other | Table |
| --- | --- |
| 111 | 222 |`);
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(inverseColumns(terminal, cell.line), [], "the stale selection stops highlighting");

		terminal.sendInput(`\x1b[<0;${scoreCell.col + 1};${scoreCell.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, [], "nothing is copied from the table that replaced it");

		tui.stop();
	});

	it("selects table cells in the implicit document when no layout root is set", async () => {
		const copies: string[] = [];
		const terminal = new LoggingVirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal, undefined, undefined, copyOptions(copies));
		const markdown = new Markdown(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			0,
			0,
			defaultMarkdownTheme,
		);
		const box = new Box(1, 0);
		box.addChild(markdown);
		tui.addChild(box);
		tui.start();
		await terminal.waitForRender();

		const regions = box.getSelectionRegions();
		const header = regions.find((region) => region.row === 0 && region.column === 0)!;
		const cell = regions.find((region) => region.row === 1 && region.column === 1)!;
		terminal.sendInput(`\x1b[<0;${header.col + 1};${header.line + 1}M`);
		terminal.sendInput(`\x1b[<32;${cell.col + 1};${cell.line + 1}M`);
		await terminal.waitForRender();
		terminal.sendInput(`\x1b[<0;${cell.col + 1};${cell.line + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Name\tScore\nAvery\t87"]);

		tui.stop();
	});

	it("selects transcript text normally outside a table", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`Intro line

| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		const contentLines = chat.render(40);
		const introRow = contentLines.findIndex((line) => line.includes("Intro line"));
		assert.ok(introRow >= 0, "intro paragraph should render above the table");
		terminal.sendInput(`\x1b[<0;2;${introRow + 1}M`);
		terminal.sendInput(`\x1b[<32;12;${introRow + 1}M`);
		await terminal.waitForRender();

		terminal.sendInput(`\x1b[<0;12;${introRow + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Intro line"]);

		tui.stop();
	});

	it("keeps word and line selection inside a table", async () => {
		const copies: string[] = [];
		const { terminal, tui, chat } = setupTable(
			`| Name | Score |
| --- | --- |
| Avery | 87 |`,
			{ tui: copyOptions(copies) },
		);
		await terminal.waitForRender();

		chat.render(40);
		const cell = chat.getSelectionRegions().find((region) => region.row === 1 && region.column === 0)!;
		const column = cell.col + 1;
		const row = cell.line + 1;
		const click = () => {
			terminal.sendInput(`\x1b[<0;${column};${row}M`);
			terminal.sendInput(`\x1b[<0;${column};${row}m`);
		};
		click();
		click();
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Avery"], "double click selects the word under the pointer");

		click();
		await terminal.waitForRender();
		assert.strictEqual(copies.length, 2);
		assert.match(copies[1], /^\s*\u2502 Avery/, "triple click selects the rendered line, borders included");

		tui.stop();
	});

	it("mouse reports are consumed and never reach the focused component", async () => {
		const { terminal, tui } = setup(lines(20));
		const editor = new InputComponent();
		tui.setFocus(editor);
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		terminal.sendInput("\x1b[<0;3;3M");
		terminal.sendInput("a");
		await terminal.waitForRender();

		assert.deepStrictEqual(editor.inputs, ["a"], "only keyboard input reaches the non-overlay editor");

		tui.stop();
	});
});
