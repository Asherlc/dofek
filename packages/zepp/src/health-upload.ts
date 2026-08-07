import type { BackgroundHealthSample } from "./background-health.ts";
import type { HealthActivity, HealthDataPayload } from "./health-collector.ts";

const BACKGROUND_UPLOAD_BATCH_SIZE = 500;

export interface HealthUploadPayload {
  watchSummary?: HealthDataPayload;
  activities?: HealthActivity[];
  backgroundSamples?: BackgroundHealthSample[];
}

export function mergeHealthActivities(
  freshActivities: HealthActivity[],
  bufferedActivities: HealthActivity[],
): HealthActivity[] {
  return [
    ...new Map(
      [...bufferedActivities, ...freshActivities].map((activity) => [
        activity.externalId,
        activity,
      ]),
    ).values(),
  ];
}

export function createHealthUploadBatches(
  watchSummary: HealthDataPayload,
  activities: HealthActivity[],
  backgroundSamples: BackgroundHealthSample[],
): HealthUploadPayload[] {
  if (backgroundSamples.length === 0) {
    return [{ watchSummary, activities, backgroundSamples: [] }];
  }

  const batches: HealthUploadPayload[] = [];
  for (let offset = 0; offset < backgroundSamples.length; offset += BACKGROUND_UPLOAD_BATCH_SIZE) {
    const backgroundBatch = backgroundSamples.slice(offset, offset + BACKGROUND_UPLOAD_BATCH_SIZE);
    batches.push(
      offset === 0
        ? { watchSummary, activities, backgroundSamples: backgroundBatch }
        : { backgroundSamples: backgroundBatch },
    );
  }
  return batches;
}
