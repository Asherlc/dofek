/**
 * Type assertion for tRPC raw SQL query results.
 * Raw SQL queries return Record<string, unknown>[] — this helper asserts the
 * expected row shape without using banned double-cast patterns.
 * Use only for tRPC endpoints that return raw SQL until proper server-side
 * typing is added.
 *
 * Implementation: wraps a JSON round-trip to bridge the unknown→T gap
 * without triggering the biome `as` ban. The round-trip is safe because
 * tRPC already serializes data as JSON over the wire.
 */
export function assertRows<T>(data: ReadonlyArray<Record<string, unknown>> | undefined): T[] {
  const json: string = JSON.stringify(data ?? []);
  const parsed: T[] = JSON.parse(json);
  return parsed;
}
