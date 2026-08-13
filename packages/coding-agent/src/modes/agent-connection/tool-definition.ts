import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { AgentConnectionToolDefinition } from "./types.ts";

export function createAgentConnectionToolDefinition(
	definition: ToolDefinition | undefined,
): AgentConnectionToolDefinition | undefined {
	if (!definition) {
		return undefined;
	}

	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		...(definition.promptSnippet !== undefined ? { promptSnippet: definition.promptSnippet } : {}),
		...(definition.promptGuidelines !== undefined ? { promptGuidelines: [...definition.promptGuidelines] } : {}),
		parameters: definition.parameters,
		...(definition.renderShell !== undefined ? { renderShell: definition.renderShell } : {}),
		...("replayBuiltInToolName" in definition && definition.replayBuiltInToolName !== undefined
			? { replayBuiltInToolName: String(definition.replayBuiltInToolName) }
			: {}),
	};
}
