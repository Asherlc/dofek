/**
 * Canonical list of materialized views, ordered by dependency.
 * Import this from any code that needs to enumerate or refresh materialized views
 * rather than maintaining a separate copy.
 *
 * v_body_measurement, v_daily_metrics, provider_stats, and derived_resting_heart_rate
 * are intentionally NOT here — they are plain views that update at query time. The
 * matviews here are the ones whose query cost makes plain-view evaluation impractical:
 * v_activity / v_sleep (cross-provider dedup via recursive CTE) and the dedup-graph
 * views layered on top of them (deduped_sensor, activity_summary).
 */

export const DEDUP_VIEWS = ["fitness.v_activity", "fitness.v_sleep"];

export const ROLLUP_VIEWS = ["fitness.deduped_sensor", "fitness.activity_summary"] as const;

/** All materialized views in dependency order (dedup first, then rollup). */
export const ALL_MATERIALIZED_VIEWS = [...DEDUP_VIEWS, ...ROLLUP_VIEWS] as const;

/** Subset of views that depend on activity data and need refresh after activity syncs. */
export const ACTIVITY_VIEWS = [
  "fitness.v_activity",
  "fitness.deduped_sensor",
  "fitness.activity_summary",
] as const;
