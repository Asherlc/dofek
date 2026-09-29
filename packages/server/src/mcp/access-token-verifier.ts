import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import type { Provider } from "oidc-provider";
import { z } from "zod";
import {
  type McpScope,
  markMcpConnectedAppUsed,
  mcpScopeSchema,
  validateMcpToken,
} from "./token-repository.ts";

export const PERSONAL_TOKEN_PREFIX = "dofek_mcp_";

export type VerifiedMcpPrincipal =
  | {
      kind: "oauth";
      tokenId: string;
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

export function isPersonalAccessToken(token: string): boolean {
  return token.startsWith(PERSONAL_TOKEN_PREFIX);
}

export interface VerifyMcpAccessTokenOptions {
  db: Pick<Database, "execute">;
  provider: Pick<Provider, "AccessToken">;
  resourceUrl: string;
}

const oauthTokenSchema = z.object({
  accountId: z.string().min(1),
  clientId: z.string().min(1),
  jti: z.string().min(1),
  aud: z.string(),
  scope: z.string(),
  exp: z.number().int().positive(),
});

/** Use the issuer's built-in opaque-token lookup, expiry checks, and canonical adapter state. */
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

  let artifact: unknown;
  try {
    artifact = await options.provider.AccessToken.find(token);
  } catch (error) {
    captureException(error, { tags: { source: "mcp-access-token-verification" } });
    throw error;
  }
  const parsed = oauthTokenSchema.safeParse(artifact);
  if (!parsed.success || parsed.data.aud !== options.resourceUrl) return null;
  const accessToken = parsed.data;
  const scopes = mcpScopeSchema.array().safeParse(accessToken.scope.split(" ").filter(Boolean));
  if (!scopes.success) return null;
  const expiresAt = new Date(accessToken.exp * 1000);
  if (!Number.isFinite(expiresAt.getTime())) return null;
  const tokenIdHash = createHash("sha256").update(accessToken.jti).digest("hex");
  if (!(await markMcpConnectedAppUsed(options.db, tokenIdHash))) return null;
  return {
    kind: "oauth",
    tokenId: accessToken.jti,
    userId: accessToken.accountId,
    clientId: accessToken.clientId,
    scopes: scopes.data,
    expiresAt: expiresAt.toISOString(),
  };
}
