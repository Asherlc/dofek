import type { Database } from "dofek/db";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type McpScope, mcpScopeSchema, validateMcpToken } from "./token-repository.ts";

/**
 * Dofek MCP access tokens come in two flavours that must both keep working:
 *
 *   1. **Personal tokens** — Dofek-native opaque tokens minted by
 *      `generateMcpToken()` (`dofek_mcp_<random>`), stored in
 *      `fitness.mcp_access_token` with `oauth_client_id IS NULL`. These are
 *      NOT JWTs and are validated via the existing `validateMcpToken` hash
 *      lookup.
 *
 *   2. **OAuth tokens** — JWT access tokens signed by oidc-provider
 *      (`accessTokenFormat: "jwt"`). Their signature, `exp`, `iss`, and
 *      `aud` are verified against oidc-provider's JWKS, and their `sub` carries
 *      the Dofek `userId` (oidc-provider's `accountId`, which `findAccount`
 *      maps verbatim from the session `userId`).
 */

export const PERSONAL_TOKEN_PREFIX = "dofek_mcp_";

/** A successfully verified principal, unified across both token kinds. */
export type VerifiedMcpPrincipal =
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      scopes: McpScope[];
      expiresAt: string | null;
    }
  | {
      kind: "personal_token";
      userId: string;
      tokenId: string;
      scopes: McpScope[];
      expiresAt: string | null;
    };

/** Whether a bearer token is a Dofek-native opaque personal token (vs an OAuth JWT). */
export function isPersonalAccessToken(token: string): boolean {
  return token.startsWith(PERSONAL_TOKEN_PREFIX);
}

/** oidc-provider resource defaults used to verify OAuth JWT access tokens. */
export interface JwtAccessTokenVerifierOptions {
  /** oidc-provider issuer (must match the JWT `iss`). */
  issuer: string;
  /** RFC 8707 resource identifier the token `aud` must equal. */
  resourceUrl: string;
  /** JWKS URL (defaults to `${issuer}/jwks`). */
  jwksUri?: string;
}

/**
 * Verify an oidc-provider JWT access token. The `getKey` resolver is injected
 * so unit tests can substitute a local key set; production resolves
 * oidc-provider's `/jwks` endpoint via `createRemoteJWKSet`, which caches the
 * key set and rotates it on key rollover.
 */
export async function verifyJwtAccessToken(
  token: string,
  options: JwtAccessTokenVerifierOptions,
  getKey: JWTVerifyGetKey,
): Promise<Extract<VerifiedMcpPrincipal, { kind: "oauth" }> | null> {
  try {
    const { payload } = await jwtVerify(token, getKey, {
      audience: options.resourceUrl,
      issuer: options.issuer,
    });

    const userId = typeof payload.sub === "string" ? payload.sub : null;
    const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
    if (!userId || !clientId) {
      return null;
    }

    const scope = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
    const parsedScopes = mcpScopeSchema.array().safeParse(scope);
    if (!parsedScopes.success) {
      return null;
    }

    const expiresAt =
      typeof payload.exp === "number" && Number.isFinite(payload.exp)
        ? new Date(payload.exp * 1000).toISOString()
        : null;

    return {
      kind: "oauth",
      userId,
      clientId,
      scopes: parsedScopes.data,
      expiresAt,
    };
  } catch {
    return null;
  }
}

let sharedJwtGetKey: JWTVerifyGetKey | null = null;

/**
 * Lazily-created, process-lifetime key resolver for oidc-provider's JWKS. The
 * remote JWKS is cached and rotated automatically by `createRemoteJWKSet`.
 */
export function getSharedJwtGetKey(jwksUri: string): JWTVerifyGetKey {
  if (!sharedJwtGetKey) {
    sharedJwtGetKey = createRemoteJWKSet(new URL(jwksUri));
  }
  return sharedJwtGetKey;
}

export interface VerifyMcpAccessTokenOptions extends JwtAccessTokenVerifierOptions {
  db: Pick<Database, "execute">;
}

/**
 * Verify an MCP bearer token by routing it to the correct path:
 *
 *   - Dofek personal tokens (`dofek_mcp_…`) fall through to the opaque
 *     `validateMcpToken` hash lookup.
 *   - Anything else is treated as an oidc-provider JWT and verified against
 *     its JWKS (signature, `iss`, `aud`, `exp`).
 */
export async function verifyMcpAccessToken(
  token: string,
  options: VerifyMcpAccessTokenOptions,
): Promise<VerifiedMcpPrincipal | null> {
  if (isPersonalAccessToken(token)) {
    const validated = await validateMcpToken(options.db, token);
    if (!validated) return null;
    return {
      kind: "personal_token",
      userId: validated.userId,
      tokenId: validated.tokenId,
      scopes: validated.scopes,
      expiresAt: validated.expiresAt,
    };
  }

  const jwksUri = options.jwksUri ?? `${options.issuer.replace(/\/+$/, "")}/jwks`;
  return verifyJwtAccessToken(token, options, getSharedJwtGetKey(jwksUri));
}
