import { sql } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";

const DEDUP_VIEWS = [
  "fitness.v_activity",
  "fitness.v_sleep",
  "fitness.v_body_measurement",
  "fitness.v_daily_metrics",
  "fitness.deduped_sensor",
] as const;

const ROLLUP_VIEWS = ["fitness.activity_summary"] as const;

/**
 * Refresh all deduplication materialized views.
 * Call after every sync run to keep canonical data up-to-date.
 *
 * CONCURRENTLY allows reads during refresh (requires unique index).
 * Falls back to regular refresh if the view has never been populated.
 *
 * Each view is refreshed independently — a failure in one view (e.g.
 * v_activity) must not prevent other views (e.g. v_daily_metrics) from
 * being refreshed. Collected errors are thrown as an AggregateError
 * after all views have been attempted.
 */
export async function refreshDedupViews(db: SyncDatabase): Promise<void> {
  const errors: unknown[] = [];

  // Refresh dedup views first (activity_summary depends on base tables
  // but is refreshed after dedup views as a convention)
  for (const view of DEDUP_VIEWS) {
    try {
      await refreshView(db, view);
    } catch (error) {
      errors.push(error);
    }
  }

  // Refresh rollup views
  for (const view of ROLLUP_VIEWS) {
    try {
      await refreshView(db, view);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to refresh ${errors.length} view(s)`);
  }
}

/**
 * Update user_profile.max_hr from the highest observed heart rate across all activities.
 * Reads from activity_summary (which derives from deduped_sensor, covering both
 * sensor_sample and legacy metric_stream data).
 * Called after syncs that touch activity data.
 */
export async function updateUserMaxHr(db: SyncDatabase): Promise<void> {
  await db.execute(sql`
    UPDATE fitness.user_profile up
    SET max_hr = sub.observed_max_hr,
        updated_at = NOW()
    FROM (
      SELECT user_id, MAX(max_hr)::SMALLINT AS observed_max_hr
      FROM fitness.activity_summary
      WHERE max_hr IS NOT NULL
      GROUP BY user_id
    ) sub
    WHERE up.id = sub.user_id
      AND (up.max_hr IS NULL OR sub.observed_max_hr > up.max_hr)
  `);
}

async function refreshView(db: SyncDatabase, view: string): Promise<void> {
  try {
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
  } catch (concurrentError) {
    // CONCURRENTLY can fail for many reasons: view not populated, no unique
    // index, lock conflicts, resource limits, or Drizzle-wrapped errors where
    // the original Postgres message is obscured. Always fall back to a
    // blocking refresh rather than giving up entirely.
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
    } catch (fallbackError) {
      throw new Error(`Failed to refresh ${view} (both CONCURRENT and blocking)`, {
        cause: concurrentError,
      });
    }
  }
}
