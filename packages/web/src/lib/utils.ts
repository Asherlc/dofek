import { type ZodType, z } from "zod";

/**
 * Parse tRPC raw SQL query results with a Zod schema for runtime validation.
 * Raw SQL queries return Record<string, unknown>[] — this helper validates each
 * row against the provided schema. Use only for tRPC endpoints that return raw
 * SQL until proper server-side typing is added.
 */
export function assertRows<T>(
  data: ReadonlyArray<Record<string, unknown>> | undefined,
  schema: ZodType<T>,
): T[] {
  return z.array(schema).parse(data ?? []);
}
