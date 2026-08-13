/**
 * Shims for pi-ai symbols that prime-agent's interactive TUI expects but
 * pi-ai 0.84 does not export from the root package: ServiceTier and
 * supportsFastMode. MCP catalog is re-exported from @earendil-works/pi-ai/mcp.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { BUILTIN_MCP_CATALOG, type McpCatalogEntry } from "@earendil-works/pi-ai/mcp";
import type { ServiceTier } from "../../daemon/prime-port-ai-compat.ts";

export type { ServiceTier };
export type { McpCatalogEntry };
export { BUILTIN_MCP_CATALOG };

export function supportsFastMode<TApi extends Api>(model: Model<TApi>): boolean {
	return (
		model.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		(model.id === "gpt-5.4" || model.id === "gpt-5.5" || model.id === "gpt-5.6" || model.id.startsWith("gpt-5.6-"))
	);
}
