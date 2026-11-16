import { readFileSync } from "node:fs";
import { buildCyclingPowerObservationRowsTableSql } from "../cycling-power-schema.ts";

function bootstrapLegacyCyclingPowerView(
  name: "cycling_threshold_history" | "cycling_activity_power_metrics",
): string {
  const query = readFileSync(new URL(`./legacy/0108_${name}.sql`, import.meta.url), "utf8")
    .replaceAll(
      "{{ source('analytics', 'cycling_power_history_rows') }}",
      "analytics.cycling_power_history_rows",
    )
    .replaceAll(
      "{{ source('analytics', 'cycling_power_observation_rows') }}",
      "analytics.cycling_power_observation_rows",
    );
  return `CREATE OR REPLACE VIEW analytics.${name} AS\n${query}`;
}

/** Historical 0108 schema snapshot, isolated from current bootstrap. */
export function cyclingPowerSchemaStatementsBefore0114(): string[] {
  return [
    buildCyclingPowerObservationRowsTableSql(),
    `CREATE TABLE IF NOT EXISTS analytics.cycling_power_history_rows (
      user_id UUID,
      source_refresh_version UInt64,
      as_of_day Date,
      model_version String,
      events Array(Tuple(
        event_at Float64,
        activity_id Nullable(String),
        eftp Nullable(Float64),
        intensity_factor Nullable(Float64),
        power_tss Nullable(Float64),
        evidence_activity_id Nullable(String),
        evidence_at Float64,
        evidence_duration_seconds Float64,
        evidence_power Float64
      )),
      refresh_version UInt64,
      refreshed_at DateTime64(6, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY user_id`,
    bootstrapLegacyCyclingPowerView("cycling_threshold_history"),
    bootstrapLegacyCyclingPowerView("cycling_activity_power_metrics"),
  ];
}
