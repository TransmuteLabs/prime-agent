import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
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

	// TODO(prime-port): "keeps wrapped table-cell selection inside the originating cell" requires table-aware selection regions.
	// Component selection regions and the selection-metadata marker chain are not available.
	// Restore when wrapped table cells can constrain drag selection.

	// TODO(prime-port): "copies table selections as tab-separated content without borders" requires structured table selection metadata.
	// TuiAltScreen copies the painted rectangle and cannot reconstruct table cells.
	// Restore when table selections expose semantic cell content.

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
