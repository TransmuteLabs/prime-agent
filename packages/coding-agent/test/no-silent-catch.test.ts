import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EMPTY_CATCH = /catch(\s*\([^)]*\))?\s*\{\s*\}/g;

/**
 * Blank out the contents of string, template and regex literals, preserving offsets so the
 * reported line numbers stay accurate. Without this a `catch {}` inside a shell snippet passed
 * as a string is reported as source code.
 */
function blankNonCode(content: string): string {
	const out = content.split("");
	const blank = (start: number, end: number) => {
		for (let i = start; i < end && i < out.length; i++) {
			if (out[i] !== "\n") out[i] = " ";
		}
	};
	// A slash opens a regex only where a value may start; after a value it is division.
	const regexAllowedBefore = /[(,=:[!&|?{};+\-*%~^]/;
	let lastMeaningful = "";
	let i = 0;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];
		// Comments are skipped, not blanked: the explanatory comment is exactly what makes a
		// catch block non-empty, so removing it would report every documented site.
		if (ch === "/" && next === "/") {
			const end = content.indexOf("\n", i);
			i = end === -1 ? content.length : end;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = content.indexOf("*/", i + 2);
			i = end === -1 ? content.length : end + 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < content.length) {
				if (content[j] === "\\") {
					j += 2;
					continue;
				}
				if (content[j] === ch) break;
				// A template literal ends at its backtick; `${}` holes may themselves contain
				// strings, but blanking them wholesale only hides code that is not a catch site.
				if (ch !== "`" && content[j] === "\n") break;
				j++;
			}
			blank(i + 1, j);
			i = j + 1;
			lastMeaningful = ch;
			continue;
		}
		if (ch === "/" && (lastMeaningful === "" || regexAllowedBefore.test(lastMeaningful))) {
			let j = i + 1;
			let inClass = false;
			let closed = false;
			while (j < content.length && content[j] !== "\n") {
				if (content[j] === "\\") {
					j += 2;
					continue;
				}
				if (content[j] === "[") inClass = true;
				else if (content[j] === "]") inClass = false;
				else if (content[j] === "/" && !inClass) {
					closed = true;
					break;
				}
				j++;
			}
			if (closed) {
				blank(i + 1, j);
				i = j + 1;
				lastMeaningful = "/";
				continue;
			}
		}
		if (!/\s/.test(ch)) lastMeaningful = ch;
		i++;
	}
	return out.join("");
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") collectTsFiles(full, out);
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("no silent catch blocks", () => {
	test("every empty catch in packages/*/src carries an explanatory comment", () => {
		const srcDirs = readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(REPO_ROOT, "packages", e.name, "src"));

		const offenders: string[] = [];
		for (const srcDir of srcDirs) {
			let files: string[];
			try {
				files = collectTsFiles(srcDir);
			} catch {
				// Package without a src dir.
				continue;
			}
			for (const file of files) {
				const content = blankNonCode(readFileSync(file, "utf-8"));
				for (const match of content.matchAll(EMPTY_CATCH)) {
					const line = content.slice(0, match.index).split("\n").length;
					offenders.push(`${relative(REPO_ROOT, file)}:${line}`);
				}
			}
		}

		expect(
			offenders,
			`Empty catch blocks swallow errors silently. Log the error (getLogger from @earendil-works/pi-ai) or add a comment inside the block explaining why ignoring it is safe:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
