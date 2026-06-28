import { createHash, randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

const companionTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  created_at: timestampStringSchema,
  revoked_at: timestampStringSchema.nullable(),
});

export interface CompanionTokenMetadata {
  id: string;
  token: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type ExecutableDatabase = Pick<Database, "execute">;

export function generateCompanionToken(): string {
  return `dofek_companion_${randomBytes(32).toString("base64url")}`;
}

export function hashCompanionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createOrGetCompanionToken(
  db: ExecutableDatabase,
  userId: string,
): Promise<CompanionTokenMetadata> {
  const token = generateCompanionToken();
  const tokenHash = hashCompanionToken(token);

  const insertRows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`INSERT INTO fitness.companion_token (user_id, token_hash)
        VALUES (${userId}, ${tokenHash})
        ON CONFLICT (user_id) WHERE revoked_at IS NULL
        DO NOTHING
        RETURNING id, user_id, created_at, revoked_at`,
  );
  const insertedRow = insertRows[0];
  if (insertedRow) {
    return {
      id: insertedRow.id,
      token,
      createdAt: insertedRow.created_at,
      revokedAt: insertedRow.revoked_at,
    };
  }

  const existingRows = await executeWithSchema(
    db,
    companionTokenRowSchema,
    sql`SELECT id, user_id, created_at, revoked_at
        FROM fitness.companion_token
        WHERE user_id = ${userId} AND revoked_at IS NULL
        LIMIT 1`,
  );
  const existingRow = existingRows[0];
  if (!existingRow) {
    throw new Error("Failed to create companion token");
  }
  return {
    id: existingRow.id,
    token: null,
    createdAt: existingRow.created_at,
    revokedAt: existingRow.revoked_at,
  };
}

export async function regenerateCompanionToken(
  db: ExecutableDatabase,
  userId: string,
): Promise<CompanionTokenMetadata> {
  await db.execute(sql`BEGIN`);
  try {
    await db.execute(
      sql`UPDATE fitness.companion_token
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE user_id = ${userId} AND revoked_at IS NULL`,
    );
    const result = await createOrGetCompanionToken(db, userId);
    await db.execute(sql`COMMIT`);
    return result;
  } catch (error) {
    await db.execute(sql`ROLLBACK`);
    throw error;
  }
}

export async function validateCompanionToken(
  db: ExecutableDatabase,
  token: string,
): Promise<string | null> {
  const tokenHash = hashCompanionToken(token);
  const rows = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id
        FROM fitness.companion_token
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  return row.user_id;
}
