import { and, eq, inArray } from "drizzle-orm";
import { type LambertsFitWorkout, lambertsFitSegments } from "../fit/lamberts-workout.ts";
import type { SyncDatabase } from "./index.ts";
import { activity, activityDeviceObservation, activityInterval } from "./schema/activity.ts";

type DeviceObservation = Pick<typeof activityDeviceObservation.$inferInsert, "messageType" | "raw">;

/** Replace raw FIT observations atomically, reading only one device batch at a time. */
export async function replaceActivityDeviceObservations(
  db: SyncDatabase,
  scope: { activityId: string; userId: string },
  batches: AsyncIterable<readonly DeviceObservation[]>,
  lambertsWorkout?: LambertsFitWorkout | null,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [ownedActivity] = await transaction
      .select({
        id: activity.id,
        providerId: activity.providerId,
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
      })
      .from(activity)
      .where(and(eq(activity.id, scope.activityId), eq(activity.userId, scope.userId)))
      .for("update");
    if (!ownedActivity) throw new Error("FIT device observations require an owned activity");
    await transaction
      .delete(activityDeviceObservation)
      .where(eq(activityDeviceObservation.activityId, ownedActivity.id));
    let sequence = 0;
    for await (const batch of batches) {
      if (batch.length > 250)
        throw new Error("FIT device observation batches cannot exceed 250 messages");
      if (batch.length === 0) continue;
      await transaction.insert(activityDeviceObservation).values(
        batch.map((observation) => ({
          ...observation,
          activityId: ownedActivity.id,
          sequence: sequence++,
        })),
      );
    }

    if (lambertsWorkout === undefined) return;
    await transaction
      .delete(activityInterval)
      .where(
        and(
          eq(activityInterval.activityId, ownedActivity.id),
          eq(activityInterval.sourceKind, "provider_recorded"),
          inArray(activityInterval.segmentType, lambertsFitSegments),
        ),
      );
    const firstInterval = lambertsWorkout?.intervals[0];
    const lastInterval = lambertsWorkout?.intervals.at(-1);
    if (
      !lambertsWorkout ||
      !firstInterval ||
      !lastInterval ||
      firstInterval.start < ownedActivity.startedAt ||
      !ownedActivity.endedAt ||
      lastInterval.end > ownedActivity.endedAt
    ) {
      return;
    }

    await transaction.insert(activityInterval).values(
      lambertsWorkout.intervals.map<typeof activityInterval.$inferInsert>((interval, index) => ({
        activityId: ownedActivity.id,
        intervalIndex: index,
        startedAt: interval.start,
        endedAt: interval.end,
        sourceKind: "provider_recorded",
        sourceProvider: ownedActivity.providerId,
        sourceActivityId: ownedActivity.id,
        segmentType: interval.segment,
        workRecoveryKind: interval.targetMaximumHeartRatePercent === null ? "recovery" : "work",
        raw: {
          ...(index === 0
            ? { fitWorkout: lambertsWorkout.workout, fitZonesTarget: lambertsWorkout.zonesTarget }
            : {}),
          fitWorkoutStep: interval.step,
          fitLap: interval.lap,
        },
      })),
    );
  });
}
