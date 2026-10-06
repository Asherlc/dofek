import { sql } from "drizzle-orm";
import { z } from "zod";
import type { createDatabaseFromEnv } from "./db/index.ts";

/**
 * Extracted CLI utility functions — testable without side effects.
 */

/** Parse `--since-days=N` from an argv array, defaulting to 7. */
export function parseSinceDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--since-days="));
  if (arg) return parseInt(arg.split("=")[1] ?? "7", 10);
  return 7;
}

/** Compute the "since" cutoff date for sync/import operations. */
export function computeSinceDate(days: number, fullSync: boolean): Date {
  return fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function resolveCliUserId(
  db: Pick<ReturnType<typeof createDatabaseFromEnv>, "execute">,
): Promise<string> {
  const envUserId = process.env.DOFEK_USER_ID;
  if (envUserId) return envUserId;

  const rows = await db.execute(
    sql`SELECT id::text AS id FROM fitness.user_profile ORDER BY created_at ASC LIMIT 1`,
  );
  const parsed = z.object({ id: z.string() }).safeParse(rows[0]);
  if (parsed.success) return parsed.data.id;

  throw new Error("No user found. Set DOFEK_USER_ID or create a user first.");
}
