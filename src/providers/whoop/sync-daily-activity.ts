import { WhoopRateLimitError } from "whoop-whoop/client";
import { dailyMetrics } from "../../db/schema.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { parseStrainDeepDiveSteps } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopDailyActivityResult = {
  count: number;
  rateLimited: boolean;
};

function* iterateUtcDates(start: Date, endMs: number): Generator<string> {
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const end = new Date(endMs);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  while (cursor.getTime() <= endDay) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

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
        const nowMs = Date.now();
        const stepsByDate = new Map<string, number>();

        for (const date of iterateUtcDates(since, nowMs)) {
          const raw = await client.getStrainDeepDive(date);
          const steps = parseStrainDeepDiveSteps(raw);
          if (steps != null) {
            stepsByDate.set(date, steps);
          }
        }

        for (const [date, steps] of stepsByDate) {
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

        return { recordCount: stepsByDate.size, result: stepsByDate.size };
      },
      options?.userId,
    );
    return { count, rateLimited: false };
  } catch (err) {
    if (err instanceof WhoopRateLimitError) {
      return { count: 0, rateLimited: true };
    }
    context.errors.push({
      message: `daily_activity: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}
