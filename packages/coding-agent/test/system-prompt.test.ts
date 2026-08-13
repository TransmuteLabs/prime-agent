import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("RLM doctrine (default branch)", () => {
		test("includes IPython control and rlm spawn guidance when ipython is active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				contextFiles: [],
				skills: [],
				cwd: "/x",
				messagesPath: "/x/messages.jsonl",
				allowRecursion: true,
			});

			expect(prompt).toContain("IPython is the agent's long-lived notebook");
			expect(prompt).toContain("await rlm('sub-task')");
			expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
			expect(prompt).toContain("Working directory: /x");
			expect(prompt).toContain("# Delegating to sub-agents");
		});

		test("omits subagent guidance when recursion is disabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				contextFiles: [],
				skills: [],
				cwd: "/x",
				allowRecursion: false,
			});

			expect(prompt).toContain("IPython is the agent's long-lived notebook");
			expect(prompt).not.toContain("# Delegating to sub-agents");
		});

		test("includes child agent doctrine when depth > 0", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				contextFiles: [],
				skills: [],
				cwd: "/x",
				rlmDepth: 1,
				rlmParentAgent: "root-agent",
			});

			expect(prompt).toContain("You are a child agent spawned by root-agent");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines under Additional Guidance", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("# Additional Guidance");
			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("project context and append", () => {
		test("preserves pi project_context XML and appendSystemPrompt", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["ipython"],
				contextFiles: [{ path: "AGENTS.md", content: "Be careful." }],
				skills: [],
				cwd: "/x",
				appendSystemPrompt: "EXTRA APPEND",
			});

			expect(prompt).toContain("<project_context>");
			expect(prompt).toContain('<project_instructions path="AGENTS.md">');
			expect(prompt).toContain("Be careful.");
			expect(prompt).toContain("EXTRA APPEND");
		});
	});
});
