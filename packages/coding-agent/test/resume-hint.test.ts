import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { formatResumeHint } from "../src/modes/interactive/resume-hint.ts";

const SESSION_ID = "0196c2e4-7f01-7abc-8def-0123456789ab";

const sessionDir = mkdtempSync(join(tmpdir(), "resume-hint-test-"));
const existingSessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
writeFileSync(existingSessionFile, `{"type":"session","id":"${SESSION_ID}"}\n`);

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

afterEach(() => {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
});

afterAll(() => {
	rmSync(sessionDir, { recursive: true, force: true });
});

describe("formatResumeHint", () => {
	test("returns hint with --resume and the session id for a persisted session", () => {
		setStdoutIsTTY(true);
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			userMessages: 3,
		});
		expect(hint).toBeDefined();
		expect(hint).toContain(`${APP_NAME} --resume ${SESSION_ID}`);
	});

	test("names a non-default session directory the id alone could not reach", () => {
		setStdoutIsTTY(true);
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			sessionDir: "/tmp/custom-pi-sessions",
			userMessages: 3,
		});
		expect(hint).toContain(`${APP_NAME} --session-dir /tmp/custom-pi-sessions --resume ${SESSION_ID}`);
	});

	test("quotes a session directory containing spaces", () => {
		setStdoutIsTTY(true);
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			sessionDir: "/tmp/custom pi sessions",
			userMessages: 3,
		});
		expect(hint).toContain(`--session-dir '/tmp/custom pi sessions' --resume`);
	});

	test("quotes a session directory containing single quotes", () => {
		setStdoutIsTTY(true);
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			sessionDir: "/tmp/custom pi's sessions",
			userMessages: 3,
		});
		expect(hint).toContain(`--session-dir '/tmp/custom pi'\\''s sessions' --resume`);
	});

	test("returns undefined for an in-memory session", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: undefined,
			userMessages: 3,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when the session has no user messages", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: existingSessionFile,
			userMessages: 0,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when the session file was never flushed to disk", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: join(sessionDir, "never-written.jsonl"),
			userMessages: 1,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when stats are unavailable", () => {
		expect(formatResumeHint(undefined)).toBeUndefined();
	});

	test("returns undefined when stdout is redirected", () => {
		setStdoutIsTTY(false);
		expect(
			formatResumeHint({
				sessionId: SESSION_ID,
				sessionFile: existingSessionFile,
				userMessages: 3,
			}),
		).toBeUndefined();
	});
});
