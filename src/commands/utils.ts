import { sql } from "drizzle-orm";
import { z } from "zod";
import type { createDatabaseFromEnv } from "../db/index.ts";

export async function resolveCliUserId(db: ReturnType<typeof createDatabaseFromEnv>): Promise<string> {
  const envUserId = process.env.DOFEK_USER_ID;
  if (envUserId) return envUserId;

  const rows = await db.execute(
    sql`SELECT id::text AS id FROM fitness.user_profile ORDER BY created_at ASC LIMIT 1`,
  );
  const parsed = z.object({ id: z.string() }).safeParse(rows[0]);
  if (parsed.success) return parsed.data.id;

  throw new Error("No user found. Set DOFEK_USER_ID or create a user first.");
}
