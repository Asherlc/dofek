/**
 * Canonical list of materialized views, ordered by dependency.
 * Import this from any code that needs to enumerate or refresh materialized views
 * rather than maintaining a separate copy.
 */

export const DEDUP_VIEWS = [
  "fitness.v_activity",
  "fitness.v_sleep",
];

export const ROLLUP_VIEWS = [] as const;

/** All materialized views in dependency order (dedup first, then rollup). */
export const ALL_MATERIALIZED_VIEWS = [...DEDUP_VIEWS, ...ROLLUP_VIEWS] as const;

/** Subset of views that depend on activity data and need refresh after activity syncs. */
export const ACTIVITY_VIEWS = ["fitness.v_activity"] as const;
