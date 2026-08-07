import { vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

export const aiObservabilityMocks = {
  withAiGenerationContext: vi.fn(
    async (_context: { userId?: string }, operation: () => Promise<unknown>): Promise<unknown> =>
      operation(),
  ),
};

export function makeMockSensorStore(rows: unknown[] = []): ActivitySensorStore {
  const query = vi.fn().mockResolvedValue(rows);

  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  } satisfies ActivitySensorStore;
}
