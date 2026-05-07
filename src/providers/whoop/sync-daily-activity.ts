import { WhoopRateLimitError } from "whoop-whoop/client";
import { dailyMetrics } from "../../db/schema.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { logger } from "../../logger.ts";
import { parseDailyStepValues } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopDailyActivityResult = {
  count: number;
  rateLimited: boolean;
};

export async function syncWhoopDailyActivity(
  context: WhoopSyncContext,
): Promise<WhoopDailyActivityResult> {
  const { db, client, providerId, since, options } = context;

  try {
    const count = await withSyncLog(
      db,
      providerId,
      "daily_activity",
      async () => {
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let windowStart = since.getTime();
        const nowMs = Date.now();
        const maxStepsByDate = new Map<string, number>();

        while (windowStart < nowMs) {
          const windowEnd = Math.min(windowStart + weekMs, nowMs);
          const startStr = new Date(windowStart).toISOString();
          const endStr = new Date(windowEnd).toISOString();

          const values = await client.getSteps(startStr, endStr, 300);
          const parsedDays = parseDailyStepValues(values);
          for (const parsedDay of parsedDays) {
            const currentMax = maxStepsByDate.get(parsedDay.date);
            if (currentMax == null || parsedDay.steps > currentMax) {
              maxStepsByDate.set(parsedDay.date, parsedDay.steps);
            }
          }

          windowStart = windowEnd;
        }

        for (const [date, steps] of maxStepsByDate) {
          await db
            .insert(dailyMetrics)
            .values({ date, providerId, steps })
            .onConflictDoUpdate({
              target: [
                dailyMetrics.userId,
                dailyMetrics.date,
                dailyMetrics.providerId,
                dailyMetrics.sourceName,
              ],
              set: { steps },
            });
        }

        return { recordCount: maxStepsByDate.size, result: maxStepsByDate.size };
      },
      options?.userId,
    );
    return { count, rateLimited: false };
  } catch (err) {
    if (err instanceof WhoopRateLimitError) {
      return { count: 0, rateLimited: true };
    }
    if (
      err instanceof Error &&
      (err.message.includes("WHOOP API error (400)") ||
        err.message.includes("WHOOP API error (404)"))
    ) {
      logger.info(
        `[whoop] Steps metric unavailable from metrics-service; skipping steps sync (${err.message})`,
      );
      return { count: 0, rateLimited: false };
    }
    context.errors.push({
      message: `daily_activity: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}
