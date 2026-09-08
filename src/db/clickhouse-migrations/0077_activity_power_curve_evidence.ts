import type { ClickHouseMigration } from "./types.ts";

export function createMigration(): ClickHouseMigration {
  return {
    id: "0077_activity_power_curve_evidence",
    statements: [
      `ALTER TABLE analytics.activity_power_curve
        ADD COLUMN IF NOT EXISTS start_offset_seconds Nullable(Float64) AFTER best_power,
        ADD COLUMN IF NOT EXISTS observed_samples Nullable(UInt64) AFTER start_offset_seconds,
        ADD COLUMN IF NOT EXISTS median_sample_interval_seconds Nullable(Float64) AFTER observed_samples,
        ADD COLUMN IF NOT EXISTS largest_gap_seconds Nullable(Float64) AFTER median_sample_interval_seconds,
        ADD COLUMN IF NOT EXISTS coverage_pct Nullable(Float64) AFTER largest_gap_seconds,
        ADD COLUMN IF NOT EXISTS power_measurement_kind Nullable(String) AFTER coverage_pct,
        ADD COLUMN IF NOT EXISTS source_providers Array(String) DEFAULT [] AFTER power_measurement_kind,
        ADD COLUMN IF NOT EXISTS source_devices Array(String) DEFAULT [] AFTER source_providers`,
    ],
  };
}
