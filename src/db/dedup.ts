import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { logger } from "../logger.ts";
import type { SyncDatabase } from "./index.ts";
import { refreshMaterializedView } from "./materialized-view-refresh.ts";
import { POST_SYNC_VIEWS } from "./materialized-views.ts";

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
 * Refresh lightweight post-sync materialized views.
 * Call after every sync run to keep canonical data up-to-date.
 *
 * CONCURRENTLY allows reads during refresh (requires unique index).
 * Falls back to regular refresh if the view has never been populated.
 *
 * Each view is refreshed independently — a failure in one view (e.g.
 * v_activity) must not prevent other views (e.g. v_daily_metrics) from
 * being refreshed.
 *
 * Full-history metric-stream views are intentionally excluded from routine
 * post-sync refreshes. They are refreshed only through planned maintenance.
 *
 * When a view is missing entirely (e.g. CASCADE-dropped or lost due to
 * disk-full), triggers a full view sync to recreate it from the canonical
 * SQL definitions before retrying.
 */
export async function refreshDedupViews(db: SyncDatabase): Promise<void> {
  const errors: unknown[] = [];
  let viewsMissing = false;

  for (const view of POST_SYNC_VIEWS) {
    try {
      await refreshView(db, view);
    } catch (error) {
      if (isRelationMissingError(error)) {
        viewsMissing = true;
      }
      errors.push(error);
    }
  }

  // If any views were missing, recreate them all from canonical definitions
  // and retry the refresh.
  if (viewsMissing) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new AggregateError(
        errors,
        "Views missing and DATABASE_URL not available for recreation",
      );
    }

    const missingViews = errors
      .filter(isRelationMissingError)
      .map((error) => (error instanceof Error ? error.message : String(error)));
    logger.warn(`[views] Missing materialized views detected: ${missingViews.join("; ")}`);
    Sentry.captureException(
      new AggregateError(errors, `Missing materialized views triggered self-heal`),
      { tags: { context: "viewSelfHeal" }, extra: { missingViews } },
    );

    const { syncMaterializedViews } = await import("./sync-views.ts");
    await syncMaterializedViews(databaseUrl);

    // Retry refreshes after recreation
    const retryErrors: unknown[] = [];
    for (const view of POST_SYNC_VIEWS) {
      try {
        await refreshView(db, view);
      } catch (error) {
        retryErrors.push(error);
      }
    }

    if (retryErrors.length > 0) {
      throw new AggregateError(
        retryErrors,
        `Failed to refresh ${retryErrors.length} view(s) after recreation`,
      );
    }
    return;
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to refresh ${errors.length} view(s)`);
  }
}

/**
 * Update user_profile.max_hr from the highest observed heart rate across all activities.
 * Reads from activity_summary (which derives from deduped_sensor → metric_stream).
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
    await refreshMaterializedView(db, view, {
      source: "sync.post_sync",
      fallbackToBlocking: false,
    });
  } catch (concurrentError) {
    logger.warn(
      `[mv-refresh] source=sync.post_sync view=${view} failed: ${concurrentError instanceof Error ? concurrentError.message : String(concurrentError)}`,
    );
    throw concurrentError;
  }
}
