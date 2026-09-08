import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const statements = [
  `ALTER TABLE analytics.activity_power_curve
        ADD COLUMN IF NOT EXISTS start_offset_seconds Nullable(Float64) AFTER best_power,
        ADD COLUMN IF NOT EXISTS observed_samples Nullable(UInt64) AFTER start_offset_seconds,
        ADD COLUMN IF NOT EXISTS median_sample_interval_seconds Nullable(Float64) AFTER observed_samples,
        ADD COLUMN IF NOT EXISTS largest_gap_seconds Nullable(Float64) AFTER median_sample_interval_seconds,
        ADD COLUMN IF NOT EXISTS coverage_pct Nullable(Float64) AFTER largest_gap_seconds,
        ADD COLUMN IF NOT EXISTS power_measurement_kind Nullable(String) AFTER coverage_pct,
        ADD COLUMN IF NOT EXISTS source_providers Array(String) DEFAULT [] AFTER power_measurement_kind,
        ADD COLUMN IF NOT EXISTS source_devices Array(String) DEFAULT [] AFTER source_providers`,
];

async function tableExists(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) throw new Error("ClickHouse migrations require a query-capable client");
  const result = await client.query<{ count: number | string }>({
    query:
      "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = 'activity_power_curve'",
    format: "JSONEachRow",
  });
  const [row] = z
    .tuple([
      z.object({
        count: z.union([
          z.number().int().nonnegative(),
          z.string().regex(/^\d+$/).transform(Number),
        ]),
      }),
    ])
    .parse(await result.json(), { error: () => "Expected one ClickHouse table count row" });
  return row.count > 0;
}

export function createMigration(): ClickHouseMigration {
  return {
    id: "0077_activity_power_curve_evidence",
    statements,
    run: async (client) => {
      if (await tableExists(client)) {
        const statement = statements[0];
        if (!statement)
          throw new Error("Missing activity power curve evidence migration statement");
        await runClickHouseMigrationStatement(client, statement);
      }
    },
  };
}
