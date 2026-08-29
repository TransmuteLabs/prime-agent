import { extractAnsiCode, visibleWidth } from "./utils.ts";

/**
 * Table geometry travels from the markdown renderer to the viewport in-band, as zero-width APC
 * markers embedded in the rendered lines (the mechanism `CURSOR_MARKER` already uses). Components
 * strip their own markers and hand the extracted regions up through `Component.getSelectionRegions`,
 * so no marker ever reaches the terminal.
 */
const TABLE_MARKER_PREFIX = "\x1b_pi:table:";
const TABLE_START_MARKER = `${TABLE_MARKER_PREFIX}start\x07`;
const TABLE_END_MARKER = `${TABLE_MARKER_PREFIX}end\x07`;

/** One physical run of a logical table cell on one rendered line. */
export interface TableCellSelectionRegion {
	line: number;
	col: number;
	width: number;
	/** Identity of the table this cell belongs to; stable across re-renders of the same component. */
	table: object;
	tableTop: number;
	tableBottom: number;
	tableLeft: number;
	tableRight: number;
	row: number;
	column: number;
	/** Index of this physical run within the logical cell, for cells wrapped over several lines. */
	segment: number;
	/** Unwrapped cell text, carried on segment 0 and copied onto every region of the cell. */
	content: string;
}

/** A logical cell address inside one table. */
export interface TableCellPosition {
	row: number;
	column: number;
}

/** An inclusive rectangle of logical cells. */
export interface TableCellRange {
	fromRow: number;
	toRow: number;
	fromColumn: number;
	toColumn: number;
}

interface CellMarker {
	kind: "cell-start" | "cell-end";
	row: number;
	column: number;
	segment: number;
	content?: string;
}

interface TableBounds {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

function cellMarker(kind: CellMarker["kind"], row: number, column: number, segment: number, content?: string): string {
	const encodedContent = content === undefined ? "" : `:${encodeURIComponent(content)}`;
	return `${TABLE_MARKER_PREFIX}${kind}:${row}:${column}:${segment}${encodedContent}\x07`;
}

function parseCellMarker(code: string): CellMarker | null {
	if (!code.startsWith(TABLE_MARKER_PREFIX) || !code.endsWith("\x07")) return null;
	const [kind, rowText, columnText, segmentText, encodedContent] = code
		.slice(TABLE_MARKER_PREFIX.length, -1)
		.split(":");
	if (kind !== "cell-start" && kind !== "cell-end") return null;
	// Rendered documents are attacker-influenced and can carry a forged marker verbatim, so every
	// field is validated: Number("") is 0, and decodeURIComponent throws on invalid escapes.
	if (!rowText || !columnText || !segmentText) return null;
	const row = Number(rowText);
	const column = Number(columnText);
	const segment = Number(segmentText);
	if (![row, column, segment].every(Number.isInteger)) return null;
	let content: string | undefined;
	if (encodedContent !== undefined) {
		try {
			content = decodeURIComponent(encodedContent);
		} catch {
			return null;
		}
	}
	return { kind, row, column, segment, content };
}

/** Mark the line that opens a table (its top border). */
export function markTableStart(line: string): string {
	return TABLE_START_MARKER + line;
}

/** Mark the line that closes a table (its bottom border). */
export function markTableEnd(line: string): string {
	return line + TABLE_END_MARKER;
}

/** Wrap one physical run of a logical cell. The unwrapped `content` rides on segment 0. */
export function markTableCell(text: string, row: number, column: number, segment: number, content: string): string {
	const markerContent = segment === 0 ? content : undefined;
	return (
		cellMarker("cell-start", row, column, segment, markerContent) +
		text +
		cellMarker("cell-end", row, column, segment)
	);
}

/**
 * Strip the table markers from `lines` and return the cell regions they delimit, in the
 * coordinate space of `lines` itself. `getTableIdentity` supplies the identity object for the
 * nth table of the document; a component keeps those objects across renders so a selection
 * survives re-rendering.
 */
export function extractTableCellSelectionRegions(
	lines: string[],
	getTableIdentity: (index: number) => object,
): { lines: string[]; regions: TableCellSelectionRegion[] } {
	if (!lines.some((line) => line.includes(TABLE_MARKER_PREFIX))) {
		return { lines, regions: [] };
	}

	const cleanLines: string[] = [];
	const regions: TableCellSelectionRegion[] = [];
	const cellContents = new Map<object, Map<string, string>>();
	const tableBounds = new Map<object, TableBounds>();
	let table: object | null = null;
	let tableIndex = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const source = lines[lineIndex];
		if (!source.includes(TABLE_MARKER_PREFIX)) {
			cleanLines.push(source);
			continue;
		}
		let clean = "";
		let activeCell: (CellMarker & { col: number }) | null = null;
		let offset = 0;

		while (offset < source.length) {
			const ansi = extractAnsiCode(source, offset);
			if (!ansi) {
				clean += source[offset];
				offset++;
				continue;
			}

			if (ansi.code === TABLE_START_MARKER) {
				table = getTableIdentity(tableIndex++);
				const col = visibleWidth(clean);
				tableBounds.set(table, { top: lineIndex, bottom: lineIndex, left: col, right: col });
			} else if (ansi.code === TABLE_END_MARKER) {
				if (table) {
					const bounds = tableBounds.get(table);
					if (bounds) {
						bounds.bottom = lineIndex;
						bounds.right = visibleWidth(clean);
					}
				}
				table = null;
				activeCell = null;
			} else {
				const marker = parseCellMarker(ansi.code);
				if (marker?.kind === "cell-start") {
					activeCell = { ...marker, col: visibleWidth(clean) };
					if (table && marker.content !== undefined) {
						let tableContents = cellContents.get(table);
						if (!tableContents) {
							tableContents = new Map();
							cellContents.set(table, tableContents);
						}
						tableContents.set(`${marker.row}:${marker.column}`, marker.content);
					}
				} else if (marker?.kind === "cell-end") {
					const width = activeCell ? visibleWidth(clean) - activeCell.col : 0;
					if (
						table &&
						activeCell &&
						width > 0 &&
						marker.row === activeCell.row &&
						marker.column === activeCell.column &&
						marker.segment === activeCell.segment
					) {
						regions.push({
							line: lineIndex,
							col: activeCell.col,
							width,
							table,
							tableTop: 0,
							tableBottom: 0,
							tableLeft: 0,
							tableRight: 0,
							row: marker.row,
							column: marker.column,
							segment: marker.segment,
							content: "",
						});
					}
					activeCell = null;
				} else {
					clean += ansi.code;
				}
			}
			offset += ansi.length;
		}
		cleanLines.push(clean);
	}
	for (const region of regions) {
		const bounds = tableBounds.get(region.table);
		if (bounds) {
			region.tableTop = bounds.top;
			region.tableBottom = bounds.bottom;
			region.tableLeft = bounds.left;
			region.tableRight = bounds.right;
		}
		region.content = cellContents.get(region.table)?.get(`${region.row}:${region.column}`) ?? "";
	}

	return { lines: cleanLines, regions };
}

/** Shift regions by a line and column offset, for a parent that repositions a child's lines. */
export function offsetTableCellSelectionRegions(
	regions: ReadonlyArray<TableCellSelectionRegion>,
	lineOffset: number,
	columnOffset: number,
): TableCellSelectionRegion[] {
	if (regions.length === 0) return [];
	return regions.map((region) => ({
		...region,
		line: region.line + lineOffset,
		col: region.col + columnOffset,
		tableTop: region.tableTop + lineOffset,
		tableBottom: region.tableBottom + lineOffset,
		tableLeft: region.tableLeft + columnOffset,
		tableRight: region.tableRight + columnOffset,
	}));
}

/** The table containing `point`, if any. The left border column counts as inside. */
export function tableAtPoint(
	regions: ReadonlyArray<TableCellSelectionRegion>,
	point: { row: number; col: number },
): object | undefined {
	for (const region of regions) {
		if (
			point.row >= region.tableTop &&
			point.row <= region.tableBottom &&
			point.col >= Math.max(0, region.tableLeft - 1) &&
			point.col <= region.tableRight
		) {
			return region.table;
		}
	}
	return undefined;
}

/** The cell of `table` nearest to `point`: nearest line first, then nearest column. */
export function closestTableCell(
	regions: ReadonlyArray<TableCellSelectionRegion>,
	table: object,
	point: { row: number; col: number },
): TableCellPosition | undefined {
	let closest: TableCellPosition | undefined;
	let closestLineDistance = Number.POSITIVE_INFINITY;
	let closestColumnDistance = Number.POSITIVE_INFINITY;
	for (const region of regions) {
		if (region.table !== table) continue;
		const lineDistance = Math.abs(point.row - region.line);
		const end = region.col + region.width;
		const columnDistance = point.col < region.col ? region.col - point.col : point.col > end ? point.col - end : 0;
		if (
			lineDistance < closestLineDistance ||
			(lineDistance === closestLineDistance && columnDistance < closestColumnDistance)
		) {
			closest = { row: region.row, column: region.column };
			closestLineDistance = lineDistance;
			closestColumnDistance = columnDistance;
		}
	}
	return closest;
}

/** The inclusive cell rectangle spanned by two cell addresses. */
export function tableCellRange(anchor: TableCellPosition, head: TableCellPosition): TableCellRange {
	return {
		fromRow: Math.min(anchor.row, head.row),
		toRow: Math.max(anchor.row, head.row),
		fromColumn: Math.min(anchor.column, head.column),
		toColumn: Math.max(anchor.column, head.column),
	};
}
