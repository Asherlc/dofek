import type {
  ActivityHeartRateContext,
  ActivityMetricSourceSelection,
} from "../contracts/activity-metric-sources.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";

interface HeartRateStreamStore {
  getStream(
    window: ActivitySensorWindow,
    maxPoints: number,
    sources: ActivityMetricSourceSelection,
  ): Promise<Array<{ recorded_at: string; heart_rate: number | null }>>;
}

/** Display context only; activity summaries and zones retain the recorded window. */
export async function getActivityHeartRateContext(
  store: HeartRateStreamStore,
  window: ActivitySensorWindow,
  maxPoints: number,
  heartRateSourceId: string | undefined,
): Promise<ActivityHeartRateContext> {
  const marginMs = 5 * 60 * 1000;
  const chartWindow = {
    startedAt: new Date(Date.parse(window.startedAt) - marginMs).toISOString(),
    endedAt: window.endedAt ? new Date(Date.parse(window.endedAt) + marginMs).toISOString() : null,
  };
  const points = heartRateSourceId
    ? await store.getStream({ ...window, ...chartWindow }, maxPoints, {
        heartRate: heartRateSourceId,
      })
    : [];
  return {
    window: chartWindow,
    points: points
      .filter((point) => point.heart_rate !== null)
      .map((point) => ({ recordedAt: point.recorded_at, value: point.heart_rate })),
  };
}
