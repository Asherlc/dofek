import type { ClickHouseMigration } from "./types.ts";

const inputBaselineColumns = `
  ADD COLUMN IF NOT EXISTS hrv_baseline_sample_count UInt16 AFTER hrv_sd_30d,
  ADD COLUMN IF NOT EXISTS hrv_baseline_coverage Float64 AFTER hrv_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS hrv_mean_7d Nullable(Float64) AFTER hrv_baseline_coverage,
  ADD COLUMN IF NOT EXISTS hrv_mean_previous_28d Nullable(Float64) AFTER hrv_mean_7d,
  ADD COLUMN IF NOT EXISTS rhr_baseline_sample_count UInt16 AFTER rhr_sd_30d,
  ADD COLUMN IF NOT EXISTS rhr_baseline_coverage Float64 AFTER rhr_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS rhr_mean_7d Nullable(Float64) AFTER rhr_baseline_coverage,
  ADD COLUMN IF NOT EXISTS rhr_mean_previous_28d Nullable(Float64) AFTER rhr_mean_7d,
  ADD COLUMN IF NOT EXISTS rr_baseline_sample_count UInt16 AFTER rr_sd_30d,
  ADD COLUMN IF NOT EXISTS rr_baseline_coverage Float64 AFTER rr_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS rr_mean_7d Nullable(Float64) AFTER rr_baseline_coverage,
  ADD COLUMN IF NOT EXISTS rr_mean_previous_28d Nullable(Float64) AFTER rr_mean_7d,
  ADD COLUMN IF NOT EXISTS efficiency_mean_30d Nullable(Float64) AFTER rr_mean_previous_28d,
  ADD COLUMN IF NOT EXISTS efficiency_sd_30d Nullable(Float64) AFTER efficiency_mean_30d,
  ADD COLUMN IF NOT EXISTS efficiency_baseline_sample_count UInt16 AFTER efficiency_sd_30d,
  ADD COLUMN IF NOT EXISTS efficiency_baseline_coverage Float64 AFTER efficiency_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS efficiency_mean_7d Nullable(Float64) AFTER efficiency_baseline_coverage,
  ADD COLUMN IF NOT EXISTS efficiency_mean_previous_28d Nullable(Float64) AFTER efficiency_mean_7d`;

const recoveryBaselineColumns = `
  ADD COLUMN IF NOT EXISTS hrv_z_score Nullable(Float64) AFTER hrv_sd_30d,
  ADD COLUMN IF NOT EXISTS hrv_baseline_sample_count UInt16 AFTER hrv_z_score,
  ADD COLUMN IF NOT EXISTS hrv_baseline_coverage Float64 AFTER hrv_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS hrv_mean_7d Nullable(Float64) AFTER hrv_baseline_coverage,
  ADD COLUMN IF NOT EXISTS hrv_mean_previous_28d Nullable(Float64) AFTER hrv_mean_7d,
  ADD COLUMN IF NOT EXISTS resting_hr_z_score Nullable(Float64) AFTER rhr_sd_30d,
  ADD COLUMN IF NOT EXISTS rhr_baseline_sample_count UInt16 AFTER resting_hr_z_score,
  ADD COLUMN IF NOT EXISTS rhr_baseline_coverage Float64 AFTER rhr_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS rhr_mean_7d Nullable(Float64) AFTER rhr_baseline_coverage,
  ADD COLUMN IF NOT EXISTS rhr_mean_previous_28d Nullable(Float64) AFTER rhr_mean_7d,
  ADD COLUMN IF NOT EXISTS respiratory_rate_z_score Nullable(Float64) AFTER rr_sd_30d,
  ADD COLUMN IF NOT EXISTS rr_baseline_sample_count UInt16 AFTER respiratory_rate_z_score,
  ADD COLUMN IF NOT EXISTS rr_baseline_coverage Float64 AFTER rr_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS rr_mean_7d Nullable(Float64) AFTER rr_baseline_coverage,
  ADD COLUMN IF NOT EXISTS rr_mean_previous_28d Nullable(Float64) AFTER rr_mean_7d,
  ADD COLUMN IF NOT EXISTS efficiency_mean_30d Nullable(Float64) AFTER rr_mean_previous_28d,
  ADD COLUMN IF NOT EXISTS efficiency_sd_30d Nullable(Float64) AFTER efficiency_mean_30d,
  ADD COLUMN IF NOT EXISTS efficiency_z_score Nullable(Float64) AFTER efficiency_sd_30d,
  ADD COLUMN IF NOT EXISTS efficiency_baseline_sample_count UInt16 AFTER efficiency_z_score,
  ADD COLUMN IF NOT EXISTS efficiency_baseline_coverage Float64 AFTER efficiency_baseline_sample_count,
  ADD COLUMN IF NOT EXISTS efficiency_mean_7d Nullable(Float64) AFTER efficiency_baseline_coverage,
  ADD COLUMN IF NOT EXISTS efficiency_mean_previous_28d Nullable(Float64) AFTER efficiency_mean_7d`;

export function createMigration(): ClickHouseMigration {
  return {
    id: "0062_daily_recovery_baseline_context",
    statements: [
      `ALTER TABLE analytics.daily_recovery_inputs ${inputBaselineColumns}`,
      `ALTER TABLE analytics.daily_recovery ${recoveryBaselineColumns}`,
    ],
  };
}
