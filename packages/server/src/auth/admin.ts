import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const ADMIN_GROUP = process.env.ADMIN_GROUP ?? "admins";

const groupsRowSchema = z.object({
  groups: z.array(z.string()).nullable(),
});

/**
 * Check if a user is an admin by looking for the admin group
 * in their Authentik auth_account groups.
 */
export async function isAdmin(db: Pick<Database, "execute">, userId: string): Promise<boolean> {
  const rows = await executeWithSchema(
    db,
    groupsRowSchema,
    sql`SELECT groups FROM fitness.auth_account
        WHERE user_id = ${userId} AND auth_provider = 'authentik'
        LIMIT 1`,
  );

  const row = rows[0];
  if (!row) return false;
  return row.groups?.includes(ADMIN_GROUP) ?? false;
}
