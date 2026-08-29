import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import type { ResumeHintStats } from "../../../src/modes/interactive/resume-hint.ts";

// Regression for https://github.com/earendil-works/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (agentConnection.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	agentConnection: { dispose: () => Promise<void>; getSessionStats: () => Promise<ResumeHintStats | undefined> };
	options: { onShutdown?: () => Promise<void> };
	clearCtrlCExitHint: (options: { render?: boolean }) => void;
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	stop: () => void;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {}

function createStats(sessionFile: string): ResumeHintStats {
	return { sessionId: "test-session", sessionFile, userMessages: 1 };
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionStats?: ResumeHintStats): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		agentConnection: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
			getSessionStats: vi.fn(async () => sessionStats),
		},
		options: {},
		clearCtrlCExitHint: vi.fn(),
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		stop: vi.fn(() => {
			order.push("stop");
		}),
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createStats(createTempFile()));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(log.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`Resume this session with: ${APP_NAME} --resume test-session`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createStats(createTempFile()));

		await callShutdown(context, { fromSignal: true });

		for (const call of log.mock.calls) {
			expect(String(call[0])).not.toContain("Resume this session with:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.agentConnection.dispose).not.toHaveBeenCalled();
	});
});
