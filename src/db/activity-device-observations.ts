import { and, eq } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import { activity, activityDeviceObservation } from "./schema/activity.ts";

type DeviceObservation = Pick<typeof activityDeviceObservation.$inferInsert, "messageType" | "raw">;

/** Replace raw FIT observations atomically, reading only one decoder batch at a time. */
export async function replaceActivityDeviceObservations(
  db: SyncDatabase,
  scope: { activityId: string; userId: string },
  batches: AsyncIterable<readonly DeviceObservation[]>,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [ownedActivity] = await transaction
      .select({ id: activity.id })
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
  });
}
