import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import type { z } from "zod";

/**
 * Execute a raw SQL query and parse each row with a Zod schema.
 * Use this instead of `db.execute<T>()` generics — Zod validates at runtime,
 * catching schema drift, missing columns, and type mismatches that generics miss.
 */
export async function executeWithSchema<T extends z.ZodType>(
  db: Database,
  schema: T,
  query: SQL,
): Promise<z.infer<T>[]> {
  const rows = await db.execute(query);
  return rows.map((row) => schema.parse(row));
}
