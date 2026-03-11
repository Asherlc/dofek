import { sql } from "drizzle-orm";
import type { Database } from "./index.ts";

const MATERIALIZED_VIEWS = [
  "fitness.v_activity",
  "fitness.v_sleep",
  "fitness.v_body_measurement",
  "fitness.v_daily_metrics",
  "fitness.v_metric_stream",
] as const;

/**
 * Refresh all deduplication materialized views.
 * Call after every sync run to keep canonical data up-to-date.
 *
 * CONCURRENTLY allows reads during refresh (requires unique index).
 * Falls back to regular refresh if the view has never been populated.
 */
export async function refreshDedupViews(db: Database): Promise<void> {
  for (const view of MATERIALIZED_VIEWS) {
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
    } catch (err) {
      // CONCURRENTLY fails when:
      // 1. View has not been populated yet (first refresh)
      // 2. View has no unique index (e.g., v_metric_stream)
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
}
