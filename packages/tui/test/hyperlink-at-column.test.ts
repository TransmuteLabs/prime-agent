import assert from "node:assert";
import { describe, it } from "node:test";
import { getOsc8LinkAtColumn, urlAtColumn } from "../src/utils.ts";

const ST = "\x1b\\";

function link(url: string, text: string, terminator = ST): string {
	return `\x1b]8;;${url}${terminator}${text}\x1b]8;;${terminator}`;
}

describe("getOsc8LinkAtColumn and urlAtColumn", () => {
	it("returns the URL for columns inside the link and nothing outside", () => {
		const line = `see ${link("https://example.com/docs", "docs")} here`;
		assert.strictEqual(getOsc8LinkAtColumn(line, 0), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 3), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 4), "https://example.com/docs");
		assert.strictEqual(getOsc8LinkAtColumn(line, 7), "https://example.com/docs");
		assert.strictEqual(getOsc8LinkAtColumn(line, 8), undefined);
	});

	it("supports BEL-terminated links", () => {
		const line = link("https://example.com/login", "https://example.com/login", "\x07");
		assert.strictEqual(getOsc8LinkAtColumn(line, 0), "https://example.com/login");
		assert.strictEqual(getOsc8LinkAtColumn(line, 24), "https://example.com/login");
		assert.strictEqual(getOsc8LinkAtColumn(line, 25), undefined);
	});

	it("tracks multiple links on one line", () => {
		const line = `${link("https://a.example", "aa")} ${link("https://b.example", "bb")}`;
		assert.strictEqual(getOsc8LinkAtColumn(line, 1), "https://a.example");
		assert.strictEqual(getOsc8LinkAtColumn(line, 2), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 3), "https://b.example");
	});

	it("detects bare http URLs when OSC 8 metadata is absent", () => {
		const line = "visit https://example.com/docs, then continue";
		assert.strictEqual(urlAtColumn(line, 6), "https://example.com/docs");
		assert.strictEqual(urlAtColumn(line, 29), "https://example.com/docs");
		assert.strictEqual(urlAtColumn(line, 30), undefined);
	});

	it("does not include trailing prose punctuation in bare URLs", () => {
		const line = "open (https://example.com/path).";
		assert.strictEqual(urlAtColumn(line, 7), "https://example.com/path");
		assert.strictEqual(urlAtColumn(line, 30), undefined);
	});

	it("prefers an OSC 8 target over a URL-like label", () => {
		const line = link("https://target.example", "https://label.example");
		assert.strictEqual(urlAtColumn(line, 10), "https://target.example");
	});

	it("resolves a link after its painted tab expansion", () => {
		const line = `   ${link("https://example.com", "docs")}`;
		assert.strictEqual(getOsc8LinkAtColumn(line, 2), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 3), "https://example.com");
		assert.strictEqual(getOsc8LinkAtColumn(line, 6), "https://example.com");
	});

	it("counts wide graphemes as two columns", () => {
		const line = `\u4f60\u597d ${link("https://example.com", "docs")}`;
		assert.strictEqual(getOsc8LinkAtColumn(line, 4), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 5), "https://example.com");
	});

	it("ignores SGR styling inside the link", () => {
		const line = `x ${link("https://example.com", "\x1b[36mdocs\x1b[39m")}`;
		assert.strictEqual(getOsc8LinkAtColumn(line, 3), "https://example.com");
	});

	it("returns nothing past the end of the line and for negative columns", () => {
		const line = link("https://example.com", "docs");
		assert.strictEqual(getOsc8LinkAtColumn(line, 4), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, 100), undefined);
		assert.strictEqual(getOsc8LinkAtColumn(line, -1), undefined);
	});
});
