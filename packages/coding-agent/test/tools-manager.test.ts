import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolState = vi.hoisted(() => ({
	toolsDir: `/tmp/prime-agent-tools-manager-${process.pid}`,
	platform: "linux",
	architecture: "x64",
}));

vi.mock("../src/config.ts", () => ({
	APP_NAME: "prime-agent",
	getBinDir: () => toolState.toolsDir,
}));

vi.mock("os", () => ({
	arch: () => toolState.architecture,
	platform: () => toolState.platform,
}));

import {
	ensureTool,
	ensureToolWithStatus,
	formatMissingRipgrepMessage,
	getToolPath,
	type ToolStatus,
	type ToolUnavailableResult,
} from "../src/utils/tools-manager.ts";

const originalPath = process.env.PATH;
const originalOffline = process.env.PI_OFFLINE;
const pathDir = join(toolState.toolsDir, "path");
const systemTar = ["/usr/bin/tar", "/bin/tar"].find((candidate) => existsSync(candidate)) ?? "tar";

// Builds the archive shape the downloader actually consumes, so the extraction
// path is exercised rather than stubbed out.
function tarGzWith(binaryName: string, exitCode: number, toolsDir: string): Uint8Array {
	const stageDir = join(toolsDir, "stage");
	mkdirSync(stageDir, { recursive: true });
	writeExecutable(join(stageDir, binaryName), exitCode);
	const archivePath = join(toolsDir, "fixture.tar.gz");
	const result = spawnSync(systemTar, ["czf", archivePath, "-C", stageDir, binaryName]);
	if (result.status !== 0) {
		throw new Error(`fixture tar failed: ${result.stderr?.toString() ?? result.error?.message}`);
	}
	const bytes = readFileSync(archivePath);
	rmSync(archivePath, { force: true });
	rmSync(stageDir, { recursive: true, force: true });
	// The downloader shells out to tar, and this suite deliberately empties PATH to
	// control tool discovery. Expose that one command instead of reopening PATH,
	// which would let a real system rg/fd satisfy the lookups under test.
	writeFileSync(join(pathDir, "tar"), `#!/bin/sh\nexec ${systemTar} "$@"\n`, "utf8");
	chmodSync(join(pathDir, "tar"), 0o755);
	return bytes;
}

function writeExecutable(filePath: string, exitCode = 0): void {
	writeFileSync(filePath, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
	chmodSync(filePath, 0o755);
}

function unavailable(
	platform: string,
	reason: ToolUnavailableResult["reason"] = "download_failed",
): ToolUnavailableResult {
	return { status: "unavailable", reason, platform, architecture: "x64" };
}

describe("tools manager", () => {
	beforeEach(() => {
		rmSync(toolState.toolsDir, { recursive: true, force: true });
		mkdirSync(pathDir, { recursive: true });
		process.env.PATH = pathDir;
		delete process.env.PI_OFFLINE;
		toolState.platform = "linux";
		toolState.architecture = "x64";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		rmSync(toolState.toolsDir, { recursive: true, force: true });
	});

	it("accepts managed and PATH tools only when their version check succeeds", () => {
		const managedPath = join(toolState.toolsDir, "rg");
		writeExecutable(managedPath);
		expect(getToolPath("rg")).toBe(managedPath);

		writeExecutable(managedPath, 1);
		const pathBinary = join(pathDir, "rg");
		writeExecutable(pathBinary);
		expect(getToolPath("rg")).toBe("rg");

		writeExecutable(pathBinary, 1);
		expect(getToolPath("rg")).toBeNull();
	});

	it("reports offline and Termux provisioning constraints", async () => {
		process.env.PI_OFFLINE = "1";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "offline",
			platform: "linux",
		});

		delete process.env.PI_OFFLINE;
		toolState.platform = "android";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "manual_install_required",
			platform: "android",
		});
	});

	it("distinguishes unsupported targets from download failures", async () => {
		toolState.platform = "freebsd";
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "unsupported_platform",
		});

		toolState.platform = "linux";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("network unavailable"))),
		);
		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "download_failed",
			detail: "network unavailable",
		});
	});

	it("validates a downloaded binary before reporting it available", async () => {
		toolState.platform = "linux";
		writeExecutable(join(toolState.toolsDir, "rg"), 1);
		const archive = tarGzWith("rg", 0, toolState.toolsDir);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ tag_name: "15.1.0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(archive, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(ensureToolWithStatus("rg")).resolves.toEqual({
			status: "available",
			path: join(toolState.toolsDir, "rg"),
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("removes a downloaded binary that fails its version check", async () => {
		toolState.platform = "linux";
		const archive = tarGzWith("rg", 1, toolState.toolsDir);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response(JSON.stringify({ tag_name: "15.1.0" }), { status: 200 }))
				.mockResolvedValueOnce(new Response(archive, { status: 200 })),
		);

		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
			status: "unavailable",
			reason: "download_failed",
		});
		expect(existsSync(join(toolState.toolsDir, "rg"))).toBe(false);
	});

	it("formats actionable platform-specific ripgrep warnings", () => {
		const mac = formatMissingRipgrepMessage(unavailable("darwin"));
		const linux = formatMissingRipgrepMessage(unavailable("linux"));
		const windows = formatMissingRipgrepMessage(unavailable("win32"));
		const termux = formatMissingRipgrepMessage(unavailable("android", "manual_install_required"));

		expect(mac).toContain("brew install ripgrep");
		expect(linux).toContain("sudo apt install ripgrep");
		expect(linux).toContain("sudo dnf install ripgrep");
		expect(windows).toContain("winget install BurntSushi.ripgrep.MSVC");
		expect(termux).toContain("pkg install ripgrep");
		expect(mac).toContain("Prime Agent and subagents remain available");
	});
});

describe("ensureTool", () => {
	beforeEach(() => {
		rmSync(toolState.toolsDir, { recursive: true, force: true });
		mkdirSync(pathDir, { recursive: true });
		process.env.PATH = pathDir;
		delete process.env.PI_OFFLINE;
		toolState.platform = "linux";
		toolState.architecture = "x64";
	});

	afterEach(() => {
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		rmSync(toolState.toolsDir, { recursive: true, force: true });
	});

	it("reports status through a callback without writing to the console", async () => {
		process.env.PI_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});
});
