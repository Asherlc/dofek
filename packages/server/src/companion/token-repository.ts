import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  executeWithSchema,
  type SchemaExecutionDatabase,
  timestampStringSchema,
} from "../lib/typed-sql.ts";
import {
  type CompanionConnectionType,
  companionConnectionTypeSchema,
  DEFAULT_COMPANION_CONNECTION_TYPE,
} from "./connection-type.ts";

const companionTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  connection_type: companionConnectionTypeSchema,
  created_at: timestampStringSchema,
  revoked_at: timestampStringSchema.nullable(),
});
const advisoryLockRowSchema = z.object({ acquired: z.boolean() });

export interface CompanionTokenMetadata {
  id: string;
  connectionType: CompanionConnectionType;
  token: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type ExecutableDatabase = SchemaExecutionDatabase;
interface TransactionalDatabase {
  transaction: <T>(callback: (transaction: ExecutableDatabase) => Promise<T>) => Promise<T>;
}

export function generateCompanionToken(): string {
  return `dofek_companion_${randomBytes(32).toString("base64url")}`;
}

export function hashCompanionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function findActiveCompanionToken(
  db: ExecutableDatabase,
  userId: string,
  connectionType: CompanionConnectionType,
): Promise<z.infer<typeof companionTokenRowSchema> | null> {
  const rows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`SELECT id, user_id, connection_type, created_at, revoked_at
        FROM fitness.companion_token
        WHERE user_id = ${userId}
          AND connection_type = ${connectionType}
          AND revoked_at IS NULL
        LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function createOrGetCompanionToken(
  db: ExecutableDatabase,
  userId: string,
  connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
): Promise<CompanionTokenMetadata> {
  const token = generateCompanionToken();
  const tokenHash = hashCompanionToken(token);

  const insertRows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`INSERT INTO fitness.companion_token (user_id, connection_type, token_hash)
        VALUES (${userId}, ${connectionType}, ${tokenHash})
        ON CONFLICT (user_id, connection_type) WHERE revoked_at IS NULL
        DO NOTHING
        RETURNING id, user_id, connection_type, created_at, revoked_at`,
  );
  const insertedRow = insertRows[0];
  if (insertedRow) {
    return {
      id: insertedRow.id,
      connectionType: insertedRow.connection_type,
      token,
      createdAt: insertedRow.created_at,
      revokedAt: insertedRow.revoked_at,
    };
  }

  const existingRow = await findActiveCompanionToken(db, userId, connectionType);
  if (!existingRow) {
    throw new Error("Failed to create companion token");
  }
  return {
    id: existingRow.id,
    connectionType: existingRow.connection_type,
    token: null,
    createdAt: existingRow.created_at,
    revokedAt: existingRow.revoked_at,
  };
}

export async function regenerateCompanionToken(
  db: TransactionalDatabase,
  userId: string,
  connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
): Promise<CompanionTokenMetadata> {
  return db.transaction((transaction) =>
    regenerateCompanionTokenInTransaction(transaction, userId, connectionType),
  );
}

export async function regenerateCompanionTokenInTransaction(
  transaction: ExecutableDatabase,
  userId: string,
  connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
): Promise<CompanionTokenMetadata> {
  const lockRows = await executeWithSchema(
    transaction,
    advisoryLockRowSchema,
    sql`SELECT pg_try_advisory_xact_lock(
          hashtext(${userId} || ':' || ${connectionType})
        ) AS acquired`,
  );
  if (!lockRows[0]?.acquired) {
    const activeToken = await findActiveCompanionToken(transaction, userId, connectionType);
    if (!activeToken) {
      throw new Error("Companion token regeneration is already in progress");
    }
    return {
      id: activeToken.id,
      connectionType: activeToken.connection_type,
      token: null,
      createdAt: activeToken.created_at,
      revokedAt: activeToken.revoked_at,
    };
  }
  await transaction.execute(
    sql`UPDATE fitness.companion_token
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE user_id = ${userId}
          AND connection_type = ${connectionType}
          AND revoked_at IS NULL`,
  );
  return createOrGetCompanionToken(transaction, userId, connectionType);
}

export async function listActiveCompanionTokens(
  db: ExecutableDatabase,
  userId: string,
): Promise<CompanionTokenMetadata[]> {
  const rows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`SELECT id, user_id, connection_type, created_at, revoked_at
        FROM fitness.companion_token
        WHERE user_id = ${userId} AND revoked_at IS NULL
        ORDER BY connection_type`,
  );
  return rows.map((row) => ({
    id: row.id,
    connectionType: row.connection_type,
    token: null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }));
}

export async function revokeCompanionToken(
  db: ExecutableDatabase,
  userId: string,
  connectionType: CompanionConnectionType,
): Promise<boolean> {
  const rows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`UPDATE fitness.companion_token
        SET revoked_at = NOW()
        WHERE user_id = ${userId}
          AND connection_type = ${connectionType}
          AND revoked_at IS NULL
        RETURNING id, user_id, connection_type, created_at, revoked_at`,
  );
  return rows.length > 0;
}

export async function revokeCompanionTokenByToken(
  db: ExecutableDatabase,
  token: string,
): Promise<boolean> {
  const tokenHash = hashCompanionToken(token);
  const rows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`UPDATE fitness.companion_token
        SET revoked_at = NOW()
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        RETURNING id, user_id, connection_type, created_at, revoked_at`,
  );
  return rows.length > 0;
}

export async function getActiveCompanionTokenByToken(
  db: ExecutableDatabase,
  token: string,
): Promise<{ userId: string; connectionType: CompanionConnectionType } | null> {
  const tokenHash = hashCompanionToken(token);
  const rows = await executeWithSchema(
    db,
    z.object({
      user_id: z.string(),
      connection_type: companionConnectionTypeSchema,
    }),
    sql`SELECT user_id, connection_type
        FROM fitness.companion_token
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        LIMIT 1`,
  );
  const row = rows[0];
  return row ? { userId: row.user_id, connectionType: row.connection_type } : null;
}

export async function validateCompanionToken(
  db: ExecutableDatabase,
  token: string,
): Promise<string | null> {
  const connection = await getActiveCompanionTokenByToken(db, token);
  return connection?.userId ?? null;
}
