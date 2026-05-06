/**
 * Canonical list of materialized views, ordered by dependency.
 * Import this from any code that needs to enumerate or refresh materialized views
 * rather than maintaining a separate copy.
 *
 * Only v_activity and v_sleep remain as Postgres matviews (cross-provider dedup
 * via recursive CTE). All sensor-stream and rollup analytics now run from
 * ClickHouse (analytics.deduped_sensor, analytics.activity_summary), so those
 * views are intentionally absent here.
 */

export const DEDUP_VIEWS = ["fitness.v_activity", "fitness.v_sleep"] as const;

export const ROLLUP_VIEWS = [] as const;

/** All materialized views in dependency order (dedup first, then rollup). */
export const ALL_MATERIALIZED_VIEWS = [...DEDUP_VIEWS, ...ROLLUP_VIEWS] as const;

/** Subset of views that depend on activity data and need refresh after activity syncs. */
export const ACTIVITY_VIEWS = ["fitness.v_activity"] as const;
