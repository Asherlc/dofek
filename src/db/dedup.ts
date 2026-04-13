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
 */
export async function refreshDedupViews(db: SyncDatabase): Promise<void> {
  // Refresh dedup views first (rollup views may depend on v_activity)
  for (const view of DEDUP_VIEWS) {
    await refreshView(db, view);
  }

  // Refresh rollup views (depend on base tables, not dedup views)
  for (const view of ROLLUP_VIEWS) {
    await refreshView(db, view);
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
  } catch (err) {
    // CONCURRENTLY fails when:
    // 1. View has not been populated yet (first refresh)
    // 2. View has no unique index (e.g., some views)
    // Fall back to non-concurrent refresh in both cases
    if (
      err instanceof Error &&
      (err.message.includes("has not been populated") || err.message.includes("concurrently"))
    ) {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
    } else {
      throw err;
    }
  }
}
