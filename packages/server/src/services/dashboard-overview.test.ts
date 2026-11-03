import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { loadDashboardOverview } from "./dashboard-overview.ts";

function makeSensorStore({
  sleepDurationMinutes = 455,
  sleepNights,
}: {
  sleepDurationMinutes?: number | null;
  sleepNights?: Array<{
    date: string;
    durationMinutes: number | null;
    stagingAvailable?: boolean;
  }>;
} = {}): ActivitySensorStore {
  return {
    query: vi.fn(async <TSchema extends z.ZodType>(schema: TSchema, queryText: string) => {
      expect(queryText).not.toContain("analytics.deduped_sensor");
      expect(queryText).not.toContain("fitness.metric_stream");
      let rows: Record<string, unknown>[];
      if (queryText.includes("analytics.daily_sleep")) {
        expect(queryText).toContain("AND sleep.is_deleted = 0");
        rows = (sleepNights ?? [{ date: "2026-06-29", durationMinutes: sleepDurationMinutes }]).map(
          (night) => ({
            date: night.date,
            duration_minutes: night.durationMinutes,
            deep_minutes: 70,
            rem_minutes: 95,
            light_minutes: 260,
            awake_minutes: 30,
            staging_available: night.stagingAvailable ?? true,
          }),
        );
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
      expect.stringContaining("analytics.daily_sleep"),
      expect.any(Object),
      { priority: "dashboard" },
    );
  });

  it("returns the effective dashboard date and timezone from the server", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-08-02",
      sensorStore: makeSensorStore(),
      timezone: "America/Los_Angeles",
      userId: "user-1",
    });

    expect(result.summaryDateContext).toEqual({
      effectiveDate: "2026-08-02",
      timezone: "America/Los_Angeles",
    });
  });

  it("does not manufacture stage percentages when the provider omitted staging", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-30",
      sensorStore: makeSensorStore({
        sleepNights: [
          {
            date: "2026-06-29",
            durationMinutes: 480,
            stagingAvailable: false,
          },
        ],
      }),
      userId: "user-1",
    });

    expect(result.sleep.lastNight).toMatchObject({
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      stagingAvailable: false,
    });
  });
});
