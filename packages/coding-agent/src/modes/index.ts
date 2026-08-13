/**
 * Run modes for the coding agent.
 */

export {
	type AcpModeOptions,
	type AcpStopReason,
	acpStopReason,
	acpToolKind,
	acpUpdatesForSessionEvent,
	bashToolCallId,
	PRIME_AGENT_META_NAMESPACE,
	primeAgentMeta,
	runAcpMode,
	runAcpModeWithConnection,
} from "./acp/index.ts";
export { InProcessAgentConnection } from "./agent-connection/in-process-agent-connection.ts";
export type { AgentConnection } from "./agent-connection/types.ts";
export {
	type AgentsViewModeOptions,
	type AgentsViewRunResult,
	runAgentsViewMode,
} from "./agents-view/agents-view-mode.ts";
export {
	BrandSplashHeader,
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
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
