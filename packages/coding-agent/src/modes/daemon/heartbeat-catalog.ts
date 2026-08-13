import type { AgentConnectionHeartbeat } from "../agent-connection/types.ts";
import type { DaemonClient } from "./daemon-client.ts";
import { deserializeDaemonError } from "./daemon-errors.ts";
import { isUnknownDaemonCommandError } from "./daemon-protocol.ts";

export async function listDaemonHeartbeats(
	client: DaemonClient,
	activeSessionId?: string,
): Promise<AgentConnectionHeartbeat[]> {
	if (!client.hello) await client.waitForHello();
	if (!client.supportsServerCapability("heartbeat_catalog")) return [];
	try {
		const command = { type: "heartbeats_list", ...(activeSessionId ? { activeSessionId } : {}) } as const;
		const response = await client.request(command);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		return (response.data as { heartbeats: AgentConnectionHeartbeat[] }).heartbeats;
	} catch (error) {
		if (isUnknownDaemonCommandError(error, "heartbeats_list")) {
			return [];
		}
		throw error;
	}
}
