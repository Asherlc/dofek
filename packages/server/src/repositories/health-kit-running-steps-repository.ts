import { TRPCError } from "@trpc/server";
import type { SyncDatabase } from "../../../../src/db/index.ts";
import { markProviderActivityPresent } from "../../../../src/db/provider-activity-sync.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import {
  appleHealthWorkoutExternalId,
  upsertHealthKitWorkouts,
} from "../routers/health-kit-sync-processors.ts";
import {
  PROVIDER_ID,
  type RunningStepSample,
  type WorkoutSample,
} from "../routers/health-kit-sync-schemas.ts";

/** Publishes only raw observations with explicit running workout context. */
export async function processRunningStepSamples(
  db: SyncDatabase,
  userId: string,
  workouts: WorkoutSample[],
  samples: RunningStepSample[],
  publisher: MetricStreamEventPublisher,
): Promise<number> {
  const workoutIds = new Set(workouts.map((workout) => workout.uuid));
  if (workouts.some((workout) => workout.workoutType !== "37")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Raw running steps require original running workout contexts (workout type 37). Resync Apple Health workouts.",
    });
  }
  for (const sample of samples) {
    if (sample.workoutUuids.some((uuid) => !workoutIds.has(uuid))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Step sample ${sample.uuid} references a workout outside this upload's running contexts. Resync Apple Health workouts and steps together.`,
      });
    }
  }
  const byChild = new Map<string, RunningStepSample>();
  for (const sample of samples) {
    const key = JSON.stringify([
      sample.uuid,
      sample.sourceBundle,
      new Date(sample.startDate).toISOString(),
      new Date(sample.endDate).toISOString(),
    ]);
    const existing = byChild.get(key);
    if (existing && existing.value !== sample.value) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Step sample ${sample.uuid} has conflicting counts for the same interval. Retry Apple Health sync.`,
      });
    }
    byChild.set(key, {
      ...sample,
      workoutUuids: [
        ...new Set([...(existing?.workoutUuids ?? []), ...sample.workoutUuids]),
      ].sort(),
    });
  }
  // No absence reconciliation: this upload contains partial, additive context.
  await upsertHealthKitWorkouts(db, userId, workouts);
  for (const workout of workouts) {
    await markProviderActivityPresent(db, {
      userId,
      providerId: PROVIDER_ID,
      externalId: appleHealthWorkoutExternalId(workout.uuid),
    });
  }
  const rows: MetricStreamRowInput[] = [...byChild.values()].map((sample) => ({
    recordedAt: sample.startDate,
    userId,
    providerId: PROVIDER_ID,
    externalId: `hk:${sample.uuid}`,
    deviceId: sample.sourceName,
    sourceType: "api",
    channel: "step_count",
    scalar: sample.value,
    metadata: {
      interval_end: new Date(sample.endDate).toISOString(),
      source_bundle: sample.sourceBundle,
      workout_uuids: sample.workoutUuids,
    },
  }));
  await writeMetricStreamRows({ database: db, publisher, rows });
  return rows.length;
}
