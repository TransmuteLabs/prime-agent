import type { SessionInfo } from "../../core/session-manager.ts";
import type { AgentConnectionSavedSessionInfo } from "../agent-connection/types.ts";
import type { DaemonSavedSessionInfo } from "./daemon-protocol.ts";

function toSavedSessionState(state: SessionInfo["state"]): DaemonSavedSessionInfo["state"] {
	if (!state) {
		return undefined;
	}
	if (state.status === "active" || state.status === "archived" || state.status === "crash") {
		return { status: state.status };
	}
	return undefined;
}

export function serializeSavedSessionInfo(session: SessionInfo): DaemonSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: toSavedSessionState(session.state),
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: session.agentStatus,
	};
}

export function deserializeSavedSessionInfo(session: DaemonSavedSessionInfo): AgentConnectionSavedSessionInfo {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		state: session.state,
		parentSessionPath: session.parentSessionPath,
		rlmDepth: session.rlmDepth,
		created: new Date(session.created),
		modified: new Date(session.modified),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
		agentStatus: session.agentStatus,
	};
}
