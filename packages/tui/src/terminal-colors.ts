export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export type TerminalColorScheme = "dark" | "light";

function hexToRgb(hex: string): RgbColor {
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(normalized.slice(0, 2), 16);
	const g = parseInt(normalized.slice(2, 4), 16);
	const b = parseInt(normalized.slice(4, 6), 16);
	return { r, g, b };
}

function parseOscHexChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}
	const max = 16 ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}
	return Math.round((parseInt(channel, 16) / max) * 255);
}

const OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
const COLOR_SCHEME_REPORT_PATTERN = /^(?:\x1b\[\?997;(1|2)n)+$/;

export function isOsc11BackgroundColorResponse(data: string): boolean {
	return OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.test(data);
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
	const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN);
	if (!match) {
		return undefined;
	}

	const value = match[1].trim();
	if (value.startsWith("#")) {
		const hex = value.slice(1);
		if (/^[0-9a-f]{6}$/i.test(hex)) {
			return hexToRgb(value);
		}
		if (/^[0-9a-f]{12}$/i.test(hex)) {
			const r = parseOscHexChannel(hex.slice(0, 4));
			const g = parseOscHexChannel(hex.slice(4, 8));
			const b = parseOscHexChannel(hex.slice(8, 12));
			return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
		}
		return undefined;
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	const [red, green, blue] = rgbValue.split("/");
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}
	const r = parseOscHexChannel(red);
	const g = parseOscHexChannel(green);
	const b = parseOscHexChannel(blue);
	return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined;
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
	if (!match) {
		return undefined;
	}
	return match[1] === "2" ? "light" : "dark";
}

// ============================================================================
// Default terminal colors (OSC 10/11) shared state + contrast helpers
// ============================================================================

export interface DefaultTerminalColors {
	foreground?: RgbColor;
	background: RgbColor;
}

export type TerminalBackgroundKind = "dark" | "light";
export type TerminalColorMode = "truecolor" | "256color" | "ansi16" | "unknown";

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
const defaultColorListeners = new Set<() => void>();

let defaultTerminalColors: DefaultTerminalColors | undefined;

function clampChannel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function colorDistance(a: RgbColor, b: RgbColor): number {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function findClosestIndex(value: number, values: readonly number[]): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < values.length; i++) {
		const dist = Math.abs(value - values[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

function notifyDefaultColorListeners(): void {
	for (const listener of defaultColorListeners) {
		listener();
	}
}

export function rgbToHex(rgb: RgbColor): string {
	const toHex = (value: number) => clampChannel(value).toString(16).padStart(2, "0");
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function isLightColor(rgb: RgbColor): boolean {
	return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b > 128;
}

export function blendColor(top: RgbColor, bottom: RgbColor, alpha: number): RgbColor {
	const clampedAlpha = Math.max(0, Math.min(1, alpha));
	return {
		r: clampChannel(top.r * clampedAlpha + bottom.r * (1 - clampedAlpha)),
		g: clampChannel(top.g * clampedAlpha + bottom.g * (1 - clampedAlpha)),
		b: clampChannel(top.b * clampedAlpha + bottom.b * (1 - clampedAlpha)),
	};
}

export function rgbTo256(rgb: RgbColor): number {
	const rIdx = findClosestIndex(rgb.r, CUBE_VALUES);
	const gIdx = findClosestIndex(rgb.g, CUBE_VALUES);
	const bIdx = findClosestIndex(rgb.b, CUBE_VALUES);
	const cubeRgb = { r: CUBE_VALUES[rIdx], g: CUBE_VALUES[gIdx], b: CUBE_VALUES[bIdx] };
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(rgb, cubeRgb);

	const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
	const grayIdx = findClosestIndex(gray, GRAY_VALUES);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayRgb = { r: grayValue, g: grayValue, b: grayValue };
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(rgb, grayRgb);

	const maxChannel = Math.max(rgb.r, rgb.g, rgb.b);
	const minChannel = Math.min(rgb.r, rgb.g, rgb.b);
	if (maxChannel - minChannel < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

export function bestAnsiColor(rgb: RgbColor, mode: TerminalColorMode): string | number {
	if (mode === "truecolor") {
		return rgbToHex(rgb);
	}
	if (mode === "256color") {
		return rgbTo256(rgb);
	}
	return "";
}

export function detectBackgroundFromColorFgBg(
	value: string | undefined = process.env.COLORFGBG,
): TerminalBackgroundKind | undefined {
	if (!value) {
		return undefined;
	}
	const parts = value.split(";");
	if (parts.length < 2) {
		return undefined;
	}
	const bg = parseInt(parts[1], 10);
	if (Number.isNaN(bg)) {
		return undefined;
	}
	return bg < 8 ? "dark" : "light";
}

export function getDefaultTerminalColors(): DefaultTerminalColors | undefined {
	return defaultTerminalColors;
}

export function setDefaultTerminalColors(colors: DefaultTerminalColors | undefined): void {
	defaultTerminalColors = colors;
	notifyDefaultColorListeners();
}

export function clearDefaultTerminalColors(): void {
	setDefaultTerminalColors(undefined);
}

export function getTerminalBackgroundKind(): TerminalBackgroundKind | undefined {
	const bg = defaultTerminalColors?.background;
	if (bg) {
		return isLightColor(bg) ? "light" : "dark";
	}
	return detectBackgroundFromColorFgBg();
}

export function onDefaultTerminalColorsChange(listener: () => void): () => void {
	defaultColorListeners.add(listener);
	return () => {
		defaultColorListeners.delete(listener);
	};
}
