/**
 * Canonical list of materialized views, ordered by dependency.
 * activity_summary depends on v_activity + deduped_sensor, so it must come last.
 *
 * Import this from any code that needs to enumerate or refresh materialized views
 * rather than maintaining a separate copy.
 */

export const DEDUP_VIEWS = [
  "fitness.v_activity",
  "fitness.v_sleep",
  "fitness.v_body_measurement",
  "fitness.v_daily_metrics",
  "fitness.deduped_sensor",
] as const;

export const ROLLUP_VIEWS = ["fitness.activity_summary"] as const;

/** All materialized views in dependency order (dedup first, then rollups). */
export const ALL_MATERIALIZED_VIEWS = [...DEDUP_VIEWS, ...ROLLUP_VIEWS] as const;

/** Subset of views that depend on activity data and need refresh after activity syncs. */
export const ACTIVITY_VIEWS = [
  "fitness.v_activity",
  "fitness.deduped_sensor",
  "fitness.activity_summary",
] as const;
