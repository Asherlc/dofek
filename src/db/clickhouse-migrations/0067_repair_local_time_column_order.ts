import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const tableCountRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);

/**
 * Migration 0063 added the record-local time columns to the analytics serving
 * tables with a plain `ADD COLUMN IF NOT EXISTS`, which ClickHouse appends to
 * the end of the physical table. The dbt models for these append-incremental
 * tables select the same columns in the middle of their column list (right
 * after `timezone` for activities, after `overlapping_sessions` for sleep), and
 * dbt-clickhouse binds `INSERT INTO <table> (<physical column order>) <model
 * SELECT>` positionally. On databases created before those columns existed the
 * physical order therefore no longer matches the model, shifting every trailing
 * column by three or four positions and mapping `source_synced_at`
 * (`DateTime64(9)`) onto a small-integer destination — ClickHouse raises
 * `Code: 407 Convert overflow` on every build.
 *
 * This migration repositions the columns in place with `MODIFY COLUMN ... AFTER`
 * so the physical order matches each model's SELECT again. Repositioning is a
 * metadata-only operation (no data is rewritten), and on databases where the
 * columns are already in the right place — for example a fresh database whose
 * `CREATE TABLE` already listed them in position — each statement is a no-op.
 *
 * `activity_source_records` is a dbt-owned table with no `CREATE TABLE`
 * migration, so on a fresh database it does not exist yet when this runs (dbt
 * creates it later, already in the correct order). The table-existence guard
 * skips it in that case, mirroring migration 0063.
 */
const activitySourceRecordsStatements = [
  `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
  `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
  `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
] as const;

const dedupedActivitiesStatements = [
  `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
  `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
  `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
] as const;

const dailySleepStatements = [
  `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN timezone Nullable(String) AFTER overlapping_sessions`,
  `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
  `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
  `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
] as const;

const servingTables = [
  ["activity_source_records", activitySourceRecordsStatements],
  ["deduped_activities", dedupedActivitiesStatements],
  ["daily_sleep", dailySleepStatements],
] as const;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0067_repair_local_time_column_order",
    statements: servingTables.flatMap(([, statements]) => [...statements]),
    run: async (client) => {
      if (!client.query) {
        throw new Error("ClickHouse migrations require a query-capable client");
      }

      for (const [name, statements] of servingTables) {
        const result = await client.query<{ count: string }>({
          query:
            "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
          format: "JSONEachRow",
          query_params: { name },
        });
        const rows = tableCountRowsSchema.parse(await result.json());
        if (rows[0].count > 0) {
          for (const statement of statements) {
            await runClickHouseMigrationStatement(client, statement);
          }
        }
      }
    },
  };
}
