/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { createInterface } from "node:readline";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import {
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	listActiveDaemonSessionSummaries,
	probeRunningDaemonSessions,
	StaleDaemonError,
	shutdownDaemonAndWait,
} from "./cli/daemon-launch.ts";
import { confirmDaemonSessionLoss, type DaemonSessionLossCopy, pluralizeSessions } from "./cli/daemon-stop-confirm.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { installOwnedSessionRecoveryTracking, isOwnedSessionWorkerProcess } from "./cli/owned-session-worker.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { handlePublicCommand } from "./cli/public-command.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { APP_NAME, expandTildePath, getAgentDir, getPackageDir, getSessionDirEnvOverride, VERSION } from "./config.ts";
import {
	type AgentExecutionMode,
	type AgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
	mergeAutonomousConfig,
} from "./core/agent-session-config.ts";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import type { AgentSessionServices } from "./core/agent-session-services.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { installFileLogSink, setLogContext } from "./core/logging.ts";
import { findInitialModel, resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode as ProjectTrustAppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { canonicalSessionPath, SessionAlreadyActiveError } from "./core/session-lease.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import {
	looksLikeSessionPath,
	resolveSessionPath,
	SessionSelectorError,
	SessionSelectorNotFoundError,
} from "./core/session-resolver.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { isTelemetryEnabled } from "./core/telemetry.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { DaemonAgentConnection } from "./modes/agent-connection/daemon-agent-connection.ts";
import type { AgentConnection } from "./modes/agent-connection/types.ts";
import { runAgentsViewMode } from "./modes/agents-view/agents-view-mode.ts";
import type { AgentsViewScopeKey } from "./modes/agents-view/agents-view-state.ts";
import { isDaemonCatalogProcess, runDaemonCatalogProcess } from "./modes/daemon/daemon-catalog-process.ts";
import { DaemonCapabilityUnavailableError, DaemonClient } from "./modes/daemon/daemon-client.ts";
import { deserializeDaemonError } from "./modes/daemon/daemon-errors.ts";
import { runDaemonMode } from "./modes/daemon/daemon-mode.ts";
import { collectDaemonClientEnv, collectDaemonLaunchEnv } from "./modes/daemon/daemon-protocol.ts";
import type { SessionSummary } from "./modes/daemon/daemon-session-list.ts";
import { defaultDaemonSocketPath } from "./modes/daemon/daemon-socket.ts";
import { runDaemonSupervisorMode } from "./modes/daemon/daemon-supervisor.ts";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	isDaemonWorkerProcess,
	requireDaemonWorkerAuthenticationToken,
	waitForDaemonWorkerStartupGate,
} from "./modes/daemon/daemon-worker-protocol.ts";
import {
	createInteractiveModeLocalSessionHost,
	InProcessAgentConnection,
	InteractiveMode,
	normalizeSocketPath,
	resolveAttachModelFallbackMessage,
	runAcpMode,
	runAcpModeWithConnection,
	runPrintMode,
	runPrintModeWithConnection,
	runRpcMode,
	runRpcModeWithConnection,
} from "./modes/index.ts";
import { createInteractiveModeUiServicesFromServices } from "./modes/interactive/interactive-mode-services.ts";
import { shouldRunOnboarding } from "./modes/interactive/onboarding.ts";
import { ClientPromptStashStore } from "./modes/interactive/prompt-stash-state.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export type ClientMode = AgentExecutionMode;
/** Compatibility view of the CLI's internal daemon process entrypoint. */
export type AppMode = ClientMode | "daemon";

export function shouldRejectNonInteractiveAttach(attachAgent: string | undefined, appMode: AppMode): boolean {
	return attachAgent !== undefined && appMode !== "interactive";
}

export function shouldRejectNonInteractiveBareResume(resume: true | string | undefined, appMode: AppMode): boolean {
	return resume === true && appMode !== "interactive";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "daemon") {
		return "daemon";
	}
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "acp") {
		return "acp";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc" | "acp" | "daemon"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

export function isClientOwnedDaemonSession(appMode: AppMode, noSession?: boolean): boolean {
	return appMode !== "acp" || noSession === true;
}

// `prime-agent agents` opens the agents view directly.
export function parseAgentsViewCommand(args: string[]): { explicitAgentsView: boolean; args: string[] } {
	if (args[0] === "agents") {
		return { explicitAgentsView: true, args: args.slice(1) };
	}
	return { explicitAgentsView: false, args };
}

export interface DaemonClientStartupDecision {
	appMode: AppMode;
	startupBenchmark: boolean;
	noSession?: boolean;
	help?: boolean;
	listModels?: string | true;
}

export type InteractiveDaemonStartupDecision = DaemonClientStartupDecision;

/** Retained for callers that only classify persistent interactive startup. */
export function shouldUseDaemonInteractive(options: DaemonClientStartupDecision): boolean {
	return (
		options.appMode === "interactive" &&
		!options.startupBenchmark &&
		!options.noSession &&
		options.listModels === undefined
	);
}

export function shouldUseDaemonClient(options: DaemonClientStartupDecision): boolean {
	return (
		options.appMode !== "daemon" && !options.startupBenchmark && !options.help && options.listModels === undefined
	);
}

export function shouldUseDaemonClientRuntime(
	options: DaemonClientStartupDecision & {
		ownedSessionWorker?: boolean;
		hasProcessLocalExtensionFactories?: boolean;
	},
): boolean {
	return shouldUseDaemonClient(options) && !options.ownedSessionWorker && !options.hasProcessLocalExtensionFactories;
}

export function shouldEnsureInteractiveDaemonForStartup(
	useDaemonInteractive: boolean,
	attachAgent: string | undefined,
): boolean {
	return useDaemonInteractive && attachAgent === undefined;
}

export interface AgentsViewStartupDecision {
	useDaemonInteractive: boolean;
	needsOnboarding: boolean;
	explicitAgentsView?: boolean;
	resume?: true | string;
	continue?: boolean;
	fork?: string;
}

export function shouldOpenAgentsViewForDaemonInteractive(options: AgentsViewStartupDecision): boolean {
	const bareResume = options.resume === true;
	const requestsAgentsView = bareResume || (options.explicitAgentsView && !options.needsOnboarding);
	return (
		options.useDaemonInteractive &&
		// A selector, continuation, or fork must open its target directly rather than the agents view.
		!!requestsAgentsView &&
		typeof options.resume !== "string" &&
		!options.continue &&
		!options.fork
	);
}

export interface DaemonInteractiveSessionManagerDecision {
	resume?: true | string;
	continue?: boolean;
	fork?: string;
	hasActiveDaemonSession?: boolean;
}

export function shouldUseEphemeralSessionManagerForDaemonInteractive(
	options: DaemonInteractiveSessionManagerDecision,
): boolean {
	return (
		!options.hasActiveDaemonSession &&
		(options.resume === undefined || options.resume === true) &&
		!options.continue &&
		!options.fork
	);
}

export interface DaemonActiveSessionLookupDecision {
	useDaemonInteractive: boolean;
	resumeSelector?: string;
	explicitAttach?: boolean;
}

export function shouldEnsureDaemonBeforeActiveSessionLookup(options: DaemonActiveSessionLookupDecision): boolean {
	return (
		options.useDaemonInteractive &&
		options.resumeSelector !== undefined &&
		(options.explicitAttach || !looksLikeSessionPath(options.resumeSelector))
	);
}

interface ActiveDaemonSessionSummaryLookupOptions {
	fallbackOnError?: boolean;
}

async function findActiveDaemonSessionSummaryForInteractiveStartup(
	socketPath: string,
	selector: string,
	options: ActiveDaemonSessionSummaryLookupOptions = {},
): Promise<SessionSummary | undefined> {
	try {
		return await findActiveDaemonSessionSummary(socketPath, selector);
	} catch (error) {
		if (options.fallbackOnError === false) {
			throw error;
		}
		return undefined;
	}
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Resolve a session argument to a file path. */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

// Only busy sessions (streaming, compacting, or pending messages) lose work;
// idle loaded sessions reload from disk on the fresh daemon.
const STARTUP_SESSION_LOSS_COPY: DaemonSessionLossCopy = {
	busyDetail(count) {
		const { noun, pronoun } = pluralizeSessions(count);
		return `A background service from a different ${APP_NAME} version is running with ${count} busy ${noun}. Stopping it will terminate ${pronoun}.`;
	},
	unlistableDetail: `A background service from a different ${APP_NAME} version is running and its sessions could not be listed. Stopping it may terminate active sessions.`,
	question: "Stop it and continue?",
	nonTtyHint: `Run "${APP_NAME} shutdown" to stop it, then retry.`,
};

// The promise to keep after awaiting readiness. Wrapped in an object so it
// survives `await` (which would otherwise flatten a returned Promise to void).
type DaemonReadyResult = { ready: Promise<void> | undefined };

// A stale-version daemon couldn't be taken over automatically (busy or stuck).
// Offer to stop it (default No) and start a fresh daemon, or exit. Returns the
// fresh ready promise so callers stop re-handling the original rejection.
async function takeOverStaleDaemonOrExit(socketPath: string): Promise<DaemonReadyResult> {
	const probe = await probeRunningDaemonSessions(socketPath);
	const confirmed = await confirmDaemonSessionLoss(probe, { force: false, copy: STARTUP_SESSION_LOSS_COPY });
	if (!confirmed) {
		// Non-TTY already printed the reason; at a TTY the user declined.
		if (process.stdin.isTTY) {
			console.error(chalk.dim("Cancelled."));
		}
		process.exit(1);
	}
	if (!(await shutdownDaemonAndWait(socketPath))) {
		console.error(
			chalk.red(`Could not stop the background service on ${socketPath}. Run "${APP_NAME} shutdown" and retry.`),
		);
		process.exit(1);
	}
	const ready = ensureInteractiveDaemonRunning(socketPath);
	try {
		await ready;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Could not start the background service: ${message}`));
		process.exit(1);
	}
	return { ready };
}

// Resolves the daemon-ready promise, returning the promise to keep (the same
// one on success, or the fresh one from a stale-daemon takeover) so repeat
// calls don't re-handle the original rejection.
async function awaitDaemonReady(daemonReady: Promise<void> | undefined): Promise<DaemonReadyResult> {
	if (!daemonReady) {
		return { ready: daemonReady };
	}
	try {
		await daemonReady;
		return { ready: daemonReady };
	} catch (error) {
		if (error instanceof StaleDaemonError) {
			return takeOverStaleDaemonOrExit(error.socketPath);
		}
		throw error;
	}
}

function getResumeSelector(parsed: Pick<Args, "resume">): string | undefined {
	return typeof parsed.resume === "string" ? parsed.resume : undefined;
}

/** The trust prompt has no daemon surface; daemon startup uses the print path. */
function toProjectTrustMode(appMode: AppMode): ProjectTrustAppMode {
	return appMode === "daemon" ? "print" : appMode;
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}
		}
	}

	// `--resume <selector>` resumes that session directly; bare `--resume` opens the picker.
	const resumeSelector = getResumeSelector(parsed);
	if (resumeSelector) {
		const resolved = await resolveSessionPath(resumeSelector, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

/** Fields buildSessionOptions reads; satisfied by both Args and AgentSessionRuntimeConfig. */
interface SessionOptionInputs {
	model?: string;
	provider?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
}

function buildSessionOptions(
	parsed: SessionOptionInputs,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

function getDaemonSummaryActiveSessionId(summary: SessionSummary): string {
	return summary.activeSessionId ?? summary.id;
}

function isUnknownActiveSessionError(message: string): boolean {
	return message.startsWith("Unknown active session:");
}

async function findActiveDaemonSessionSummary(
	socketPath: string,
	selector: string,
): Promise<SessionSummary | undefined> {
	const client = new DaemonClient(socketPath);
	await client.connect(250);

	try {
		const response = await client.request({ type: "get_state", activeSessionId: selector }, 3000);
		if (!response.success) {
			if (isUnknownActiveSessionError(response.error)) {
				return undefined;
			}
			throw new Error(response.error);
		}
		if (!isDaemonSessionSummary(response.data)) {
			throw new Error("Daemon returned an invalid active session summary");
		}
		return response.data;
	} finally {
		client.close();
	}
}

function createSessionManagerForActiveDaemonSummary(summary: SessionSummary, fallbackCwd: string): SessionManager {
	const cwd = summary.cwd || fallbackCwd;
	if (summary.sessionFile) {
		try {
			return SessionManager.open(summary.sessionFile, undefined, cwd);
		} catch {
			return SessionManager.inMemory(cwd);
		}
	}
	return SessionManager.inMemory(cwd);
}

function getInteractiveDaemonSessionPath(parsed: Args, sessionManager: SessionManager): string | undefined {
	if (!parsed.resume && !parsed.continue && !parsed.fork) {
		return undefined;
	}
	return sessionManager.getSessionFile();
}

export function findActiveDaemonSessionSummaryForSessionFile(
	summaries: readonly SessionSummary[],
	sessionPath: string,
): SessionSummary | undefined {
	const resolvedSessionPath = canonicalSessionPath(sessionPath);
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			canonicalSessionPath(summary.sessionFile) === resolvedSessionPath,
	);
}

async function createDaemonClientConnection(options: {
	socketPath: string;
	config: AgentSessionRuntimeConfig;
	sessionPath?: string;
	continueRecent?: boolean;
	activeSessionId?: string;
	clientOwned?: boolean;
	noSession?: boolean;
	supportsExtensionUi?: boolean;
}): Promise<{ connection: DaemonAgentConnection; summary: SessionSummary }> {
	// Caller must have awaited ensureInteractiveDaemonRunning for this socket.
	const client = new DaemonClient(options.socketPath);
	await client.connect();

	try {
		const attach = async (summary: SessionSummary) => {
			const connection = await DaemonAgentConnection.attach(client, getDaemonSummaryActiveSessionId(summary), {
				closeClientOnDispose: true,
				sendClientEnv: true,
				ownedSession: options.clientOwned,
				ownedSessionRecoveryConfig: options.clientOwned ? options.config : undefined,
				supportsExtensionUi: options.supportsExtensionUi,
				recoverDaemon: () => ensureInteractiveDaemonRunning(options.socketPath),
				telemetryDisabled: options.config.telemetryDisabled,
			});
			return { connection, summary };
		};

		if (options.activeSessionId) {
			const summary = await findAttachedDaemonSessionSummary(client, options.activeSessionId);
			return await attach(summary);
		}

		if (options.sessionPath && !options.clientOwned) {
			const activeSummary = findActiveDaemonSessionSummaryForSessionFile(
				await listActiveDaemonSessionSummaries(client),
				options.sessionPath,
			);
			if (activeSummary && activeSummary.workerState !== "failed") {
				return await attach(activeSummary);
			}
		}
		if (options.clientOwned) {
			await client.waitForHello();
			if (!client.supportsServerCapability("client_owned_sessions")) {
				throw new DaemonCapabilityUnavailableError("create", "client_owned_sessions");
			}
		}

		const response = await client.request({
			type: "create",
			config: options.config,
			sessionPath: options.sessionPath,
			continueRecent: options.continueRecent,
			noSession: options.noSession,
			env: collectDaemonClientEnv(),
			lifecycle: options.clientOwned ? "client_owned" : "resident",
			launchEnv: collectDaemonLaunchEnv(),
		});
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		if (!isDaemonSessionSummary(response.data)) {
			throw new Error("Daemon returned an invalid create response");
		}
		const summary = response.data;
		return await attach(summary);
	} catch (error) {
		client.close();
		throw error;
	}
}

async function findAttachedDaemonSessionSummary(
	client: DaemonClient,
	activeSessionId: string,
): Promise<SessionSummary> {
	const response = await client.request({ type: "get_state", activeSessionId });
	if (!response.success) {
		throw new Error(response.error);
	}
	if (!isDaemonSessionSummary(response.data)) {
		throw new Error("Daemon returned an invalid active session summary");
	}
	return response.data;
}

function runtimeAutonomousConfigFromArgs(parsed: Args): AgentSessionRuntimeConfig["autonomous"] {
	const hasAutonomousOptions =
		parsed.autonomous === true ||
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined ||
		parsed.autonomousMaxContinuations !== undefined ||
		parsed.autonomousMaxTurns !== undefined ||
		parsed.autonomousMaxTokens !== undefined ||
		parsed.autonomousTimeoutMs !== undefined;
	if (!hasAutonomousOptions) {
		return undefined;
	}
	const hasGateOptions =
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined;
	return {
		enabled: true,
		maxContinuations: parsed.autonomousMaxContinuations,
		maxTurns: parsed.autonomousMaxTurns,
		maxTokens: parsed.autonomousMaxTokens,
		timeoutMs: parsed.autonomousTimeoutMs,
		gates: hasGateOptions
			? {
					commands: parsed.autonomousGates,
					maxRetries: parsed.autonomousGateRetries,
					timeoutMs: parsed.autonomousGateTimeoutMs,
				}
			: undefined,
	};
}

function runtimeConfigFromArgs(
	parsed: Args,
	cwd: string,
	agentDir: string,
	sessionDir: string | undefined,
	appMode: AppMode,
	telemetryDisabled?: true,
): AgentSessionRuntimeConfig {
	return {
		cwd,
		agentDir,
		sessionDir,
		provider: parsed.provider,
		model: parsed.model,
		apiKey: parsed.apiKey,
		systemPrompt: parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		thinking: parsed.thinking,
		models: parsed.models,
		tools: parsed.tools,
		excludeTools: parsed.excludeTools,
		noTools: parsed.noTools,
		noBuiltinTools: parsed.noBuiltinTools,
		extensions: resolveCliPaths(cwd, parsed.extensions),
		noExtensions: parsed.noExtensions,
		skills: resolveCliPaths(cwd, parsed.skills),
		noSkills: parsed.noSkills,
		promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates),
		noPromptTemplates: parsed.noPromptTemplates,
		themes: resolveCliPaths(cwd, parsed.themes),
		noThemes: parsed.noThemes,
		noContextFiles: parsed.noContextFiles,
		autonomous: runtimeAutonomousConfigFromArgs(parsed),
		extensionFlagValues: parsed.unknownFlags.size > 0 ? Object.fromEntries(parsed.unknownFlags.entries()) : undefined,
		executionMode: appMode === "daemon" ? undefined : (appMode as AgentExecutionMode),
		telemetryDisabled,
		// Serialized refine for print/json/rpc: the client's appMode is NOT
		// "daemon" here. The daemon worker receives this flag via
		// AgentSessionRuntimeConfig and uses it instead of its own appMode.
		serializedRefine: appMode !== "interactive" && appMode !== "daemon",
		initialGoal: parsed.goal ? { objective: parsed.goal, tokenBudget: parsed.goalTokenBudget } : undefined,
	};
}

interface PreparedRuntimeServices {
	services: AgentSessionServices;
	scopedModels: ScopedModel[];
	sessionOptions: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export function daemonServerDefaultSessionConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	return { ...config, initialGoal: undefined };
}

export function resolveRuntimeSessionOptions(
	sessionOptions: CreateAgentSessionOptions,
	runtimeSessionOptions?: CreateAgentSessionOptions,
): CreateAgentSessionOptions {
	return {
		model: runtimeSessionOptions?.model ?? sessionOptions.model,
		thinkingLevel: runtimeSessionOptions?.thinkingLevel ?? sessionOptions.thinkingLevel,
		serviceTier: runtimeSessionOptions?.serviceTier ?? sessionOptions.serviceTier,
		scopedModels: runtimeSessionOptions?.scopedModels ?? sessionOptions.scopedModels,
		tools: runtimeSessionOptions?.tools ?? sessionOptions.tools,
		excludeTools: runtimeSessionOptions?.excludeTools ?? sessionOptions.excludeTools,
		noTools: runtimeSessionOptions?.noTools ?? sessionOptions.noTools,
		customTools: runtimeSessionOptions?.customTools ?? sessionOptions.customTools,
		initialActiveToolNames: runtimeSessionOptions?.initialActiveToolNames,
		allowedToolNames: runtimeSessionOptions?.allowedToolNames,
		includeGoals: runtimeSessionOptions?.includeGoals,
		includeCompactSkill: runtimeSessionOptions?.includeCompactSkill,
		rlmHeartbeatController: runtimeSessionOptions?.rlmHeartbeatController,
		agentMessageController: runtimeSessionOptions?.agentMessageController,
		agentObserveController: runtimeSessionOptions?.agentObserveController,
		autonomous:
			(runtimeSessionOptions?.rlmDepth ?? 0) > 0
				? mergeAutonomousConfig(sessionOptions.autonomous, { ...runtimeSessionOptions?.autonomous, enabled: false })
				: mergeAutonomousConfig(sessionOptions.autonomous, runtimeSessionOptions?.autonomous),
		rlmDepth: runtimeSessionOptions?.rlmDepth,
		rlmMaxDepth: runtimeSessionOptions?.rlmMaxDepth,
		rlmSessionDir: runtimeSessionOptions?.rlmSessionDir,
		rlmParentNodeId: runtimeSessionOptions?.rlmParentNodeId,
		rlmParentAgent: runtimeSessionOptions?.rlmParentAgent,
		subagentRuntimeHost: runtimeSessionOptions?.subagentRuntimeHost,
	};
}

async function prepareRuntimeServices(options: {
	config: AgentSessionRuntimeConfig;
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	extensionFactories?: InlineExtension[];
	sessionOptionsOverride?: CreateAgentSessionOptions;
	settingsManager?: SettingsManager;
	resourceLoaderReloadOptions?: Parameters<typeof createAgentSessionServices>[0]["resourceLoaderReloadOptions"];
}): Promise<PreparedRuntimeServices> {
	const { config, sessionManager } = options;
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: config.agentDir ?? options.agentDir,
		settingsManager: options.settingsManager,
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		extensionFlagValues: new Map(Object.entries(config.extensionFlagValues ?? {})),
		// Subagents share the parent's Herdr pane; their own reporter would race
		// the parent's and a subagent quit would release the still-active pane.
		noBuiltinHerdrReporter: (options.sessionOptionsOverride?.rlmDepth ?? 0) > 0,
		telemetryDisabled: config.telemetryDisabled,
		resourceLoaderReloadOptions: options.resourceLoaderReloadOptions,
		resourceLoaderOptions: {
			additionalExtensionPaths: config.extensions,
			additionalSkillPaths: config.skills,
			additionalPromptTemplatePaths: config.promptTemplates,
			additionalThemePaths: config.themes,
			noExtensions: config.noExtensions,
			noSkills: config.noSkills,
			noPromptTemplates: config.noPromptTemplates,
			noThemes: config.noThemes,
			noContextFiles: config.noContextFiles,
			systemPrompt: config.systemPrompt,
			appendSystemPrompt: config.appendSystemPrompt,
			extensionFactories: options.extensionFactories,
		},
	});
	const { settingsManager, modelRuntime, resourceLoader } = services;
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [
		...services.diagnostics,
		...collectSettingsDiagnostics(settingsManager),
		...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		})),
	];

	const modelPatterns = config.models ?? settingsManager.getEnabledModels();
	const scopedModels =
		modelPatterns && modelPatterns.length > 0
			? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
			: [];
	const {
		options: sessionOptions,
		cliThinkingFromModel,
		diagnostics: sessionOptionDiagnostics,
	} = buildSessionOptions(
		config,
		scopedModels,
		sessionManager.buildSessionContext().messages.length > 0,
		modelRuntime,
		settingsManager,
	);
	diagnostics.push(...sessionOptionDiagnostics);

	const effectiveSessionModel = options.sessionOptionsOverride?.model ?? sessionOptions.model;
	if (config.apiKey) {
		if (!effectiveSessionModel) {
			diagnostics.push({
				type: "error",
				message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
			});
		} else {
			await modelRuntime.setRuntimeApiKey(effectiveSessionModel.provider, config.apiKey);
		}
	}

	return { services, scopedModels, sessionOptions, cliThinkingFromModel, diagnostics };
}

async function resolvePreparedStartupModel(options: {
	prepared: PreparedRuntimeServices;
	sessionManager: SessionManager;
}): Promise<{ model: Model<Api> | undefined; modelFallbackMessage: string | undefined }> {
	const { prepared, sessionManager } = options;
	const { modelRuntime, settingsManager } = prepared.services;
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;

	let model = prepared.sessionOptions.model;
	let modelFallbackMessage: string | undefined;

	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	if (!model) {
		const result = await findInitialModel({
			scopedModels: prepared.scopedModels,
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	return { model, modelFallbackMessage };
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	if (isDaemonWorkerProcess()) {
		waitForDaemonWorkerStartupGate();
	}
	installFileLogSink();
	if (isDaemonCatalogProcess()) {
		await runDaemonCatalogProcess();
		return;
	}
	// Client and daemon are separate processes; both need these in their registry.
	registerBuiltinMcpOAuthProviders();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (await runAuthCommand(args)) {
		return;
	}

	const publicCommand = await handlePublicCommand(args, { extensionFactories });
	if (publicCommand.handled) {
		return;
	}
	args = publicCommand.args;
	const explicitAgentsView = publicCommand.explicitAgentsView;

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();

	let cwd = process.cwd();
	const agentDir = getAgentDir();
	// Bootstrap manager is read for global (cwd-independent) settings only; the
	// cwd-bound manager is created after --cwd and session selection resolve.
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `pi update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	if (shouldRejectNonInteractiveAttach(publicCommand.attachAgent, appMode)) {
		console.error(chalk.red("Error: attach requires an interactive terminal"));
		process.exit(1);
	}
	if (shouldRejectNonInteractiveBareResume(parsed.resume, appMode)) {
		console.error(chalk.red("Error: --resume without a session selector requires an interactive terminal"));
		process.exit(1);
	}
	setLogContext({ mode: appMode });

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if ((parsed.mode === "rpc" || parsed.mode === "acp" || parsed.mode === "daemon") && parsed.fileArgs.length > 0) {
		console.error(chalk.red(`Error: @file arguments are not supported in ${parsed.mode.toUpperCase()} mode`));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	if (parsed.cwd) {
		cwd = resolvePath(expandTildePath(parsed.cwd));
		try {
			process.chdir(cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Cannot use cwd ${cwd}: ${message}`));
			process.exit(1);
		}
	}
	if (parsed.daemonSocket) {
		// After --cwd so a relative socket path resolves against the requested directory.
		parsed.daemonSocket = normalizeSocketPath(parsed.daemonSocket);
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}
	// Programmatic factories are process-local functions and cannot be serialized to a daemon worker.
	const hasProcessLocalExtensionFactories = (options?.extensionFactories?.length ?? 0) > 0;
	const useDaemonClient = shouldUseDaemonClientRuntime({
		appMode,
		startupBenchmark,
		noSession: parsed.noSession,
		help: parsed.help,
		listModels: parsed.listModels,
		ownedSessionWorker: isOwnedSessionWorkerProcess(),
		hasProcessLocalExtensionFactories,
	});
	const useDaemonInteractive = useDaemonClient && appMode === "interactive";

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		getSessionDirEnvOverride() ??
		startupSettingsManager.getSessionDir();

	const daemonSocketPath = parsed.daemonSocket ?? defaultDaemonSocketPath();
	// Kick off daemon spawn/readiness immediately so it overlaps session-manager
	// and runtime-services preparation; attach only connects to an existing daemon.
	let daemonReady = shouldEnsureInteractiveDaemonForStartup(useDaemonClient, publicCommand.attachAgent)
		? ensureInteractiveDaemonRunning(daemonSocketPath)
		: undefined;
	// Errors are rethrown at the await sites below; this only avoids an unhandled
	// rejection if startup exits before reaching them.
	daemonReady?.catch(() => {});
	const resumeSelector = getResumeSelector(parsed);
	const shouldLookupDaemonActiveSession = shouldEnsureDaemonBeforeActiveSessionLookup({
		useDaemonInteractive,
		resumeSelector,
		explicitAttach: publicCommand.attachAgent !== undefined,
	});
	if (shouldLookupDaemonActiveSession && daemonReady) {
		daemonReady = (await awaitDaemonReady(daemonReady)).ready;
	}
	let activeDaemonSessionSummary: SessionSummary | undefined;
	if (shouldLookupDaemonActiveSession && resumeSelector) {
		try {
			activeDaemonSessionSummary = await findActiveDaemonSessionSummaryForInteractiveStartup(
				daemonSocketPath,
				resumeSelector,
				{ fallbackOnError: !publicCommand.attachAgent },
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Could not look up active agent '${resumeSelector}': ${message}`));
			process.exit(1);
		}
	}
	if (publicCommand.attachAgent && !activeDaemonSessionSummary) {
		console.error(chalk.red(`Error: No active agent found matching '${publicCommand.attachAgent}'`));
		process.exit(1);
	}

	let sessionManager: SessionManager;
	if (activeDaemonSessionSummary) {
		sessionManager = createSessionManagerForActiveDaemonSummary(activeDaemonSessionSummary, cwd);
	} else if (
		useDaemonInteractive &&
		shouldUseEphemeralSessionManagerForDaemonInteractive({
			resume: parsed.resume,
			continue: parsed.continue,
			fork: parsed.fork,
		})
	) {
		sessionManager = SessionManager.inMemory(cwd);
	} else {
		try {
			sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
		} catch (error) {
			if (!(error instanceof SessionSelectorError)) {
				throw error;
			}
			const suggestion =
				error instanceof SessionSelectorNotFoundError && error.suggestion
					? ` Did you mean '${error.suggestion}'?`
					: "";
			console.error(chalk.red(`Error: ${error.message}.${suggestion}`));
			console.error(chalk.dim(`Open ${APP_NAME} and press left-arrow to browse sessions.`));
			process.exit(1);
		}
	}
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const telemetrySettingsManager =
		sessionManager.getCwd() === cwd
			? startupSettingsManager
			: SettingsManager.create(sessionManager.getCwd(), agentDir);
	const telemetryDisabled = isTelemetryEnabled(telemetrySettingsManager) ? undefined : true;
	const defaultSessionConfig = runtimeConfigFromArgs(
		parsed,
		sessionManager.getCwd(),
		agentDir,
		sessionDir,
		appMode,
		telemetryDisabled,
	);
	// Verifier/headless clients pass initialGoal in each create request. The long-lived
	// daemon fallback must not seed that goal into unrelated future sessions.
	const daemonDefaultSessionConfig = daemonServerDefaultSessionConfig(defaultSessionConfig);
	const runtimeDefaultSessionConfig = appMode === "daemon" ? daemonDefaultSessionConfig : defaultSessionConfig;

	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	const trustPromptMode: ProjectTrustAppMode =
		parsed.help || parsed.listModels !== undefined ? "print" : toProjectTrustMode(appMode);
	const projectTrustByCwd = new Map<string, boolean>();

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
		sessionConfig,
		sessionOptions: runtimeSessionOptions,
	}) => {
		const config = mergeAgentSessionRuntimeConfig(runtimeDefaultSessionConfig, sessionConfig);
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		const effectiveAgentDir = config.agentDir ?? agentDir;
		const runtimeSettingsManager = SettingsManager.create(cwd, effectiveAgentDir, { projectTrusted });
		const prepared = await prepareRuntimeServices({
			config,
			cwd,
			agentDir: effectiveAgentDir,
			sessionManager,
			extensionFactories,
			sessionOptionsOverride: runtimeSessionOptions,
			settingsManager: runtimeSettingsManager,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : toProjectTrustMode(appMode),
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
		});
		const { services, sessionOptions, cliThinkingFromModel } = prepared;
		const diagnostics = [...projectTrustDiagnostics, ...prepared.diagnostics];
		const resolvedSessionOptions = resolveRuntimeSessionOptions(sessionOptions, runtimeSessionOptions);

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			...resolvedSessionOptions,
			// Main agents boot their kernel in the background at session creation;
			// subagent sessions (rlmDepth > 0) keep the lazy first-call start.
			prewarmIpythonKernel: true,
			// Read serializedRefine from the merged runtime config so it survives
			// the daemon worker's appMode="daemon" context.
			serializedRefine: config.serializedRefine ?? false,
			executionMode: config.executionMode,
			telemetryDisabled: config.telemetryDisabled,
			// Only seed the initial goal for top-level sessions (rlmDepth 0).
			initialGoal: (runtimeSessionOptions?.rlmDepth ?? 0) === 0 ? config.initialGoal : undefined,
		});
		const cliThinkingOverride = config.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return { ...created, services, diagnostics };
	};
	time("createRuntime");

	// Daemon mode never uses the bootstrap runtime, so skip the heavy
	// createAgentSessionRuntime below and start listening immediately; sessions
	// are created on demand through the daemon protocol via createRuntime.
	// --list-models still takes the full path to print and exit.
	if (appMode === "daemon" && parsed.listModels === undefined) {
		printTimings();
		if (isDaemonWorkerProcess()) {
			await runDaemonMode({
				socketPath: parsed.daemonSocket,
				defaultSessionConfig: daemonDefaultSessionConfig,
				createRuntime,
				worker: {
					authenticationToken: requireDaemonWorkerAuthenticationToken(),
					restoreActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV],
				},
			});
		} else {
			await runDaemonSupervisorMode({
				socketPath: parsed.daemonSocket,
				defaultSessionConfig: daemonDefaultSessionConfig,
			});
		}
		return;
	}

	if (useDaemonInteractive) {
		const prepared = await prepareRuntimeServices({
			config: defaultSessionConfig,
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			extensionFactories,
		});
		const { services, scopedModels } = prepared;
		const { settingsManager } = services;
		setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

		const startupModel = await resolvePreparedStartupModel({ prepared, sessionManager });

		const stdinContent = await readPipedStdin();
		time("readPipedStdin");

		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");
		initTheme(settingsManager.getTheme(), true);
		time("initTheme");

		if (deprecationWarnings.length > 0) {
			await showDeprecationWarnings(deprecationWarnings);
		}

		const preparedDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...prepared.diagnostics]);
		reportDiagnostics(preparedDiagnostics);
		if (preparedDiagnostics.some((diagnostic) => diagnostic.type === "error")) {
			if (preparedDiagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
				console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
			}
			process.exit(1);
		}
		time("prepareInteractiveServices");

		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => `${sm.model.id}${sm.thinkingLevel ? `:${sm.thinkingLevel}` : ""}`)
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const promptStashStore = new ClientPromptStashStore();
		const daemonUiServices = createInteractiveModeUiServicesFromServices({ services, sessionManager });
		const launchAgentsView = async (initialSession?: SessionSummary, initialScopeKey?: AgentsViewScopeKey) => {
			await runAgentsViewMode({
				socketPath: daemonSocketPath,
				config: defaultSessionConfig,
				uiServices: daemonUiServices,
				recoverDaemon: () => ensureInteractiveDaemonRunning(daemonSocketPath),
				createUiServicesForSession: async (summary) => {
					const attachedSessionManager = createSessionManagerForActiveDaemonSummary(
						summary,
						sessionManager.getCwd(),
					);
					const attachedPrepared = await prepareRuntimeServices({
						config: mergeAgentSessionRuntimeConfig(defaultSessionConfig, {
							cwd: attachedSessionManager.getCwd(),
						}),
						cwd: attachedSessionManager.getCwd(),
						agentDir,
						sessionManager: attachedSessionManager,
						extensionFactories,
					});
					return createInteractiveModeUiServicesFromServices({
						services: attachedPrepared.services,
						sessionManager: attachedSessionManager,
					});
				},
				migratedProviders,
				modelFallbackMessage: startupModel.modelFallbackMessage,
				promptStashStore,
				startupModelId: startupModel.model?.id,
				initialSession,
				initialScopeKey,
				verbose: parsed.verbose,
			});
		};
		if (
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive: useDaemonInteractive && !parsed.noSession,
				explicitAgentsView,
				needsOnboarding: shouldRunOnboarding({
					settingsManager,
					modelRegistry: services.modelRegistry,
					model: startupModel.model,
				}),
				resume: parsed.resume,
				continue: parsed.continue,
				fork: parsed.fork,
			})
		) {
			daemonReady = (await awaitDaemonReady(daemonReady)).ready;
			printTimings();
			await launchAgentsView();
			return;
		}

		daemonReady = (await awaitDaemonReady(daemonReady)).ready;
		// A fresh default chat opens a real but message-less session; the lifecycle
		// axis treats it as a draft (hidden, discarded on detach if never used), so
		// no DeferredAgentConnection is needed to avoid creating it up front.
		const isFreshDefaultSession =
			!activeDaemonSessionSummary && !getInteractiveDaemonSessionPath(parsed, sessionManager);
		const { connection, summary } = await createDaemonClientConnection({
			socketPath: daemonSocketPath,
			config: defaultSessionConfig,
			activeSessionId: activeDaemonSessionSummary
				? getDaemonSummaryActiveSessionId(activeDaemonSessionSummary)
				: undefined,
			sessionPath: getInteractiveDaemonSessionPath(parsed, sessionManager),
			clientOwned: parsed.noSession,
			noSession: parsed.noSession,
			supportsExtensionUi: true,
		});
		const agentConnection: AgentConnection = connection;
		const attachModelFallbackMessage = isFreshDefaultSession
			? startupModel.modelFallbackMessage
			: resolveAttachModelFallbackMessage(summary, startupModel.modelFallbackMessage);

		const interactiveMode = new InteractiveMode({
			agentConnection,
			daemonSocketPath,
			uiServices: daemonUiServices,
			promptStashStore,
			promptStashSessionId: summary.sessionId,
			bindLocalSessionExtensions: false,
			migratedProviders,
			startupDiagnostics: preparedDiagnostics,
			modelFallbackMessage: attachModelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
			// Resumed/attached daemon sessions are part of the same fleet; left
			// arrow takes them to the agents view like any other session.
			returnToAgentsView: !parsed.noSession,
			sessionDepth: summary.rlmDepth,
			// Direct launch has only the attached summary; the live+passive+saved
			// unified catalog index is not built until the agents view opens.
			sessionHasChildren: summary.hasRunningRlmChildren === true,
		});

		printTimings();
		const interactiveResult = await interactiveMode.run();
		if (parsed.noSession) {
			return;
		}
		const returnedSummary = {
			...summary,
			...interactiveResult.source,
			id: interactiveResult.source.activeSessionId ?? summary.id,
		};
		const initialScopeKey =
			interactiveResult.type === "scoped_agents_view"
				? {
						sessionId: interactiveResult.source.sessionId,
						activeSessionId: interactiveResult.source.activeSessionId,
					}
				: undefined;
		await launchAgentsView(returnedSummary, initialScopeKey);
		return;
	}

	if (useDaemonClient) {
		const settingsManager = SettingsManager.create(sessionManager.getCwd(), agentDir);
		let stdinContent: string | undefined;
		if (appMode !== "rpc" && appMode !== "acp") {
			stdinContent = await readPipedStdin();
		}
		time("readPipedStdin");
		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");
		initTheme(settingsManager.getTheme(), false);
		time("initTheme");

		daemonReady = (await awaitDaemonReady(daemonReady)).ready;
		let connection: DaemonAgentConnection;
		let summary: SessionSummary;
		try {
			({ connection, summary } = await createDaemonClientConnection({
				socketPath: daemonSocketPath,
				config: defaultSessionConfig,
				sessionPath: parsed.noSession ? undefined : sessionManager.getSessionFile(),
				continueRecent: parsed.continue,
				clientOwned: isClientOwnedDaemonSession(appMode, parsed.noSession),
				noSession: parsed.noSession,
				supportsExtensionUi: appMode === "rpc",
			}));
		} catch (error) {
			if (error instanceof SessionAlreadyActiveError) {
				console.error(chalk.red(`Error: ${error.message}`));
				process.exit(1);
			}
			throw error;
		}
		const diagnostics = summary.diagnostics ?? [];
		reportDiagnostics(diagnostics);
		if (diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			await connection.dispose();
			process.exit(1);
		}
		if (!summary.model) {
			console.error(chalk.red(summary.modelFallbackMessage ?? formatNoModelsAvailableMessage()));
			await connection.dispose();
			process.exit(1);
		}

		printTimings();
		if (appMode === "rpc") {
			return await runRpcModeWithConnection(connection);
		}
		if (appMode === "acp") {
			return await runAcpModeWithConnection(connection);
		}
		const exitCode = await runPrintModeWithConnection(connection, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}

	let runtime: AgentSessionRuntime;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			sessionConfig: defaultSessionConfig,
		});
	} catch (error) {
		if (error instanceof SessionAlreadyActiveError) {
			console.error(chalk.red(`Error: ${error.message}`));
			process.exit(1);
		}
		throw error;
	}
	time("createAgentSessionRuntime");
	installOwnedSessionRecoveryTracking(runtime);
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC/ACP modes which use stdin for protocol traffic
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && appMode !== "acp") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// RPC/ACP refresh catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!offlineMode && (appMode === "rpc" || appMode === "acp")) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "acp") {
		printTimings();
		await runAcpMode(runtime);
	} else if (appMode === "interactive") {
		if (explicitAgentsView || parsed.resume === true) {
			console.error(chalk.yellow("Warning: the agents view needs the daemon; opening a normal chat instead"));
		}
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => `${sm.model.id}${sm.thinkingLevel ? `:${sm.thinkingLevel}` : ""}`)
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		// Interactive TUI talks to the session through AgentConnection (in-process here).
		const interactiveMode = new InteractiveMode({
			agentConnection: new InProcessAgentConnection(runtime),
			localSessionHost: createInteractiveModeLocalSessionHost(runtime),
			promptStashStore: new ClientPromptStashStore(),
			promptStashSessionId: session.sessionId,
			bindLocalSessionExtensions: true,
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
