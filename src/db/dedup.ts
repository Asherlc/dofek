import { sql } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";

/**
 * Check whether a "relation does not exist" error occurred.
 * Postgres error code 42P01 = undefined_table.
 */
export function isRelationMissingError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  if ("code" in error && error.code === "42P01") return true;
  if (error instanceof Error && error.message.includes("does not exist")) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(isRelationMissingError);
  }
  return false;
}

/**
 * Update user_profile.max_hr from the highest observed heart rate across all
 * activities. Reads heart_rate samples directly from activity-linked fitness.metric_stream;
 * The raw-sample max is equivalent to the dedup-winning max because we're
 * just taking the global maximum and providers don't disagree about the
 * actual peak value, only about how to dedup duplicates.
 */
export async function updateUserMaxHr(db: SyncDatabase): Promise<void> {
  await db.execute(sql`
    UPDATE fitness.user_profile up
    SET max_hr = sub.observed_max_hr,
        updated_at = NOW()
    FROM (
      SELECT ms.user_id, MAX(ms.scalar)::SMALLINT AS observed_max_hr
      FROM fitness.metric_stream ms
      JOIN fitness.activity activity
        ON activity.id = ms.activity_id
       AND activity.user_id = ms.user_id
      WHERE ms.channel = 'heart_rate'
        AND ms.scalar IS NOT NULL
        AND ms.scalar > 0
      GROUP BY ms.user_id
    ) sub
    WHERE up.id = sub.user_id
      AND (up.max_hr IS NULL OR sub.observed_max_hr > up.max_hr)
  `);
}
