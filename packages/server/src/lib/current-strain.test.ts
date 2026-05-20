import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { computeCurrentStrain } from "./current-strain.ts";

function makeSensorStore(rows: Array<{ physiological_load: number | null }>): ActivitySensorStore {
  return {
    query: vi.fn().mockResolvedValue(rows),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

describe("computeCurrentStrain", () => {
  it("uses heart-rate physiology load when available", async () => {
    const result = await computeCurrentStrain({
      sensorStore: makeSensorStore([{ physiological_load: 2.2107535185185188 }]),
      userId: "00000000-0000-0000-0000-000000000001",
      timezone: "UTC",
      endDate: "2026-03-28",
      fallbackActivityLoad: 50,
    });

    expect(result).toEqual({
      currentStrain: 4.1,
      currentStrainSource: "heart_rate",
      currentPhysiologyLoad: 2.21,
    });
  });

  it("uses raw activity load without populating physiology load when heart rate is unavailable", async () => {
    const result = await computeCurrentStrain({
      sensorStore: makeSensorStore([{ physiological_load: null }]),
      userId: "00000000-0000-0000-0000-000000000001",
      timezone: "UTC",
      endDate: "2026-03-28",
      fallbackActivityLoad: 50,
    });

    expect(result).toEqual({
      currentStrain: 13.8,
      currentStrainSource: "activity",
      currentPhysiologyLoad: null,
    });
  });
});
