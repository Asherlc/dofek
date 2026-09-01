import { createHash } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Database } from "dofek/db";
import type { Response } from "express";
import { z } from "zod";
import { McpOAuthClientMetadataResolver } from "./oauth-client-metadata.ts";
import { McpOAuthClientResolver } from "./oauth-client-resolver.ts";
import { McpOAuthClientsStore } from "./oauth-client-store.ts";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  getAuthorizationCodeChallenge,
  revokeOAuthToken,
  rotateRefreshToken,
} from "./oauth-repository.ts";
import { type McpScope, mcpScopeSchema, validateMcpToken } from "./token-repository.ts";

export const MCP_OAUTH_SCOPES = [
  "health:read",
  "activity:read",
  "nutrition:read",
  "providers:read",
  "sync:write",
] as const satisfies readonly McpScope[];

const authorizeLocalsSchema = z.object({
  mcpOAuthUserId: z.string(),
  mcpOAuthApproval: z.string().optional(),
});

const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "activity:read": "Search your activities",
  "health:read": "View your daily health summaries",
  "nutrition:read": "View your nutrition summaries",
  "providers:read": "View your connected data sources",
  "sync:write": "Start data synchronization",
};

function parseScopes(scopes: readonly string[] | undefined): McpScope[] {
  const requestedScopes = scopes && scopes.length > 0 ? scopes : [...MCP_OAUTH_SCOPES];
  const parsed = mcpScopeSchema.array().safeParse(requestedScopes);
  if (!parsed.success) {
    throw new InvalidScopeError("One or more requested scopes are not supported");
  }
  return parsed.data;
}

const HTML_ESCAPE_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#039;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&"'<>]/g, (char) => HTML_ESCAPE_REPLACEMENTS[char] ?? char);
}

function hiddenInput(name: string, value: string | undefined): string {
  return value === undefined
    ? ""
    : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function consentHtml(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  scopes: readonly McpScope[],
  resource: URL,
): string {
  const scopeItems = scopes
    .map((scope) => `<li>${escapeHtml(MCP_SCOPE_LABELS[scope])}</li>`)
    .join("");
  const clientName = escapeHtml(client.client_name ?? "the MCP client");
  const fields = [
    hiddenInput("client_id", client.client_id),
    hiddenInput("redirect_uri", params.redirectUri),
    hiddenInput("response_type", "code"),
    hiddenInput("code_challenge", params.codeChallenge),
    hiddenInput("code_challenge_method", "S256"),
    hiddenInput("scope", scopes.join(" ")),
    hiddenInput("state", params.state),
    hiddenInput("resource", resource.href),
  ].join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${clientName}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1.5rem; color: #17202a; }
    .card { border: 1px solid #d5d8dc; border-radius: 0.75rem; padding: 1.5rem; }
    button { border: 0; border-radius: 0.5rem; cursor: pointer; font: inherit; padding: 0.75rem 1rem; }
    .approve { background: #17202a; color: white; }
    .deny { background: #eaeded; color: #17202a; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Allow ${clientName} to access Dofek?</h1>
    <p>${clientName} is requesting these permissions:</p>
    <ul>${scopeItems}</ul>
    <form method="post" action="/authorize">
      ${fields}
      <div class="actions">
        <button class="approve" type="submit" name="approval" value="approve">Allow</button>
        <button class="deny" type="submit" name="approval" value="deny">Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function redirectWithError(params: AuthorizationParams, error: string): string {
  const target = new URL(params.redirectUri);
  target.searchParams.set("error", error);
  if (params.state) target.searchParams.set("state", params.state);
  return target.href;
}

/** Display name stored on MCP access tokens issued via OAuth. */
export function oauthAccessTokenName(client: OAuthClientInformationFull): string {
  const clientName = client.client_name?.trim();
  return clientName ? `${clientName} OAuth` : "MCP OAuth";
}

export class DofekOAuthServerProvider implements OAuthServerProvider {
  readonly #db: Pick<Database, "execute">;
  readonly #resource: URL;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(db: Pick<Database, "execute">, resource: URL) {
    this.#db = db;
    this.#resource = resource;
    this.clientsStore = new McpOAuthClientResolver(
      new McpOAuthClientsStore(db),
      new McpOAuthClientMetadataResolver(),
    );
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    const resource = params.resource;
    if (!resource || resource.href !== this.#resource.href) {
      throw new InvalidTargetError("The requested resource is not the Dofek MCP server");
    }
    const scopes = parseScopes(params.scopes);
    const localsResult = authorizeLocalsSchema.safeParse(response.locals);
    if (!localsResult.success) {
      throw new AccessDeniedError("Missing OAuth session context");
    }
    const { mcpOAuthApproval: approval, mcpOAuthUserId: userId } = localsResult.data;
    if (approval === "deny") {
      response.redirect(
        redirectWithError(params, new AccessDeniedError("Access denied").errorCode),
      );
      return;
    }
    if (approval !== "approve") {
      response.type("html").send(consentHtml(client, params, scopes, resource));
      return;
    }

    const code = await createAuthorizationCode(this.#db, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: this.#resource.href,
      scopes,
      userId,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    response.redirect(target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const challenge = await getAuthorizationCodeChallenge(
      this.#db,
      client.client_id,
      authorizationCode,
    );
    if (!challenge) throw new InvalidGrantError("Invalid or expired authorization code");
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const resolvedRedirectUri = redirectUri ?? client.redirect_uris[0];
    if (!resolvedRedirectUri || resource?.href !== this.#resource.href) {
      throw new InvalidGrantError("Authorization code parameters do not match");
    }

    if (codeVerifier) {
      const storedChallenge = await getAuthorizationCodeChallenge(
        this.#db,
        client.client_id,
        authorizationCode,
      );
      if (!storedChallenge) {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      const computedChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      if (computedChallenge !== storedChallenge) {
        throw new InvalidGrantError("PKCE code_verifier does not match challenge");
      }
    }

    const tokens = await exchangeAuthorizationCode(this.#db, {
      clientId: client.client_id,
      code: authorizationCode,
      name: oauthAccessTokenName(client),
      redirectUri: resolvedRedirectUri,
      resource: this.#resource.href,
    });
    if (!tokens) throw new InvalidGrantError("Invalid or expired authorization code");
    return {
      access_token: tokens.accessToken,
      expires_in: tokens.accessTokenExpiresInSeconds,
      refresh_token: tokens.refreshToken,
      scope: tokens.scopes.join(" "),
      token_type: "bearer",
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    requestedScopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (resource?.href !== this.#resource.href) {
      throw new InvalidGrantError("Refresh token resource does not match");
    }
    const scopes = requestedScopes ? parseScopes(requestedScopes) : undefined;
    const tokens = await rotateRefreshToken(this.#db, {
      clientId: client.client_id,
      name: oauthAccessTokenName(client),
      refreshToken,
      requestedScopes: scopes,
      resource: this.#resource.href,
    });
    if (!tokens) throw new InvalidGrantError("Invalid, expired, or reused refresh token");
    return {
      access_token: tokens.accessToken,
      expires_in: tokens.accessTokenExpiresInSeconds,
      refresh_token: tokens.refreshToken,
      scope: tokens.scopes.join(" "),
      token_type: "bearer",
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const validated = await validateMcpToken(this.#db, token);
    if (!validated?.oauthClientId || validated.oauthResource !== this.#resource.href) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      clientId: validated.oauthClientId,
      expiresAt: validated.expiresAt
        ? Math.floor(new Date(validated.expiresAt).getTime() / 1000)
        : undefined,
      extra: { userId: validated.userId },
      resource: this.#resource,
      scopes: validated.scopes,
      token,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await revokeOAuthToken(this.#db, client.client_id, request.token);
  }
}
