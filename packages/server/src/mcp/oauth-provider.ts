import type { McpScope } from "./token-repository.ts";

export const MCP_OAUTH_SCOPES = [
  "health:read",
  "health:write",
  "activity:read",
  "nutrition:read",
  "nutrition:write",
  "providers:read",
  "sync:write",
] as const satisfies readonly McpScope[];

/** OAuth scope that permits clients to retain a refresh token without granting Dofek data access. */
export const MCP_OAUTH_OFFLINE_ACCESS_SCOPE = "offline_access";

export const MCP_OAUTH_SUPPORTED_SCOPES = [
  ...MCP_OAUTH_SCOPES,
  MCP_OAUTH_OFFLINE_ACCESS_SCOPE,
] as const;

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "activity:read": "Search your activities",
  "health:read": "View your daily health summaries",
  "health:write": "Log health observations",
  "nutrition:read": "View your nutrition summaries",
  "nutrition:write": "Modify your food records",
  "providers:read": "View your connected data sources",
  "sync:write": "Start data synchronization",
};
