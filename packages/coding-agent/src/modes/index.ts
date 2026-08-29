/**
 * Run modes for the coding agent.
 */

export {
	type AcpModeOptions,
	acpStopReason,
	acpToolKind,
	acpUpdatesForSessionEvent,
	bashToolCallId,
	PRIME_AGENT_META_NAMESPACE,
	primeAgentMeta,
	runAcpMode,
	runAcpModeWithConnection,
} from "./acp/index.ts";
export type {
	AgentConnection,
	AgentConnectionArtifactReference,
	AgentConnectionArtifactType,
	AgentConnectionEvent,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionModel,
	AgentConnectionModelCycleResult,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "./agent-connection/index.ts";
export { DaemonAgentConnection, InProcessAgentConnection } from "./agent-connection/index.ts";
export { type AgentsViewModeOptions, runAgentsViewMode } from "./agents-view/agents-view-mode.ts";
export {
	type AgentsViewRow,
	type AgentsViewScopeFrame,
	type AgentsViewScopeKey,
	type AgentsViewSection,
	type AgentsViewSelectionKey,
	aggregateSessionHeartbeats,
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	classifyAgentsViewSession,
	createUnattachableChildOpenResult,
	filterUnifiedSessions,
	formatHeartbeatBadge,
	getAgentsViewSelectionKey,
	getAgentsViewSessionTitle,
	getUnifiedSessionAncestorSessionIds,
	hasUnifiedSessionChildren,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
	resolveAgentsViewScopeFrames,
	resolveAgentsViewSelectionIndex,
	resolveAgentsViewSelectionState,
	scopeToSessionSubtree,
	sectionTitle,
	shouldApplyScopeResolution,
	shouldShowAgentsViewSession,
	transitionAgentsViewScope,
	type UnifiedSessionHeartbeat,
	type UnifiedSessionIndex,
	type UnifiedSessionRecord,
} from "./agents-view/agents-view-state.ts";
export {
	DaemonCapabilityUnavailableError,
	DaemonClient,
	type DaemonClientMessageListener,
} from "./daemon/daemon-client.ts";
export { type DaemonModeOptions, runDaemonMode } from "./daemon/daemon-mode.ts";
export type {
	DaemonArtifactReference,
	DaemonAttachResult,
	DaemonClientCapability,
	DaemonClientId,
	DaemonCommand,
	DaemonCommandEnvelope,
	DaemonCommandId,
	DaemonEventEnvelope,
	DaemonEventId,
	DaemonEventMeta,
	DaemonEventSequence,
	DaemonOutbound,
	DaemonProtocolInfo,
	DaemonProtocolName,
	DaemonProtocolVersion,
	DaemonReplayInfo,
	DaemonReplayStatus,
	DaemonResponse,
	DaemonResumeCursor,
	DaemonSessionSnapshot,
} from "./daemon/daemon-protocol.ts";
export {
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_NAME,
	DAEMON_PROTOCOL_VERSION,
} from "./daemon/daemon-protocol.ts";
export type { SessionActivity, SessionLifecycle, SessionSummary } from "./daemon/daemon-session-list.ts";
export { resolveAttachModelFallbackMessage } from "./daemon/daemon-session-list.ts";
export { defaultDaemonSocketPath, normalizeSocketPath } from "./daemon/daemon-socket.ts";
export { runDaemonSupervisorMode } from "./daemon/daemon-supervisor.ts";
export {
	type InteractiveInitialPrompt,
	InteractiveMode,
	type InteractiveModeOptions,
	type InteractiveModeRunResult,
} from "./interactive/interactive-mode.ts";
export {
	createInteractiveModeLocalSessionHost,
	createInteractiveModeUiServices,
	createInteractiveModeUiServicesFromServices,
	type InteractiveModeLocalSessionHost,
	type InteractiveModeUiServices,
} from "./interactive/interactive-mode-services.ts";
export {
	ClientPromptStashStore,
	type PromptStash,
	type PromptStashState,
} from "./interactive/prompt-stash-state.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode, runPrintModeWithConnection } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode, runRpcModeWithConnection } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
