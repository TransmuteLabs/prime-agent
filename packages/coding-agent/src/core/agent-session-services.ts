import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSessionMessageController } from "./agent-messages.ts";
import type { AgentObserveController } from "./agent-observe.ts";
import type { AgentExecutionMode } from "./agent-session-config.ts";
import { installAgentTraceUpload } from "./agent-traces.ts";
import type { AgentAutonomousConfig } from "./autonomous.ts";
import type { AgentRlmHeartbeatController } from "./cron-jobs.ts";
import { createHerdrAgentStateExtension } from "./extensions/builtin/herdr-agent-state.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { McpManager } from "./mcp/mcp-manager.ts";
import { ModelRegistry } from "./model-registry.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import type { SubagentRuntimeHost } from "./rlm-runtime.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { installAgentTelemetry, isTelemetryEnabled } from "./telemetry.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	/**
	 * Skip the built-in Herdr reporter for these services. Set for RLM subagent
	 * runtimes: they inherit the parent's HERDR_* pane identity, so their own
	 * reporter would race the parent's on the same pane and a subagent quit
	 * would release the pane while the parent is still running.
	 */
	noBuiltinHerdrReporter?: boolean;
	telemetryDisabled?: true;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface AgentSessionCreationOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	includeGoals?: boolean;
	includeCompactSkill?: boolean;
	agentMessageController?: AgentSessionMessageController;
	agentObserveController?: AgentObserveController;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	rlmParentAgent?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	prewarmIpythonKernel?: boolean;
	autonomous?: AgentAutonomousConfig;
	serializedRefine?: boolean;
	executionMode?: AgentExecutionMode;
	telemetryDisabled?: true;
	initialGoal?: { objective: string; tokenBudget?: number };
}

export interface CreateAgentSessionFromServicesOptions extends AgentSessionCreationOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	/** Compatibility facade for extensions/daemon (prime-port). */
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	mcpManager: McpManager;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = new ModelRegistry(modelRuntime);
	// MCP integrations: registers OAuth providers and gates the built-in
	// integration skills by whether the user is logged in (enable-by-login).
	const mcpManager = new McpManager({
		authStorage: modelRegistry.authStorage,
		getUserServers: () => settingsManager.getGlobalMcpServers(),
	});
	const userExtensionFactories = options.resourceLoaderOptions?.extensionFactories ?? [];
	// The built-in Herdr reporter defers to Herdr's own file-based integration
	// when the loader actually loaded it; two reporters would race on the same
	// pane. noExtensions is a full opt-out: it disables the built-in reporter too.
	const skipHerdrReporter = options.noBuiltinHerdrReporter || options.resourceLoaderOptions?.noExtensions;
	const builtinExtensionFactories = skipHerdrReporter
		? []
		: [createHerdrAgentStateExtension(() => resourceLoader.getLoadedExtensionPaths())];
	const resourceLoader: DefaultResourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [...builtinExtensionFactories, ...userExtensionFactories],
		extraBuiltinSkillOverrides: () => mcpManager.getDisabledBuiltinSkillOverrides(),
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	if (
		!options.telemetryDisabled &&
		isTelemetryEnabled(settingsManager) &&
		!settingsManager.getTelemetryNoticeShown()
	) {
		diagnostics.push({
			type: "info",
			message:
				"Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode.",
		});
		settingsManager.setTelemetryNoticeShown(true);
	}
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	await modelRuntime.refresh({ allowNetwork: false });
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		modelRuntime,
		modelRegistry,
		settingsManager,
		resourceLoader,
		mcpManager,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	installAgentTraceUpload(options.sessionManager, {
		authStorage: options.services.modelRuntime.authStorage,
		settingsManager: options.services.settingsManager,
	});
	const result = await createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		mcpManager: options.services.mcpManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		serviceTier: options.serviceTier,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		includeGoals: options.includeGoals,
		includeCompactSkill: options.includeCompactSkill,
		agentMessageController: options.agentMessageController,
		agentObserveController: options.agentObserveController,
		rlmDepth: options.rlmDepth,
		rlmMaxDepth: options.rlmMaxDepth,
		rlmSessionDir: options.rlmSessionDir,
		rlmParentNodeId: options.rlmParentNodeId,
		rlmParentAgent: options.rlmParentAgent,
		subagentRuntimeHost: options.subagentRuntimeHost,
		rlmHeartbeatController: options.rlmHeartbeatController,
		sessionStartEvent: options.sessionStartEvent,
		prewarmIpythonKernel: options.prewarmIpythonKernel,
		autonomous: options.autonomous,
		serializedRefine: options.serializedRefine,
		initialGoal: options.initialGoal,
	});
	if (result.session.rlmDepth === 0 && !options.telemetryDisabled) {
		installAgentTelemetry(result.session, {
			agentDir: options.services.agentDir,
			settingsManager: options.services.settingsManager,
			executionMode: options.executionMode,
		});
	}
	return result;
}
