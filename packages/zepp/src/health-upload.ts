import type { BackgroundHealthSample } from "./background-health.ts";
import type { HealthActivity, HealthDataPayload } from "./health-collector.ts";
import type { LiveWorkoutSnapshot } from "./workout-live.ts";

export interface HealthUploadPayload {
  watchSummary?: HealthDataPayload;
  activities?: HealthActivity[];
  backgroundSamples?: BackgroundHealthSample[];
  liveWorkoutSamples?: Array<LiveWorkoutSnapshot & { externalId: string }>;
}
