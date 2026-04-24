import type { SQL } from "drizzle-orm";
import { z } from "zod";

/**
 * Minimal database interface for executeWithSchema and other DB helpers.
 * The full Drizzle `Database` (from `./index.ts`) structurally satisfies this,
 * and test mocks can implement it directly without type assertions.
 *
 * This follows the Interface Segregation Principle — callers declare only the
 * DB operations they actually use, making them testable with lightweight mocks.
 */
export interface Database {
  execute: (query: SQL) => Promise<Record<string, unknown>[]>;
}

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

/**
 * Zod schema for SQL date columns (::date).
 * Database drivers may return Date objects or strings. This schema normalizes
 * both to YYYY-MM-DD strings.
 *
 * We intentionally do not normalize SQL DATE values to JavaScript Date objects:
 * a date-only value gains an implicit timezone once coerced to Date, which can
 * shift the calendar day in clients. Keeping YYYY-MM-DD as the canonical shape
 * preserves the exact date across JSON boundaries.
 */
export const dateStringSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value));

/**
 * Zod schema for SQL timestamp/timestamptz columns.
 * Database drivers may return Date objects or strings. This schema normalizes
 * both to ISO 8601 strings that all browsers (including Safari) can parse.
 *
 * We also keep timestamps as strings instead of Date objects because these rows
 * are commonly returned through JSON APIs, where Date instances serialize to
 * strings anyway. Normalizing here gives every client one stable wire format.
 */
export const timestampStringSchema = z.union([z.string(), z.date()]).transform((value) => {
  if (value instanceof Date) return value.toISOString();
  // Normalize postgres-style strings ("2026-03-20 19:40:29.678162+00")
  // to ISO 8601 so all clients (including Hermes/React Native) can parse them.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
});
