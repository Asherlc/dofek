import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { loadDashboardOverview } from "./dashboard-overview.ts";

function makeSensorStore({
  metricDate = "2026-06-29",
}: {
  metricDate?: string | Date;
} = {}): ActivitySensorStore {
  return {
    query: vi.fn(async <TSchema extends z.ZodType>(schema: TSchema, queryText: string) => {
      expect(queryText).not.toContain("analytics.deduped_sensor");
      expect(queryText).not.toContain("fitness.metric_stream");
      let rows: Record<string, unknown>[];
      if (queryText.includes("analytics.daily_recovery")) {
        rows = [
          {
            date: "2026-06-29",
            hrv: 62,
            hrv_score: 70,
            resting_hr_score: 68,
            sleep_score: 80,
            respiratory_rate_score: 75,
          },
        ];
      } else if (queryText.includes("analytics.daily_sleep")) {
        rows = [
          {
            date: "2026-06-29",
            duration_minutes: 455,
            deep_minutes: 70,
            rem_minutes: 95,
            light_minutes: 260,
            awake_minutes: 30,
          },
        ];
      } else if (queryText.includes("analytics.daily_strain") && queryText.includes(" AS load")) {
        rows = [{ load: 0 }];
      } else if (queryText.includes("analytics.daily_strain")) {
        rows = [{ metric_date: metricDate, daily_load: 120 }];
      } else {
        rows = [];
      }
      return rows.map((row) => schema.parse(row));
    }),
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
  };
}

describe("loadDashboardOverview", () => {
  it("loads dashboard overview from route-facing read models with dashboard priority", async () => {
    const sensorStore = makeSensorStore();

    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-29",
      sensorStore,
      userId: "user-1",
    });

    expect(result.latestDate).toBe("2026-06-29");
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("analytics.daily_recovery"),
      expect.any(Object),
      { priority: "dashboard" },
    );
  });

  it("normalizes ClickHouse daily strain dates before building load maps", async () => {
    const sensorStore = makeSensorStore({ metricDate: new Date("2026-06-29T00:00:00.000Z") });

    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-29",
      sensorStore,
      userId: "user-1",
    });

    expect(result.strain.date).toBe("2026-06-29");
    expect(result.strain.dailyStrain).toBeGreaterThan(0);
  });
});
