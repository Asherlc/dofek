import type { RunningStepSnapshot } from "../modules/health-kit";
import { isAfterDeviceErasureCutoff } from "./device-erasure-cutoff";
import type { ObserverSyncOptions, SyncResult } from "./health-kit-sync";
import { captureException } from "./telemetry";

const BATCH_SIZE = 500;

/** Refresh association snapshots and consume historical parent additions/deletions. */
export async function syncRunningSteps(
  options: Omit<ObserverSyncOptions, "typeIdentifiers">,
  startDate: string,
  endDate: string,
): Promise<SyncResult> {
  const { healthKit, trpcClient, minimumSampleDate = null, onStage } = options;
  const typeIdentifier = "HKQuantityTypeIdentifierStepCount";
  async function upload(snapshot: RunningStepSnapshot): Promise<number> {
    const providedContexts = new Set(snapshot.workouts.map((workout) => workout.uuid));
    if (
      snapshot.samples.some(
        (sample) =>
          sample.workoutUuids.length === 0 ||
          sample.workoutUuids.some((uuid) => !providedContexts.has(uuid)),
      )
    ) {
      throw new Error(
        "Running step samples are missing their original workout context. Retry Apple Health sync.",
      );
    }
    const workouts = snapshot.workouts
      .filter(
        (workout) =>
          minimumSampleDate === null ||
          isAfterDeviceErasureCutoff(workout.startDate, minimumSampleDate),
      )
      .map((workout) => ({ ...workout, totalDistance: workout.totalDistance ?? null }));
    const allowed = new Set(workouts.map((workout) => workout.uuid));
    const samples = snapshot.samples
      .filter(
        (sample) =>
          minimumSampleDate === null ||
          isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
      )
      .map((sample) => ({
        ...sample,
        workoutUuids: sample.workoutUuids.filter((uuid) => allowed.has(uuid)),
      }))
      .filter((sample) => sample.workoutUuids.length > 0);
    let inserted = 0;
    // Each batch carries the original contexts needed to establish ownership.
    for (let offset = 0; offset < samples.length; offset += BATCH_SIZE) {
      const batch = samples.slice(offset, offset + BATCH_SIZE);
      const batchIds = new Set(batch.flatMap((sample) => sample.workoutUuids));
      onStage?.({ operation: "pushRunningStepSamples", itemCount: batch.length });
      const result = await trpcClient.healthKitSync.pushRunningStepSamples.mutate({
        workouts: workouts.filter((workout) => batchIds.has(workout.uuid)),
        samples: batch,
      });
      inserted += result.inserted;
    }
    return inserted;
  }
  onStage?.({ operation: "queryRunningStepSamples", typeIdentifier });
  let inserted = await upload(await healthKit.queryRunningStepSamples(startDate, endDate));
  let deleted = 0;
  while (true) {
    onStage?.({ operation: "queryRunningStepChanges", typeIdentifier });
    const changes = await healthKit.queryRunningStepChanges(minimumSampleDate ?? startDate);
    try {
      if (changes.hasMore && !changes.queryId) {
        throw new Error(
          "HealthKit running step page is missing its continuation anchor. Retry Apple Health sync.",
        );
      }
      inserted += await upload(changes);
      for (let offset = 0; offset < changes.deletedUUIDs.length; offset += BATCH_SIZE) {
        const deletedUUIDs = changes.deletedUUIDs.slice(offset, offset + BATCH_SIZE);
        onStage?.({
          operation: "deleteQuantitySamples",
          typeIdentifier,
          itemCount: deletedUUIDs.length,
        });
        deleted += (
          await trpcClient.healthKitSync.deleteQuantitySamples.mutate({
            typeIdentifier,
            deletedUUIDs,
          })
        ).deleted;
      }
      if (changes.queryId) {
        onStage?.({ operation: "completeAnchoredQuery", typeIdentifier });
        const committed = await healthKit.completeAnchoredQuery(
          typeIdentifier,
          changes.queryId,
          true,
        );
        if (!committed)
          throw new Error(
            "HealthKit running step anchor commit rejected. Retry Apple Health sync.",
          );
      }
    } catch (error) {
      captureException(error, { source: "health-kit-running-step-sync" });
      if (changes.queryId) {
        try {
          await healthKit.completeAnchoredQuery(typeIdentifier, changes.queryId, false);
        } catch (completionError) {
          captureException(completionError, { source: "health-kit-running-step-anchor" });
        }
      }
      throw error;
    }
    if (!changes.hasMore) break;
  }
  return { inserted, deleted, errors: [] };
}
