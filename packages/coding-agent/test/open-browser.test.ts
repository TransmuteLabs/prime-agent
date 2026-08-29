import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => ({
		on: vi.fn().mockReturnThis(),
		unref: vi.fn(),
	})),
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

const { openBrowser } = await import("../src/utils/open-browser.ts");

describe("openBrowser", () => {
	beforeEach(() => {
		mocks.spawn.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["darwin", "open", []],
		["linux", "xdg-open", []],
		["win32", undefined, ["url.dll,FileProtocolHandler"]],
	] as const)("passes a hostile URL as a single argument on %s", (platform, expectedCmd, prefixArgs) => {
		vi.spyOn(process, "platform", "get").mockReturnValue(platform);
		const url = "https://example.com/oauth?state=$(touch /tmp/pwned);whoami&pipe=|id";

		openBrowser(url);

		const command = expectedCmd ?? `${process.env.SystemRoot ?? String.raw`C:\Windows`}\\System32\\rundll32.exe`;
		expect(mocks.spawn).toHaveBeenCalledWith(command, [...prefixArgs, url], {
			stdio: "ignore",
			detached: true,
		});
	});

	it("resolves rundll32 under SystemRoot rather than through PATH", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = String.raw`D:\Win`;
		try {
			openBrowser("https://example.com/");
		} finally {
			if (originalSystemRoot === undefined) {
				delete process.env.SystemRoot;
			} else {
				process.env.SystemRoot = originalSystemRoot;
			}
		}

		const [command] = mocks.spawn.mock.lastCall ?? [];
		expect(command).toBe(String.raw`D:\Win\System32\rundll32.exe`);
	});

	it("survives a launcher that cannot be started", () => {
		const handlers: Array<(error: Error) => void> = [];
		mocks.spawn.mockReturnValueOnce({
			on: vi.fn((event: string, handler: (error: Error) => void) => {
				if (event === "error") handlers.push(handler);
				return { unref: vi.fn() };
			}),
			unref: vi.fn(),
		} as never);

		openBrowser("https://example.com/");

		expect(handlers).toHaveLength(1);
		expect(() => handlers[0]?.(new Error("spawn xdg-open ENOENT"))).not.toThrow();
	});
});
