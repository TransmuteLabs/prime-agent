import { existsSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME } from "../../config.ts";
import type { SessionStats } from "../../core/session-stats.ts";

export type ResumeHintStats = Pick<SessionStats, "sessionId" | "sessionFile" | "sessionDir" | "userMessages">;

/** Shell-safe single quoting: double quotes would leave $, ` and \ live in the resumed command. */
function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Omit ephemeral and unflushed empty sessions because neither can be resumed. */
export function formatResumeHint(stats: ResumeHintStats | undefined): string | undefined {
	// The hint addresses a human at a terminal; a redirected stdout is a consumer of output.
	if (!process.stdout.isTTY) return undefined;
	if (!stats?.sessionFile || stats.userMessages === 0) return undefined;
	// Persistence is lazy: nothing is written until the first assistant message
	// arrives, so exiting before then leaves no file to resume from.
	if (!existsSync(stats.sessionFile)) return undefined;
	// A session outside the default directory is not findable by id alone.
	const sessionDir = stats.sessionDir ? ` --session-dir ${quoteIfNeeded(stats.sessionDir)}` : "";
	return chalk.dim(`Resume this session with: ${APP_NAME}${sessionDir} --resume ${stats.sessionId}`);
}
