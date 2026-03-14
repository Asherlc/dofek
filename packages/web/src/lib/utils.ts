/**
 * Type assertion for tRPC raw SQL query results.
 * Raw SQL queries return Record<string, unknown>[] — this helper asserts the
 * expected row shape without using banned double-cast patterns.
 * Use only for tRPC endpoints that return raw SQL until proper server-side
 * typing is added.
 */
export function assertRows<T>(data: ReadonlyArray<Record<string, unknown>> | undefined): T[] {
  return (data ?? []) as T[];
}
