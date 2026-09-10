import { createHash, randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export const mcpScopeSchema = z.enum([
  "health:read",
  "health:write",
  "activity:read",
  "nutrition:read",
  "nutrition:write",
  "providers:read",
  "sync:write",
]);

export type McpScope = z.infer<typeof mcpScopeSchema>;

export interface CreateMcpTokenInput {
  userId: string;
  name: string;
  scopes: McpScope[];
  expiresAt: Date | null;
  oauthClientId?: string;
  oauthResource?: string;
}

export interface ValidMcpToken {
  tokenId: string;
  userId: string;
  scopes: McpScope[];
  expiresAt: string | null;
  oauthClientId: string | null;
  oauthResource: string | null;
}

export const mcpTokenMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(mcpScopeSchema),
  createdAt: timestampStringSchema,
  lastUsedAt: timestampStringSchema.nullable(),
  expiresAt: timestampStringSchema.nullable(),
  revokedAt: timestampStringSchema.nullable(),
  oauthClientId: z.string().nullable(),
});

export type McpTokenMetadata = z.infer<typeof mcpTokenMetadataSchema>;

export const mcpTokenPageSchema = z.object({
  items: z.array(mcpTokenMetadataSchema),
  nextCursor: z.string().nullable(),
});

export type McpTokenPage = z.infer<typeof mcpTokenPageSchema>;

export class McpAuthError extends Error {
  readonly status: 401 | 403;
  readonly code: "invalid_token" | "insufficient_scope";

  constructor(status: 401 | 403, code: "invalid_token" | "insufficient_scope", message: string) {
    super(message);
    this.name = "McpAuthError";
    this.status = status;
    this.code = code;
  }
}

const tokenMetadataRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(mcpScopeSchema),
  created_at: timestampStringSchema,
  last_used_at: timestampStringSchema.nullable().optional(),
  expires_at: timestampStringSchema.nullable().optional(),
  revoked_at: timestampStringSchema.nullable().optional(),
  oauth_client_id: z.string().nullable().optional(),
});

const validTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  scopes: z.array(mcpScopeSchema),
  expires_at: timestampStringSchema.nullable(),
  revoked_at: timestampStringSchema.nullable(),
  oauth_client_id: z.string().nullable(),
  oauth_resource: z.string().nullable(),
});

type ExecutableDatabase = Pick<Database, "execute">;

function toMetadata(row: z.infer<typeof tokenMetadataRowSchema>): McpTokenMetadata {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    oauthClientId: row.oauth_client_id ?? null,
  };
}

export function generateMcpToken(): string {
  return `dofek_mcp_${randomBytes(32).toString("base64url")}`;
}

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createMcpToken(
  db: ExecutableDatabase,
  input: CreateMcpTokenInput,
): Promise<{ token: string; metadata: McpTokenMetadata }> {
  const token = generateMcpToken();
  const tokenHash = hashMcpToken(token);
  const scopesArray = sql`ARRAY[${sql.join(
    input.scopes.map((scope) => sql`${scope}`),
    sql`, `,
  )}]::text[]`;
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`INSERT INTO fitness.mcp_access_token (
          user_id, name, token_hash, scopes, expires_at, oauth_client_id, oauth_resource
        )
        VALUES (
          ${input.userId}, ${input.name}, ${tokenHash}, ${scopesArray}, ${input.expiresAt},
          ${input.oauthClientId ?? null}, ${input.oauthResource ?? null}
        )
        RETURNING id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to create MCP token");
  }
  return { token, metadata: toMetadata(row) };
}

export async function validateMcpToken(
  db: ExecutableDatabase,
  token: string,
): Promise<ValidMcpToken | null> {
  const tokenHash = hashMcpToken(token);
  const rows = await executeWithSchema(
    db,
    validTokenRowSchema,
    sql`SELECT id, user_id, scopes, expires_at, revoked_at, oauth_client_id, oauth_resource
        FROM fitness.mcp_access_token
        WHERE token_hash = ${tokenHash}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= new Date())) {
    return null;
  }

  await db.execute(
    sql`UPDATE fitness.mcp_access_token
        SET last_used_at = NOW()
        WHERE id = ${row.id}::uuid`,
  );

  return {
    tokenId: row.id,
    userId: row.user_id,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    oauthClientId: row.oauth_client_id,
    oauthResource: row.oauth_resource,
  };
}

export async function listMcpTokens(
  db: ExecutableDatabase,
  userId: string,
): Promise<McpTokenMetadata[]> {
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        FROM fitness.mcp_access_token
        WHERE user_id = ${userId}
        ORDER BY created_at DESC`,
  );
  return rows.map(toMetadata);
}

export async function listMcpPersonalTokens(
  db: ExecutableDatabase,
  userId: string,
): Promise<McpTokenMetadata[]> {
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        FROM fitness.mcp_access_token
        WHERE user_id = ${userId} AND oauth_client_id IS NULL
        ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(toMetadata);
}

export async function listMcpConnectedApps(
  db: ExecutableDatabase,
  userId: string,
  cursor?: string,
): Promise<McpTokenPage> {
  const connectedAppsPageSize = 20;
  const cursorCondition = cursor
    ? sql`AND (created_at, id) < (
          SELECT created_at, id
          FROM fitness.mcp_access_token
          WHERE id = ${cursor}::uuid AND user_id = ${userId} AND oauth_client_id IS NOT NULL
        )`
    : sql``;
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        FROM fitness.mcp_access_token
        WHERE user_id = ${userId} AND oauth_client_id IS NOT NULL
          ${cursorCondition}
        ORDER BY created_at DESC, id DESC
        LIMIT ${connectedAppsPageSize + 1}`,
  );
  const hasNextPage = rows.length > connectedAppsPageSize;
  const items = rows.slice(0, connectedAppsPageSize).map(toMetadata);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: hasNextPage && lastItem ? lastItem.id : null,
  };
}

export async function updateMcpTokenScopes(
  db: ExecutableDatabase,
  userId: string,
  tokenId: string,
  scopes: McpScope[],
): Promise<McpTokenMetadata | null> {
  const scopesArray = sql`ARRAY[${sql.join(
    scopes.map((scope) => sql`${scope}`),
    sql`, `,
  )}]::text[]`;
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`WITH updated_token AS (
          UPDATE fitness.mcp_access_token
          SET scopes = ${scopesArray}
          WHERE id = ${tokenId}::uuid AND user_id = ${userId} AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        ), updated_refresh_tokens AS (
          UPDATE fitness.mcp_oauth_refresh_token refresh
          SET scopes = updated_token.scopes
          FROM updated_token
          WHERE refresh.access_token_id = updated_token.id
            AND refresh.revoked_at IS NULL
        )
        SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        FROM updated_token`,
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

export async function revokeMcpToken(
  db: ExecutableDatabase,
  userId: string,
  tokenId: string,
): Promise<McpTokenMetadata | null> {
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`WITH RECURSIVE target AS (
          SELECT id, user_id, oauth_client_id, oauth_resource
          FROM fitness.mcp_access_token
          WHERE id = ${tokenId}::uuid AND user_id = ${userId}
          LIMIT 1
        ), refresh_token_family AS (
          SELECT refresh.id, refresh.access_token_id
          FROM fitness.mcp_oauth_refresh_token refresh
          JOIN target ON target.id = refresh.access_token_id
          WHERE target.oauth_client_id IS NOT NULL
          UNION ALL
          SELECT child.id, child.access_token_id
          FROM fitness.mcp_oauth_refresh_token child
          JOIN refresh_token_family parent
            ON child.parent_refresh_token_id = parent.id
        ), revoked_refresh_tokens AS (
          UPDATE fitness.mcp_oauth_refresh_token refresh
          SET revoked_at = COALESCE(refresh.revoked_at, NOW())
          WHERE refresh.id IN (SELECT id FROM refresh_token_family)
          RETURNING refresh.access_token_id
        ), revoked_access_tokens AS (
          UPDATE fitness.mcp_access_token token
          SET revoked_at = COALESCE(token.revoked_at, NOW())
          WHERE token.id IN (
            SELECT id FROM target
            UNION
            SELECT access_token_id FROM revoked_refresh_tokens
          )
          RETURNING token.id, token.name, token.scopes, token.created_at, token.last_used_at,
                    token.expires_at, token.revoked_at, token.oauth_client_id
        )
        SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at, oauth_client_id
        FROM revoked_access_tokens
        WHERE id IN (SELECT id FROM target)`,
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

export function requireMcpScope(scopes: readonly McpScope[], requiredScope: McpScope): void {
  if (!scopes.includes(requiredScope)) {
    throw new McpAuthError(403, "insufficient_scope", `MCP token requires scope: ${requiredScope}`);
  }
}
