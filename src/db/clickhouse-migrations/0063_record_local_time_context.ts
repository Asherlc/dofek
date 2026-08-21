import { z } from "zod";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const tableCountRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() })]);

const contextColumns = [
  "ADD COLUMN IF NOT EXISTS start_utc_offset_minutes Nullable(Int16)",
  "ADD COLUMN IF NOT EXISTS end_utc_offset_minutes Nullable(Int16)",
  "ADD COLUMN IF NOT EXISTS local_time_source LowCardinality(String) DEFAULT 'unknown'",
] as const;

function addContextColumns(table: string, includeTimezone: boolean): string {
  const columns = includeTimezone
    ? ["ADD COLUMN IF NOT EXISTS timezone Nullable(String)", ...contextColumns]
    : contextColumns;
  return `ALTER TABLE ${table}\n  ${columns.join(",\n  ")}`;
}

export function createMigration(): ClickHouseMigration {
  const activityStatement = addContextColumns("postgres_fitness.activity", false);
  const sleepStatement = addContextColumns("postgres_fitness.sleep_session", true);
  const activitySourceStatement = addContextColumns("analytics.activity_source_records", false);
  const dedupedActivitiesStatement = addContextColumns("analytics.deduped_activities", false);
  const dailySleepStatement = addContextColumns("analytics.daily_sleep", true);
  const statements = [
    activityStatement,
    sleepStatement,
    activitySourceStatement,
    dedupedActivitiesStatement,
    dailySleepStatement,
  ];

  return {
    id: "0063_record_local_time_context",
    statements,
    run: async (client) => {
      if (!client.query) {
        throw new Error("ClickHouse migrations require a query-capable client");
      }

      await runClickHouseMigrationStatement(client, activityStatement);
      await runClickHouseMigrationStatement(client, sleepStatement);

      const servingTables = [
        ["activity_source_records", activitySourceStatement],
        ["deduped_activities", dedupedActivitiesStatement],
        ["daily_sleep", dailySleepStatement],
      ] as const;
      for (const [name, statement] of servingTables) {
        const result = await client.query<{ count: string }>({
          query:
            "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = {name:String}",
          format: "JSONEachRow",
          query_params: { name },
        });
        const rows = tableCountRowsSchema.parse(await result.json());
        if (rows[0].count > 0) {
          await runClickHouseMigrationStatement(client, statement);
        }
      }
    },
  };
}
