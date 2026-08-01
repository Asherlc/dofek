import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { loadDashboardOverview } from "./dashboard-overview.ts";

function makeSensorStore({
  metricDate = "2026-06-29",
  sleepDurationMinutes = 455,
  sleepNights,
}: {
  metricDate?: string | Date;
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
      if (queryText.includes("analytics.daily_recovery")) {
        expect(queryText).toContain("recovery.is_deleted = 0");
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
      } else if (queryText.includes("analytics.daily_strain") && queryText.includes(" AS load")) {
        expect(queryText).toContain("strain.is_deleted = 0");
        rows = [{ load: 0 }];
      } else if (queryText.includes("analytics.daily_strain")) {
        expect(queryText).toContain("strain.is_deleted = 0");
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

  it("provides the unavailable V2 state when the dashboard has no prior-night sleep", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-07-01",
      sensorStore: makeSensorStore(),
      userId: "user-1",
    });

    expect(result.sleepNeedV2).toEqual({
      availability: "missing_previous_night",
      message: "Sync last night's sleep data to see tonight's sleep need.",
    });
  });

  it("provides the unavailable V2 state when the prior-night duration is missing", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-30",
      sensorStore: makeSensorStore({ sleepDurationMinutes: null }),
      userId: "user-1",
    });

    expect(result.sleepNeedV2).toEqual({
      availability: "missing_previous_night",
      message: "Sync last night's sleep data to see tonight's sleep need.",
    });
    expect(result.sleep.lastNight).toBeNull();
    expect(result.sleep.sleepDebt).toBe(0);
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

  it("reports insufficient baseline history instead of a generic V2 estimate", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-06-30",
      sensorStore: makeSensorStore(),
      userId: "user-1",
    });

    expect(result.sleepNeedV2).toEqual({
      availability: "insufficient_data",
      reason: "insufficient_baseline_history",
      message: "Sync at least 7 qualifying nights to estimate sleep need.",
      nextAction: "Sync more sleep and recovery data.",
    });
  });

  it("excludes older missing durations from dashboard debt and recent-night values", async () => {
    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-07-01",
      sensorStore: makeSensorStore({
        sleepNights: [
          { date: "2026-06-29", durationMinutes: null },
          { date: "2026-06-30", durationMinutes: 480 },
        ],
      }),
      userId: "user-1",
    });

    expect(result.sleepNeedV2).toEqual({
      availability: "insufficient_data",
      reason: "insufficient_baseline_history",
      message: "Sync at least 7 qualifying nights to estimate sleep need.",
      nextAction: "Sync more sleep and recovery data.",
    });
  });

  it("reports observed sleep-debt inputs from only the latest 14 nights", async () => {
    const sleepNights = Array.from({ length: 16 }, (_, index) => {
      const date = new Date("2026-06-15T12:00:00Z");
      date.setUTCDate(date.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        durationMinutes: index < 2 ? 100 : index === 5 ? null : 480,
      };
    });

    const result = await loadDashboardOverview({
      accessWindow: { kind: "full" },
      endDate: "2026-07-01",
      sensorStore: makeSensorStore({ sleepNights }),
      userId: "user-1",
    });

    expect(result.sleepNeedV2).toEqual({
      availability: "insufficient_data",
      reason: "insufficient_baseline_history",
      message: "Sync at least 7 qualifying nights to estimate sleep need.",
      nextAction: "Sync more sleep and recovery data.",
    });
  });
});
