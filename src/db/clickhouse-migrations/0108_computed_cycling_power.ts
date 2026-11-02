import { z } from "zod";
import { buildActivitySummaryViewSql } from "../clickhouse-activity-summary.ts";
import { buildDailyCyclingTableSql, dailyCyclingActivitiesType } from "../clickhouse-cycling.ts";
import { buildUserProfileCurrentViewSql } from "../clickhouse-raw-tables.ts";
import { cyclingPowerSchemaStatements } from "../cycling-power-schema.ts";
import { hasClickHouseColumn } from "./column-introspection.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  const statements = [
    ...cyclingPowerSchemaStatements(),
    buildActivitySummaryViewSql(),
    buildUserProfileCurrentViewSql(),
    "ALTER TABLE postgres_fitness.user_profile DROP COLUMN IF EXISTS ftp",
    ...["activity_sensor_summary_rows", "activity_summary_rows", "cycling_activity"].map(
      (table) => `ALTER TABLE analytics.${table} DROP COLUMN IF EXISTS normalized_power`,
    ),
    "ALTER TABLE analytics.healthspan_activity_zone_minutes MODIFY COLUMN aerobic_minutes Nullable(Float64), MODIFY COLUMN high_intensity_minutes Nullable(Float64)",
    "ALTER TABLE analytics.weekly_healthspan MODIFY COLUMN weekly_aerobic_min Nullable(Float64), MODIFY COLUMN weekly_high_intensity_min Nullable(Float64)",
  ];
  return {
    id: "0108_computed_cycling_power",
    statements,
    run: async (client) => {
      for (const query of statements) {
        const alteration = query.match(
          /^ALTER TABLE analytics\.(\w+) (?:DROP COLUMN IF EXISTS|MODIFY COLUMN) (\w+)/,
        );
        if (
          alteration &&
          !(await hasClickHouseColumn(
            client,
            "analytics",
            alteration[1] ?? "",
            alteration[2] ?? "",
          ))
        )
          continue;
        await client.command({ query });
      }
      if (!client.query)
        throw new Error("Computed cycling power migration requires a query-capable client");
      const result = await client.query({
        query:
          "SELECT type FROM system.columns WHERE database={database:String} AND table='daily_cycling' AND name='activities'",
        query_params: { database: "analytics" },
        format: "JSONEachRow",
      });
      const [column] = z.array(z.object({ type: z.string() })).parse(await result.json());
      if (
        column &&
        column.type.replaceAll(/\s/g, "") !== dailyCyclingActivitiesType.replaceAll(/\s/g, "")
      ) {
        // This disposable dbt cache must be repopulated at the documented maintenance boundary.
        // ClickHouse cannot ALTER between tuple types with different arities, even when empty.
        await client.command({ query: "DROP TABLE analytics.daily_cycling" });
      }
      await client.command({ query: buildDailyCyclingTableSql() });
    },
  };
}
