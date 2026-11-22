import { and, eq, isNotNull } from "drizzle-orm";
import { FIT_WORKOUT_LAP_SOURCE, type FitWorkoutInterval } from "../fit/workout-intervals.ts";
import type { SyncDatabase } from "./index.ts";
import { activity, activityInterval } from "./schema/activity.ts";

const INSERT_BATCH_SIZE = 250;

/**
 * Atomically replace the FIT-owned Workout Step / Lap interval rows of one owned activity.
 * Rows without `fit_source` (other providers, inferred intervals) are never touched. An empty
 * list clears stale FIT-owned rows, so a retry or reimport converges on the file's content.
 */
export async function replaceFitWorkoutIntervals(
  db: SyncDatabase,
  scope: { activityId: string; userId: string; providerId: string },
  intervals: readonly FitWorkoutInterval[],
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [ownedActivity] = await transaction
      .select({ id: activity.id })
      .from(activity)
      .where(
        and(
          eq(activity.id, scope.activityId),
          eq(activity.userId, scope.userId),
          eq(activity.providerId, scope.providerId),
        ),
      )
      .for("update");
    if (!ownedActivity) throw new Error("FIT workout intervals require an owned activity");
    await transaction
      .delete(activityInterval)
      .where(
        and(
          eq(activityInterval.activityId, ownedActivity.id),
          isNotNull(activityInterval.fitSource),
        ),
      );
    if (intervals.length === 0) return;
    for (let offset = 0; offset < intervals.length; offset += INSERT_BATCH_SIZE) {
      await transaction.insert(activityInterval).values(
        intervals.slice(offset, offset + INSERT_BATCH_SIZE).map((interval) => ({
          activityId: ownedActivity.id,
          intervalIndex: interval.intervalIndex,
          label: interval.label,
          intervalType: interval.intervalType,
          startedAt: interval.startedAt,
          endedAt: interval.endedAt,
          sourceKind: "provider_recorded" as const,
          sourceProvider: scope.providerId,
          sourceActivityId: ownedActivity.id,
          targetPowerWatts: interval.targetPowerWatts,
          targetPowerMinWatts: interval.targetPowerMinWatts,
          targetPowerMaxWatts: interval.targetPowerMaxWatts,
          plannedDurationSeconds: interval.plannedDurationSeconds,
          recordedTimerDurationSeconds: interval.recordedTimerDurationSeconds,
          fitSource: FIT_WORKOUT_LAP_SOURCE,
          raw: interval.raw,
        })),
      );
    }
  });
}
