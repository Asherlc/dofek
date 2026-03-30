import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const linkedAccountRowSchema = z.object({
  id: z.string(),
  auth_provider: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  created_at: timestampStringSchema,
});

const countRowSchema = z.object({ count: z.coerce.number() });

const idRowSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface LinkedAccount {
  id: string;
  authProvider: string;
  email: string | null;
  name: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for authentication accounts. */
export class AuthRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** All linked auth accounts for the user, ordered by creation date. */
  async getLinkedAccounts(): Promise<LinkedAccount[]> {
    const rows = await executeWithSchema(
      this.#db,
      linkedAccountRowSchema,
      sql`SELECT id, auth_provider, email, name, created_at::text
          FROM fitness.auth_account
          WHERE user_id = ${this.#userId}
          ORDER BY created_at`,
    );

    return rows.map((row) => ({
      id: row.id,
      authProvider: row.auth_provider,
      email: row.email,
      name: row.name,
      createdAt: row.created_at,
    }));
  }

  /** Count of linked auth accounts for the user. */
  async getAccountCount(): Promise<number> {
    const rows = await executeWithSchema(
      this.#db,
      countRowSchema,
      sql`SELECT COUNT(*)::text AS count FROM fitness.auth_account WHERE user_id = ${this.#userId}`,
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Delete a linked auth account belonging to the user.
   * Returns the deleted account id, or null if not found.
   */
  async deleteAccount(accountId: string): Promise<string | null> {
    const rows = await executeWithSchema(
      this.#db,
      idRowSchema,
      sql`DELETE FROM fitness.auth_account
          WHERE id = ${accountId} AND user_id = ${this.#userId}
          RETURNING id`,
    );
    return rows[0]?.id ?? null;
  }
}
