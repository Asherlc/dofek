import type { SQL } from "drizzle-orm";
import { z } from "zod";

export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

const transactionQueryResultSchema = z.object({ rows: z.array(z.unknown()) });

function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;

  const transactionQueryResult = transactionQueryResultSchema.safeParse(result);
  if (transactionQueryResult.success) return transactionQueryResult.data.rows;

  throw new Error("Unexpected database execute result shape");
}

export interface SchemaExecutionDatabase extends SqlExecutor {
  execute: (query: SQL) => Promise<Record<string, unknown>[] | { rows: Record<string, unknown>[] }>;
}

export async function executeWithSchema<T extends z.ZodType>(
  db: SqlExecutor,
  schema: T,
  query: SQL,
): Promise<z.infer<T>[]> {
  const rows = extractRows(await db.execute(query));
  return rows.map((row) => schema.parse(row));
}
