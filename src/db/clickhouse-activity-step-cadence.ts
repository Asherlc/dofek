/** Current derived schema; dbt owns all cadence computation. */
export function buildActivityStepCadenceRowsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS analytics.activity_step_cadence_rows (
    user_id UUID,
    activity_id UUID,
    avg_cadence Nullable(Float64),
    observed_steps Float64,
    observed_seconds Float64,
    interval_count UInt64,
    parent_sample_count UInt64,
    source_provider Nullable(String),
    source_device Nullable(String),
    source_bundle Nullable(String),
    first_observed_at Nullable(DateTime64(6, 'UTC')),
    last_observed_at Nullable(DateTime64(6, 'UTC')),
    coverage_fraction Nullable(Float64),
    source_changed_at DateTime64(9, 'UTC'),
    activity_source_refreshed_at DateTime64(9, 'UTC'),
    mapping_signature String,
    priority_signature String,
    started_at Nullable(DateTime64(6, 'UTC')),
    ended_at Nullable(DateTime64(6, 'UTC')),
    is_deleted UInt8,
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}
