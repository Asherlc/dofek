import type { ClickHouseCommandClient } from "../clickhouse.ts";

interface ColumnCountRow {
  column_count: number | string;
}

/**
 * Reports whether a ClickHouse column exists. Migrations use this to distinguish a
 * table that dbt has not created yet from one whose schema still needs to change.
 */
export async function hasClickHouseColumn(
  client: ClickHouseCommandClient,
  database: string,
  table: string,
  column: string,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ColumnCountRow>({
    query: `SELECT count() AS column_count
FROM system.columns
WHERE database = {database:String}
  AND table = {table:String}
  AND name = {column:String}`,
    format: "JSONEachRow",
    query_params: { database, table, column },
  });
  const rows = await result.json();
  return Number(rows[0]?.column_count ?? 0) > 0;
}
