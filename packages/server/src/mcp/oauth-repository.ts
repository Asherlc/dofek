import { randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  generateMcpToken,
  hashMcpToken,
  type McpScope,
  mcpScopeSchema,
} from "./token-repository.ts";

const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

type ExecutableDatabase = Pick<Database, "execute">;

export interface OAuthTokenPair {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  scopes: McpScope[];
}

const tokenGrantRowSchema = z.object({
  scopes: z.array(mcpScopeSchema),
  user_id: z.string(),
});
const refreshTokenRowSchema = z.object({
  access_token_id: z.string(),
  id: z.string(),
  resource: z.string(),
  scopes: z.array(mcpScopeSchema),
  user_id: z.string(),
});

async function revokeRefreshTokenFamily(
  db: ExecutableDatabase,
  refreshTokenId: string,
): Promise<void> {
  await db.execute(
    sql`WITH RECURSIVE refresh_token_family AS (
          SELECT id, access_token_id
          FROM fitness.mcp_oauth_refresh_token
          WHERE id = ${refreshTokenId}::uuid
            AND revoked_at IS NOT NULL
          UNION ALL
          SELECT child.id, child.access_token_id
          FROM fitness.mcp_oauth_refresh_token child
          JOIN refresh_token_family parent
            ON child.parent_refresh_token_id = parent.id
        ), revoked_refresh_tokens AS (
          UPDATE fitness.mcp_oauth_refresh_token
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE id IN (SELECT id FROM refresh_token_family)
          RETURNING access_token_id
        )
        UPDATE fitness.mcp_access_token
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id IN (SELECT access_token_id FROM revoked_refresh_tokens)`,
  );
}

function generateRefreshToken(): string {
  return `dofek_mcp_refresh_${randomBytes(32).toString("base64url")}`;
}

function scopesSql(scopes: readonly McpScope[]) {
  return sql`ARRAY[${sql.join(
    scopes.map((scope) => sql`${scope}`),
    sql`, `,
  )}]::text[]`;
}

export async function rotateRefreshToken(
  db: ExecutableDatabase,
  input: {
    clientId: string;
    name: string;
    refreshToken: string;
    requestedScopes?: McpScope[];
    resource: string;
  },
): Promise<OAuthTokenPair | null> {
  const refreshTokenHash = hashMcpToken(input.refreshToken);
  const refreshRows = await executeWithSchema(
    db,
    refreshTokenRowSchema,
    sql`SELECT id, user_id, access_token_id, scopes, resource
        FROM fitness.mcp_oauth_refresh_token
        WHERE token_hash = ${refreshTokenHash}
          AND client_id = ${input.clientId}
        LIMIT 1`,
  );
  const existingToken = refreshRows[0];
  if (!existingToken || existingToken.resource !== input.resource) return null;

  if (input.requestedScopes?.some((scope) => !existingToken.scopes.includes(scope))) return null;
  // Scope edits are managed on the stored grant. Preserve that grant when a
  // client sends a narrower refresh request so token refresh cannot silently
  // remove permissions the user already approved.
  const scopes = existingToken.scopes;

  const accessToken = generateMcpToken();
  const nextRefreshToken = generateRefreshToken();
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
  const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_SECONDS * 1000);
  const rows = await executeWithSchema(
    db,
    tokenGrantRowSchema,
    sql`WITH consumed_refresh_token AS (
          UPDATE fitness.mcp_oauth_refresh_token
          SET revoked_at = NOW()
          WHERE token_hash = ${refreshTokenHash}
            AND client_id = ${input.clientId}
            AND resource = ${input.resource}
            AND revoked_at IS NULL
            AND expires_at > NOW()
          RETURNING id, user_id, access_token_id
        ), revoked_access_token AS (
          UPDATE fitness.mcp_access_token
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE id IN (SELECT access_token_id FROM consumed_refresh_token)
        ), new_access_token AS (
          INSERT INTO fitness.mcp_access_token (
            user_id, name, token_hash, scopes, expires_at, oauth_client_id, oauth_resource
          )
          SELECT user_id, ${input.name}, ${hashMcpToken(accessToken)}, ${scopesSql(scopes)},
                 ${accessTokenExpiresAt}, ${input.clientId}, ${input.resource}
          FROM consumed_refresh_token
          RETURNING id, user_id, scopes
        ), new_refresh_token AS (
          INSERT INTO fitness.mcp_oauth_refresh_token (
            token_hash, client_id, user_id, access_token_id, parent_refresh_token_id,
            scopes, resource, expires_at
          )
          SELECT ${hashMcpToken(nextRefreshToken)}, ${input.clientId}, new_access_token.user_id,
                 new_access_token.id, consumed_refresh_token.id, new_access_token.scopes,
                 ${input.resource}, ${refreshTokenExpiresAt}
          FROM new_access_token
          CROSS JOIN consumed_refresh_token
          RETURNING user_id, scopes
        )
        SELECT user_id, scopes FROM new_refresh_token`,
  );
  const grant = rows[0];
  if (!grant) {
    await revokeRefreshTokenFamily(db, existingToken.id);
    return null;
  }
  return {
    accessToken,
    accessTokenExpiresInSeconds: ACCESS_TOKEN_LIFETIME_SECONDS,
    refreshToken: nextRefreshToken,
    scopes: grant.scopes,
  };
}
