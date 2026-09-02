import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const homeTimezoneRowSchema = z.object({ value: z.string().nullable() });

export function isGeographicTimezone(value: string): boolean {
  if (!value.includes("/") || value.startsWith("Etc/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Returns the user's valid persisted geographic home timezone, if configured. */
export async function loadUserHomeTimezone(
  db: SchemaExecutionDatabase,
  userId: string,
): Promise<string | null> {
  const rows = await executeWithSchema(
    db,
    homeTimezoneRowSchema,
    sql`SELECT value #>> '{}' AS value
        FROM fitness.user_settings
        WHERE user_id = ${userId}::uuid
          AND key = 'homeTimezone'
        LIMIT 1`,
  );
  const timezone = rows[0]?.value?.trim();
  return timezone && isGeographicTimezone(timezone) ? timezone : null;
}
