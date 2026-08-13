// Runtime registry for MCP OAuth providers (`mcp:<server>`). Separate from model-provider OAuth.

import type { OAuthAuth } from "../auth/types.ts";

export type McpOAuthProvider = OAuthAuth & {
	id: string;
	usesCallbackServer?: boolean;
};

const mcpOAuthProviders = new Map<string, McpOAuthProvider>();

export function getMcpOAuthProvider(id: string): McpOAuthProvider | undefined {
	return mcpOAuthProviders.get(id);
}

export function getMcpOAuthProviders(): McpOAuthProvider[] {
	return Array.from(mcpOAuthProviders.values());
}

export function registerMcpOAuthProvider(provider: McpOAuthProvider): void {
	mcpOAuthProviders.set(provider.id, provider);
}

export function unregisterMcpOAuthProvider(id: string): void {
	mcpOAuthProviders.delete(id);
}

export function resetMcpOAuthProviders(): void {
	mcpOAuthProviders.clear();
}
