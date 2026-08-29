import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createAllToolDefinitions } from "../../../src/core/tools/index.ts";

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-remove-legacy-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers ipython beside the opt-in upstream built-ins", () => {
		// The default agent surface is ipython alone (asserted below); pi's file and shell
		// tools stay registered so a caller can still request them with --tools.
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual([
			"read",
			"bash",
			"powershell",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"ipython",
		]);
	});

	it("keeps legacy names available for extension and custom tool allowlists", () => {
		const result = parseArgs(["--tools", "bash,edit,ipython"]);

		expect(result.tools).toEqual(["bash", "edit", "ipython"]);
		expect(result.diagnostics).toEqual([]);
	});

	it("activates ipython alone when no tools are requested", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		await session.bindExtensions({});

		expect(session.getActiveToolNames()).toEqual(["ipython"]);
		session.dispose();
	});

	it("activates exactly the built-in tool names that are requested", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash", "edit"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["bash", "edit"]);
		expect(session.getActiveToolNames()).toEqual(["bash", "edit"]);
		session.dispose();
	});

	it("allowlists an extension tool that reuses a legacy built-in name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "bash",
							label: "Custom Bash",
							description: "Tool registered from session_start",
							promptSnippet: "Run custom shell behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["bash"]);
		expect(session.getActiveToolNames()).toEqual(["bash"]);
		session.dispose();
	});

	it("applies shell settings to bash() commands in the REPL", async () => {
		const shellPath = join(tempDir, "custom-shell.sh");
		writeFileSync(shellPath, "#!/bin/sh\nprintf 'custom-shell\\n'\nexec /bin/sh \"$@\"\n");
		chmodSync(shellPath, 0o755);

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setShellCommandPrefix("echo prefix-from-settings");
		settingsManager.setShellPath(shellPath);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getBuiltinModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["ipython"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(["ipython"]);
			const ipythonTool = session.agent.state.tools.find((tool) => tool.name === "ipython");
			expect(ipythonTool).toBeTruthy();

			// %%bash cells fail as plain Python syntax errors instead of running.
			const rejected = await ipythonTool!.execute("tool-0", { code: "%%bash\necho body" });
			expect(rejected.details).toMatchObject({ status: "error" });
			const rejectedText = rejected.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("");
			expect(rejectedText).toContain("SyntaxError");

			// bash() picks up the configured shell and command prefix from the tool environment.
			const result = await ipythonTool!.execute("tool-1", {
				code: "print((await bash('echo body')).output)",
			});
			const output = result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("");
			expect(output).toContain("custom-shell\nprefix-from-settings\nbody");
		} finally {
			await session.disposeAsync();
		}
	}, 120_000);
});
