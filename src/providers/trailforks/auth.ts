import { exchangeCodeForTokens, getOAuthRedirectUri, type OAuthConfig } from "../../auth/oauth.ts";
import { ProviderAuthorizationFailedError } from "../auth-errors.ts";
import type { ProviderAuthSetup } from "../types.ts";

/** Trailforks MCP protected resource (RFC 8707) for activities:read. */
export const TRAILFORKS_MCP_RESOURCE = "https://www.trailforks.com/mcp/account/";

/**
 * Public-client OAuth configuration for Trailforks MCP.
 * Requires TRAILFORKS_CLIENT_ID; no client secret (token_endpoint_auth_methods_supported: none).
 */
export function trailforksOAuthConfig(options?: { host?: string }): OAuthConfig | undefined {
  const clientId = process.env.TRAILFORKS_CLIENT_ID;
  if (!clientId) return undefined;

  return {
    clientId,
    authorizeUrl: "https://www.trailforks.com/mcp/oauth/authorize/",
    tokenUrl: "https://www.trailforks.com/mcp/oauth/token/",
    revokeUrl: "https://www.trailforks.com/mcp/oauth/revoke/",
    redirectUri: getOAuthRedirectUri(options?.host),
    scopes: ["activities:read"],
    usePkce: true,
    resource: TRAILFORKS_MCP_RESOURCE,
  };
}

export function validateTrailforksAuthConfiguration(): string | null {
  if (!process.env.TRAILFORKS_CLIENT_ID) return "TRAILFORKS_CLIENT_ID is not set";
  return null;
}

export function createTrailforksAuthSetup(
  options?: { host?: string },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ProviderAuthSetup | undefined {
  const config = trailforksOAuthConfig(options);
  if (!config) return undefined;

  return {
    oauthConfig: config,
    exchangeCode: async (code, codeVerifier) => {
      if (!codeVerifier?.trim()) {
        throw new Error("Trailforks OAuth code exchange requires a PKCE verifier");
      }
      try {
        return await exchangeCodeForTokens(config, code, fetchFn, { codeVerifier });
      } catch (error: unknown) {
        // Callback telemetry reports exchanged errors; never attach remote token bodies.
        if (error instanceof ProviderAuthorizationFailedError) throw error;
        throw new ProviderAuthorizationFailedError("Trailforks");
      }
    },
    apiBaseUrl: TRAILFORKS_MCP_RESOURCE,
  };
}
