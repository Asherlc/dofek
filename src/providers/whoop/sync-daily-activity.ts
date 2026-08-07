import { and, eq, isNotNull } from "drizzle-orm";
import { dailyMetrics } from "../../db/schema/activity.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { parseStrainDeepDiveSteps } from "./parsing.ts";
import { isWhoopRateLimitError } from "./rate-limit.ts";
import { iterateUtcDates } from "./sync-step-plan.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopDailyActivityResult = {
  count: number;
  rateLimited: boolean;
};

export async function syncWhoopStrainDeepDiveForDate(
  context: WhoopSyncContext,
  date: string,
): Promise<number> {
  const { db, client, providerId } = context;
  const raw = await client.getStrainDeepDive(date);
  const steps = parseStrainDeepDiveSteps(raw);
  if (steps == null) return 0;

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
  return 1;
}

export async function syncWhoopDailyActivity(
  context: WhoopSyncContext,
): Promise<WhoopDailyActivityResult> {
  const { db, client, providerId, since, windowEnd, options } = context;

  try {
    const count = await withSyncLog(
      db,
      providerId,
      "daily_activity",
      async () => {
        const stepsByDate = new Map<string, number>();
        const userId = options?.userId ?? getTokenUserId();
        const syncedStepDates =
          userId == null
            ? new Set<string>()
            : new Set(
                (
                  await db
                    .select({ date: dailyMetrics.date })
                    .from(dailyMetrics)
                    .where(
                      and(
                        eq(dailyMetrics.userId, userId),
                        eq(dailyMetrics.providerId, providerId),
                        isNotNull(dailyMetrics.steps),
                      ),
                    )
                ).map((row) => row.date),
              );

        for (const date of iterateUtcDates(since, windowEnd.getTime())) {
          if (syncedStepDates.has(date)) continue;
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
    if (isWhoopRateLimitError(err)) {
      context.errors.push({
        message: `daily_activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { count: 0, rateLimited: true };
    }
    context.errors.push({
      message: `daily_activity: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}
