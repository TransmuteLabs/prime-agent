import { Box, type Component, Container, Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { parseSlashCommand } from "../../../core/slash-commands.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { isLeadingSlashCommand } from "./slash-command-message.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const COMMAND_MASK_BASE = "\uE000";
const COMMAND_MASK_EXTRA_WIDTH = "\uFF9E";
const COMMAND_MASK_ZERO_WIDTH = "\u2060";
const COMMAND_MASK_PATTERN = /\u2060|\uE000\uFF9E*/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface UserMessageComponentOptions {
	/** Horizontal padding for the message box (default: 1). */
	outputPad?: number;
	/** Extension-provided markdown transformers. */
	markdownTransformers?: readonly MarkdownTransformer[];
}

class SlashCommandMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly commandGraphemes: string[];

	constructor(text: string, markdownTheme: MarkdownTheme) {
		const parsed = parseSlashCommand(text);
		const commandEnd = parsed ? parsed.name.length + 1 : text.length;
		this.commandGraphemes = [...graphemeSegmenter.segment(text.slice(0, commandEnd))].map(({ segment }) => segment);
		const placeholder = this.commandGraphemes
			.map((grapheme) => {
				const width = visibleWidth(grapheme);
				return width === 0
					? COMMAND_MASK_ZERO_WIDTH
					: COMMAND_MASK_BASE + COMMAND_MASK_EXTRA_WIDTH.repeat(width - 1);
			})
			.join("");
		this.markdown = new Markdown(`${placeholder}${text.slice(commandEnd)}`, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	render(width: number): string[] {
		let commandOffset = 0;
		return this.markdown.render(width).map((line) => {
			const chunks: string[] = [];
			const replaced = line.replace(COMMAND_MASK_PATTERN, (placeholder) => {
				const grapheme = this.commandGraphemes[commandOffset];
				if (grapheme === undefined) return placeholder;
				commandOffset++;
				chunks.push(grapheme);
				return "";
			});
			return chunks.length === 0 ? replaced : `${theme.fg("accent", chunks.join(""))}${replaced}`;
		});
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private isRecognizedSlashCommand: (name: string) => boolean;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
		options: UserMessageComponentOptions = {},
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.isRecognizedSlashCommand = isRecognizedSlashCommand;
		this.outputPad = options.outputPad ?? 1;
		this.markdownTransformers = options.markdownTransformers ?? [];
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) =>
			theme.getUserMessageBackgroundColor()(content),
		);
		contentBox.addChild(
			isLeadingSlashCommand(this.text, this.isRecognizedSlashCommand)
				? new SlashCommandMarkdown(this.text, this.markdownTheme)
				: new Markdown(
						this.text,
						0,
						0,
						this.markdownTheme,
						{
							color: (content: string) => theme.fg("userMessageText", content),
						},
						{
							preserveOrderedListMarkers: true,
							preserveBackslashEscapes: true,
							transform: createMarkdownTransform("user", false, this.markdownTransformers),
						},
					),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
