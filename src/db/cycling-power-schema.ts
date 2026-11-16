import { readFileSync } from "node:fs";

function bootstrapCyclingPowerView(): string {
  const query = readFileSync(
    new URL(
      "../../analytics/models/read_models/cycling_activity_power_metrics.sql",
      import.meta.url,
    ),
    "utf8",
  )
    .replaceAll(
      "{{ source('analytics', 'activity_summary_rows') }}",
      "analytics.activity_summary_rows",
    )
    .replaceAll(
      "{{ source('analytics', 'cycling_power_observation_rows') }}",
      "analytics.cycling_power_observation_rows",
    )
    .replaceAll("{{ source('ingest', 'account_erasure_fence') }}", "ingest.account_erasure_fence");
  return `CREATE OR REPLACE VIEW analytics.cycling_activity_power_metrics AS\n${query}`;
}

/** Application persistence; numerical algorithms live in @dofek/cycling-power. */
export function buildCyclingPowerObservationRowsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.cycling_power_observation_rows (
      user_id UUID,
      activity_id UUID,
      normalized_power Nullable(Float64),
      source_refresh_version UInt64,
      model_version String,
      is_deleted UInt8,
      refresh_version UInt64,
      refreshed_at DateTime64(6, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id)`;
}

/** Current bootstrap stores observations and serves NP with canonical activity metadata. */
export function cyclingPowerSchemaStatements(): string[] {
  return [buildCyclingPowerObservationRowsTableSql(), bootstrapCyclingPowerView()];
}
