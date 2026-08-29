import type { ContextUsage } from "./extensions/index.ts";

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	/** Set only when the session lives outside the default directory, so a resume hint can name it. */
	sessionDir?: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}
