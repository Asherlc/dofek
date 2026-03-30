import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const isAdminRowSchema = z.object({
  is_admin: z.boolean(),
});

/**
 * Check if a user is an admin by reading the is_admin flag on their user profile.
 */
export async function isAdmin(db: Pick<Database, "execute">, userId: string): Promise<boolean> {
  const rows = await executeWithSchema(
    db,
    isAdminRowSchema,
    sql`SELECT is_admin FROM fitness.user_profile WHERE id = ${userId} LIMIT 1`,
  );

  const row = rows[0];
  if (!row) return false;
  return row.is_admin;
}
