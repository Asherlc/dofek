import {
  type SchemaExecutionDatabase as CoreSchemaExecutionDatabase,
  type SqlExecutor as CoreSqlExecutor,
  executeWithSchema as executeWithSchemaCore,
} from "dofek/db/execute-with-schema";
import { z } from "zod";

export const executeWithSchema = executeWithSchemaCore;
export type SchemaExecutionDatabase = CoreSchemaExecutionDatabase;
export type SqlExecutor = CoreSqlExecutor;

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
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date string"), z.date()])
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
