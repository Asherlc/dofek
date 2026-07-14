import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import { CyclingAnalyticsRepository } from "./cycling-analytics-repository.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

describe("CyclingAnalyticsRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
  });

  it("loads the complete performance contract with exactly two ClickHouse statements", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([
        {
          duration_seconds: 300,
          recent_best_power: 400,
          recent_activity_date: "2026-07-10",
          season_best_power: 500,
          season_activity_date: "2026-03-15",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "11111111-1111-4111-8111-111111111111",
          date: "2026-07-10",
          duration_min: 60,
          avg_hr: 150,
          max_hr: 180,
          global_max_hr: 190,
          resting_hr: 55,
          avg_power: 250,
          power_samples: 3600,
          hr_samples: 3600,
          normalized_power: 280,
          activity_name: "Intervals",
          latest_weight_kg: 80,
        },
      ]);

    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(result.powerCurve.recent.points).toEqual([
      {
        durationSeconds: 300,
        label: "5min",
        bestPower: 400,
        activityDate: "2026-07-10",
      },
    ]);
    expect(result.powerCurve.season.points[0]?.bestPower).toBe(500);
    expect(result.powerSummary.weightKg).toBe(80);
    expect(result.powerSummary.recent.maximalAerobicPower).toBe(400);
    expect(result.powerSummary.recent.vo2Max).toBe(61);
    expect(result.eftpTrend.trend).toEqual([
      { date: "2026-07-10", eftp: 266, activityName: "Intervals" },
    ]);
  });

  it("loads ride cards and all activity charts with one ClickHouse statement", async () => {
    const sensorStore = makeMockSensorStore([
      {
        id: "11111111-1111-4111-8111-111111111111",
        started_at: "2026-07-10T10:00:00.000Z",
        ended_at: "2026-07-10T11:00:00.000Z",
        activity_type: "cycling",
        activity_name: "Intervals",
        provider_id: "wahoo",
        source_providers: ["wahoo"],
        distance_meters: 40000,
        date: "2026-07-10",
        normalized_power: 280,
        average_power: 250,
        estimated_ftp: 300,
        elevation_gain_meters: 500,
        elapsed_seconds: 3600,
        max_hr: 190,
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 600,
      },
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(sensorStore.query).toHaveBeenCalledTimes(1);
    expect(result.activities.totalCount).toBe(1);
    expect(result.activities.items[0]?.name).toBe("Intervals");
    expect(result.variability.rows[0]?.variabilityIndex).toBe(1.12);
    expect(result.verticalAscent[0]?.verticalAscentRate).toBe(500);
    expect(result.aerobicEfficiency.activities[0]?.efficiencyFactor).toBe(1.333);
  });
});
