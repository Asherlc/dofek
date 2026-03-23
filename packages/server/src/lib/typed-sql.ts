import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

/**
 * Minimal DB interface for executeWithSchema — only needs the execute method.
 * Accepts both the full Drizzle `Database` and narrower `Pick<Database, "execute">`.
 */
type ExecutableDatabase = Pick<Database, "execute">;

/**
 * Execute a raw SQL query and parse each row with a Zod schema.
 * Use this instead of `db.execute<T>()` generics — Zod validates at runtime,
 * catching schema drift, missing columns, and type mismatches that generics miss.
 */
export async function executeWithSchema<T extends z.ZodType>(
  db: ExecutableDatabase,
  schema: T,
  query: SQL,
): Promise<z.infer<T>[]> {
  const rows = await db.execute(query);
  return rows.map((row) => schema.parse(row));
}

/**
 * Zod schema for SQL date columns (::date).
 * The postgres-js driver returns Date objects on some platforms (Linux/ARM)
 * and strings on others (macOS). This schema normalizes both to YYYY-MM-DD.
 */
export const dateStringSchema = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date string"), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value));

/**
 * Zod schema for SQL timestamp/timestamptz columns.
 * The postgres-js driver returns Date objects on some platforms (Linux/ARM)
 * and strings on others (macOS). This schema normalizes both to ISO 8601
 * strings that all browsers (including Safari) can parse.
 */
export const timestampStringSchema = z.union([z.string(), z.date()]).transform((value) => {
  if (value instanceof Date) return value.toISOString();
  // Normalize postgres-style strings ("2026-03-20 19:40:29.678162+00")
  // to ISO 8601 so all clients (including Hermes/React Native) can parse them.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
});
