import assert from "node:assert";
import { describe, it } from "node:test";
import {
	extractTableCellSelectionRegions,
	markTableCell,
	markTableEnd,
	markTableStart,
	offsetTableCellSelectionRegions,
	tableAtPoint,
} from "../src/selection-metadata.ts";

const identity = () => {
	const tables: object[] = [];
	return (index: number) => {
		tables[index] ??= {};
		return tables[index];
	};
};

function tableLines(): string[] {
	return [
		markTableStart("┌───────┬───────┐"),
		`│ ${markTableCell("Name ", 0, 0, 0, "Name")} │ ${markTableCell("Score", 0, 1, 0, "Score")} │`,
		"├───────┼───────┤",
		`│ ${markTableCell("Avery", 1, 0, 0, "Avery")} │ ${markTableCell("87   ", 1, 1, 0, "87")} │`,
		markTableEnd("└───────┴───────┘"),
	];
}

describe("table selection metadata", () => {
	it("extracts cell geometry and strips every marker", () => {
		const { lines, regions } = extractTableCellSelectionRegions(tableLines(), identity());

		assert.ok(
			lines.every((line) => !line.includes("\x1b_pi:table:")),
			"markers must not survive extraction",
		);
		assert.deepStrictEqual(lines[1], "│ Name  │ Score │");
		assert.strictEqual(regions.length, 4);
		assert.deepStrictEqual(
			regions.map((region) => ({
				line: region.line,
				col: region.col,
				width: region.width,
				content: region.content,
			})),
			[
				{ line: 1, col: 2, width: 5, content: "Name" },
				{ line: 1, col: 10, width: 5, content: "Score" },
				{ line: 3, col: 2, width: 5, content: "Avery" },
				{ line: 3, col: 10, width: 5, content: "87" },
			],
		);
		for (const region of regions) {
			assert.strictEqual(region.tableTop, 0);
			assert.strictEqual(region.tableBottom, 4);
			assert.strictEqual(region.tableLeft, 0);
			assert.strictEqual(region.tableRight, 17);
		}
	});

	it("keeps two tables of one document apart", () => {
		const source = [...tableLines(), "", ...tableLines()];
		const { regions } = extractTableCellSelectionRegions(source, identity());

		const first = regions.filter((region) => region.line < 6);
		const second = regions.filter((region) => region.line >= 6);
		assert.strictEqual(first.length, 4);
		assert.strictEqual(second.length, 4);
		assert.notStrictEqual(first[0].table, second[0].table);
		assert.ok(first.every((region) => region.table === first[0].table));
		assert.ok(second.every((region) => region.table === second[0].table));
		assert.deepStrictEqual([first[0].tableTop, first[0].tableBottom], [0, 4], "the first table keeps its own bounds");
		assert.deepStrictEqual(
			[second[0].tableTop, second[0].tableBottom],
			[6, 10],
			"the second table keeps its own bounds",
		);
		assert.strictEqual(tableAtPoint(regions, { row: 1, col: 3 }), first[0].table);
		assert.strictEqual(tableAtPoint(regions, { row: 7, col: 3 }), second[0].table);
		assert.strictEqual(tableAtPoint(regions, { row: 5, col: 3 }), undefined);
	});

	it("offsets cells and table bounds together", () => {
		const { regions } = extractTableCellSelectionRegions(tableLines(), identity());
		const moved = offsetTableCellSelectionRegions(regions, 7, 2);

		for (let i = 0; i < regions.length; i++) {
			assert.strictEqual(moved[i].line, regions[i].line + 7);
			assert.strictEqual(moved[i].col, regions[i].col + 2);
			assert.strictEqual(moved[i].tableTop, regions[i].tableTop + 7);
			assert.strictEqual(moved[i].tableBottom, regions[i].tableBottom + 7);
			assert.strictEqual(moved[i].tableLeft, regions[i].tableLeft + 2);
			assert.strictEqual(moved[i].tableRight, regions[i].tableRight + 2);
		}
		assert.strictEqual(tableAtPoint(moved, { row: 1, col: 3 }), undefined, "the old position is no longer a table");
		assert.strictEqual(tableAtPoint(moved, { row: 8, col: 5 }), moved[0].table);
	});

	// Rendered documents carry model-authored text, so a line can contain a byte sequence shaped
	// like one of our own markers.
	describe("forged markers", () => {
		it("rejects a marker whose content is not decodable instead of throwing", () => {
			const forged = "\x1b_pi:table:cell-start:0:0:0:%GG\x07";
			const { lines, regions } = extractTableCellSelectionRegions([`before${forged}after`], identity());

			assert.deepStrictEqual(regions, []);
			assert.deepStrictEqual(lines, [`before${forged}after`], "an unparsed marker is left as it was");
		});

		it("rejects markers with empty coordinate fields", () => {
			const forged = "\x1b_pi:table:cell-start:::\x07";
			const { regions } = extractTableCellSelectionRegions([`x${forged}y`], identity());

			assert.deepStrictEqual(regions, []);
		});

		it("does not emit an unmatched cell-end marker into the cleaned line", () => {
			const orphan = "\x1b_pi:table:cell-end:0:0:0\x07";
			const { lines, regions } = extractTableCellSelectionRegions(
				[markTableStart("┌───┐"), `│ text${orphan} │`, markTableEnd("└───┘")],
				identity(),
			);

			assert.deepStrictEqual(regions, []);
			assert.ok(
				lines.every((line) => !line.includes("\x1b_pi:table:")),
				"our own markers never reach the terminal, matched or not",
			);
		});

		it("ignores a cell-end that does not match the open cell", () => {
			const lines = [
				markTableStart("┌───┐"),
				`│ ${"\x1b_pi:table:cell-start:1:0:0:x\x07"}text${"\x1b_pi:table:cell-end:9:9:9\x07"} │`,
				markTableEnd("└───┘"),
			];
			const { regions } = extractTableCellSelectionRegions(lines, identity());

			assert.deepStrictEqual(regions, []);
		});
	});
});
