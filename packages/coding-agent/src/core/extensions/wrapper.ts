/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Either a runner instance or a getter resolved at execute time. A getter lets a wrapped tool
 * follow a session rebuild or extension reload: the runner captured at wrap time is invalidated
 * by the replacement and every later call through it fails its stale-ctx guard.
 */
export type RunnerSource = ExtensionRunner | (() => ExtensionRunner);

function toRunnerGetter(source: RunnerSource): () => ExtensionRunner {
	return typeof source === "function" ? source : () => source;
}

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: RunnerSource): AgentTool {
	const getRunner = toRunnerGetter(runner);
	const tool = wrapToolDefinition(registeredTool.definition, () => getRunner().createContext());
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			// One resolution per call: the before/after sets must come from the same runner.
			const runner = getRunner();
			const activeBefore = runner.getActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: RunnerSource): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
