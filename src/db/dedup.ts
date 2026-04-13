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
 * being refreshed. Collected errors are thrown as a single AggregateError
 * after all views have been attempted.
 */
export async function refreshDedupViews(db: SyncDatabase): Promise<void> {
  const errors: Array<{ view: string; error: unknown }> = [];

  // Refresh dedup views first (rollup views may depend on v_activity)
  for (const view of DEDUP_VIEWS) {
    try {
      await refreshView(db, view);
    } catch (error) {
      errors.push({ view, error });
    }
  }

  // Refresh rollup views (depend on base tables, not dedup views)
  for (const view of ROLLUP_VIEWS) {
    try {
      await refreshView(db, view);
    } catch (error) {
      errors.push({ view, error });
    }
  }

  if (errors.length > 0) {
    const summary = errors.map(({ view, error }) => `${view}: ${error}`).join("; ");
    throw new Error(`Failed to refresh ${errors.length} view(s): ${summary}`);
  }
}

/**
 * Update user_profile.max_hr from the highest observed heart rate in metric_stream.
 * Called after syncs that touch metric_stream data.
 */
export async function updateUserMaxHr(db: SyncDatabase): Promise<void> {
  await db.execute(sql`
    UPDATE fitness.user_profile up
    SET max_hr = sub.observed_max_hr,
        updated_at = NOW()
    FROM (
      SELECT user_id, MAX(scalar)::SMALLINT AS observed_max_hr
      FROM fitness.sensor_sample
      WHERE channel = 'heart_rate' AND activity_id IS NOT NULL
      GROUP BY user_id
    ) sub
    WHERE up.id = sub.user_id
      AND (up.max_hr IS NULL OR sub.observed_max_hr > up.max_hr)
  `);
}

async function refreshView(db: SyncDatabase, view: string): Promise<void> {
  try {
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
  } catch {
    // CONCURRENTLY can fail for many reasons: view not populated, no unique
    // index, lock conflicts, resource limits, or Drizzle-wrapped errors where
    // the original Postgres message is obscured. Always fall back to a
    // blocking refresh rather than giving up entirely.
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
  }
}
