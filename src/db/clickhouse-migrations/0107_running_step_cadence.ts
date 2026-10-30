import { buildActivityStepCadenceRowsTableSql } from "../clickhouse-activity-step-cadence.ts";
import { buildActivitySummaryViewSql } from "../clickhouse-activity-summary.ts";
import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  const statements = [
    buildActivityStepCadenceRowsTableSql(),
    "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS cadence_basis String DEFAULT 'unknown' AFTER avg_cadence",
    "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS cadence_observed_seconds Nullable(Float64) AFTER cadence_basis",
    "ALTER TABLE analytics.activity_summary_rows ADD COLUMN IF NOT EXISTS cadence_coverage_percent Nullable(Float64) AFTER cadence_observed_seconds",
    buildActivitySummaryViewSql(),
  ];
  return {
    id: "0107_running_step_cadence",
    statements,
    run: async (client) => {
      for (const query of statements) await client.command({ query });
    },
  };
}
