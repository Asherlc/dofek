import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

const tracer = trace.getTracer("dofek-server");

/**
 * Minimal DB interface for executeWithSchema — only needs the execute method.
 * Accepts both the full Drizzle `Database` and narrower `Pick<Database, "execute">`.
 */
type ExecutableDatabase = Pick<Database, "execute">;

/** Type guard for Drizzle StringChunk (has a `value` string array). */
function isStringChunk(chunk: unknown): chunk is { value: string[] } {
  if (chunk == null || typeof chunk !== "object" || !("value" in chunk)) return false;
  const record: Record<string, unknown> = chunk;
  return Array.isArray(record.value);
}

/** Type guard for nested Drizzle SQL fragments (has a `queryChunks` array). */
function isSqlFragment(chunk: unknown): chunk is { queryChunks: unknown[] } {
  if (chunk == null || typeof chunk !== "object" || !("queryChunks" in chunk)) return false;
  const record: Record<string, unknown> = chunk;
  return Array.isArray(record.queryChunks);
}

/**
 * Extract a short summary from a Drizzle SQL object for span naming.
 * Recursively flattens nested SQL fragments (e.g. from sql`...${innerSql}...`)
 * so the full SQL template is visible. Parameters are replaced with $N.
 * Returns the first ~120 chars.
 */
function summarizeSql(query: SQL): string {
  const parts: string[] = [];
  let paramIndex = 1;

  function flatten(chunks: unknown[]): void {
    for (const chunk of chunks) {
      if (typeof chunk === "string") {
        parts.push(chunk);
      } else if (isStringChunk(chunk)) {
        parts.push(...chunk.value);
      } else if (isSqlFragment(chunk)) {
        flatten(chunk.queryChunks);
      } else {
        parts.push(`$${paramIndex++}`);
      }
    }
  }

  flatten(query.queryChunks);
  const full = parts.join("").replace(/\s+/g, " ").trim();
  return full.length > 120 ? `${full.slice(0, 117)}...` : full;
}

/**
 * Execute a raw SQL query and parse each row with a Zod schema.
 * Use this instead of `db.execute<T>()` generics — Zod validates at runtime,
 * catching schema drift, missing columns, and type mismatches that generics miss.
 *
 * Each query is wrapped in an OpenTelemetry span for tracing.
 */
export async function executeWithSchema<T extends z.ZodType>(
  db: ExecutableDatabase,
  schema: T,
  query: SQL,
): Promise<z.infer<T>[]> {
  const sqlSummary = summarizeSql(query);
  return tracer.startActiveSpan("db.query", async (span: Span) => {
    span.setAttribute("db.system", "postgresql");
    span.setAttribute("db.statement", sqlSummary);
    try {
      const rows = await db.execute(query);
      span.setAttribute("db.row_count", rows.length);
      return rows.map((row) => schema.parse(row));
    } catch (error: unknown) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
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
