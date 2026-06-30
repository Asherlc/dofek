import { dailyMetrics } from "../../db/schema/activity.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { logger } from "../../logger.ts";
import { parseRecovery, resolveRecoveryState } from "./parsing.ts";
import type { WhoopPersistenceContext } from "./sync-types.ts";

export async function syncWhoopRecovery(context: WhoopPersistenceContext): Promise<number> {
  const { db, cycles, providerId, options } = context;

  try {
    return await withSyncLog(
      db,
      providerId,
      "recovery",
      async () => {
        let count = 0;
        for (const cycle of cycles) {
          if (!cycle.recovery) {
            continue;
          }
          const recoveryState = resolveRecoveryState(cycle.recovery);
          const hasLegacyRecovery = recoveryState === "SCORED" && cycle.recovery.score;
          const hasBffRecovery = cycle.recovery.resting_heart_rate != null;
          if (hasLegacyRecovery || hasBffRecovery) {
            const parsed = parseRecovery(cycle.recovery);
            logger.info(
              `[whoop] Parsed recovery: rhr=${parsed.restingHr}, hrv=${parsed.hrv}, ` +
                `spo2=${parsed.spo2}, skinTemp=${parsed.skinTemp}`,
            );
            const cycleDayRaw =
              cycle.days?.[0] ?? new Date(cycle.recovery.created_at).toISOString().split("T")[0];
            if (!cycleDayRaw) throw new Error("Could not determine cycle day");
            const cycleDay = cycleDayRaw;

            await db
              .insert(dailyMetrics)
              .values({
                date: cycleDay,
                providerId,
                hrv: parsed.hrv,
                spo2Avg: parsed.spo2,
                skinTempC: parsed.skinTemp,
              })
              .onConflictDoUpdate({
                target: [
                  dailyMetrics.userId,
                  dailyMetrics.date,
                  dailyMetrics.providerId,
                  dailyMetrics.sourceName,
                ],
                set: {
                  hrv: parsed.hrv,
                  spo2Avg: parsed.spo2,
                  skinTempC: parsed.skinTemp,
                },
              });
            count++;
          } else if (recoveryState === "SCORED") {
            logger.warn(
              `[whoop] SCORED recovery with no parseable data: ` +
                `keys=${Object.keys(cycle.recovery).join(",")}`,
            );
          } else {
            logger.info(`[whoop] Skipping unscored recovery: state=${recoveryState}`);
          }
        }
        logger.info(
          `[whoop] Recovery sync: ${count} records inserted from ${cycles.length} cycles`,
        );
        return { recordCount: count, result: count };
      },
      options?.userId,
    );
  } catch (err) {
    context.errors.push({
      message: `recovery: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}
