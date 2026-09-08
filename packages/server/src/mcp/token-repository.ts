import { createHash, randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export const mcpScopeSchema = z.enum([
  "health:read",
  "activity:read",
  "nutrition:read",
  "nutrition:write",
  "providers:read",
  "sync:write",
]);

export type McpScope = z.infer<typeof mcpScopeSchema>;

export interface McpTokenMetadata {
  id: string;
  name: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

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
        RETURNING id, name, scopes, created_at, last_used_at, expires_at, revoked_at`,
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
    sql`SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at
        FROM fitness.mcp_access_token
        WHERE user_id = ${userId}
        ORDER BY created_at DESC`,
  );
  return rows.map(toMetadata);
}

export async function revokeMcpToken(
  db: ExecutableDatabase,
  userId: string,
  tokenId: string,
): Promise<McpTokenMetadata | null> {
  const rows = await executeWithSchema(
    db,
    tokenMetadataRowSchema,
    sql`UPDATE fitness.mcp_access_token
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id = ${tokenId}::uuid AND user_id = ${userId}
        RETURNING id, name, scopes, created_at, last_used_at, expires_at, revoked_at`,
  );
  return rows[0] ? toMetadata(rows[0]) : null;
}

export function requireMcpScope(scopes: readonly McpScope[], requiredScope: McpScope): void {
  if (!scopes.includes(requiredScope)) {
    throw new McpAuthError(403, "insufficient_scope", `MCP token requires scope: ${requiredScope}`);
  }
}
