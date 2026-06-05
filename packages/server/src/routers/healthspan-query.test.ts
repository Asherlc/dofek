import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { fetchHealthspanRawData, type HealthspanRawRow } from "./healthspan-query.ts";

const fullAccessWindow = { kind: "full", paid: true, reason: "paid_grant" } as const;

function makeSensorStore(overrides: Partial<ActivitySensorStore>): ActivitySensorStore {
  return {
    query: vi.fn().mockResolvedValue([]),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeRawHealthspanRow(overrides: Partial<HealthspanRawRow> = {}): HealthspanRawRow {
  return {
    avg_sleep_min: null,
    bedtime_stddev_min: null,
    avg_resting_hr: null,
    avg_steps: null,
    latest_vo2max: null,
    weekly_aerobic_min: null,
    weekly_high_intensity_min: null,
    sessions_per_week: null,
    weight_kg: null,
    body_fat_pct: null,
    weekly_history: null,
    ...overrides,
  };
}

function makeFetchContext(
  overrides: Partial<Parameters<typeof fetchHealthspanRawData>[0]>,
): Parameters<typeof fetchHealthspanRawData>[0] {
  return {
    userId: "user-1",
    timezone: "UTC",
    accessWindow: fullAccessWindow,
    ...overrides,
  };
}

describe("fetchHealthspanRawData", () => {
  it("reads healthspan inputs from the compact ClickHouse read model", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        week_start: "2026-03-03",
        ...makeRawHealthspanRow(),
      },
    ]);
    const ctx = makeFetchContext({
      sensorStore: makeSensorStore({
        query,
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      }),
    });

    await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    const queryText = query.mock.calls[0]?.[1];
    expect(queryText).toContain("analytics.weekly_healthspan");
    expect(queryText).not.toContain("analytics.healthspan_activity_zone_minutes");
    expect(queryText).not.toContain("analytics.v_sleep");
    expect(queryText).not.toContain("fitness.v_daily_metrics");
  });

  it("aggregates weekly healthspan rows into the route raw shape", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        week_start: "2026-03-03",
        avg_sleep_min: 420,
        bedtime_stddev_min: 20,
        avg_resting_hr: 55,
        avg_steps: 8000,
        latest_vo2max: 42,
        weekly_aerobic_min: 120,
        weekly_high_intensity_min: 30,
        sessions_per_week: 2,
        weight_kg: 80,
        body_fat_pct: 20,
      },
      {
        week_start: "2026-03-10",
        avg_sleep_min: 480,
        bedtime_stddev_min: 40,
        avg_resting_hr: 53,
        avg_steps: 10000,
        latest_vo2max: 45,
        weekly_aerobic_min: 180,
        weekly_high_intensity_min: 60,
        sessions_per_week: 3,
        weight_kg: 79,
        body_fat_pct: 19,
      },
    ]);
    const ctx = makeFetchContext({
      sensorStore: makeSensorStore({
        query,
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      }),
    });

    const row = await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    expect(row).toMatchObject({
      avg_sleep_min: 450,
      bedtime_stddev_min: 30,
      avg_resting_hr: 54,
      avg_steps: 9000,
      latest_vo2max: 45,
      weekly_aerobic_min: 150,
      weekly_high_intensity_min: 45,
      sessions_per_week: 2.5,
      weight_kg: 79,
      body_fat_pct: 19,
      weekly_history: [
        { week_start: "2026-03-03", avg_rhr: 55, avg_steps: 8000, avg_vo2max: 42 },
        { week_start: "2026-03-10", avg_rhr: 53, avg_steps: 10000, avg_vo2max: 45 },
      ],
    });
  });

  it("does not leak partial weeks for limited access windows", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const ctx = makeFetchContext({
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-03-05",
        endDateExclusive: "2026-03-12",
      },
      sensorStore: makeSensorStore({ query }),
    });

    await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    const queryText = query.mock.calls[0]?.[1];
    expect(queryText).toContain("healthspan.week_start >= toDate({accessStartDate:String})");
    expect(queryText).toContain(
      "healthspan.week_start + INTERVAL 7 DAY <= toDate({accessEndDateExclusive:String})",
    );
    expect(queryText).not.toContain("toMonday(toDate({accessStartDate:String}))");
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      accessStartDate: "2026-03-05",
      accessEndDateExclusive: "2026-03-12",
    });
  });

  it("counts missing activity weeks as zero for weekly activity averages", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        week_start: "2026-03-03",
        ...makeRawHealthspanRow({
          weekly_aerobic_min: 120,
          weekly_high_intensity_min: 30,
          sessions_per_week: 3,
        }),
      },
      {
        week_start: "2026-03-10",
        ...makeRawHealthspanRow(),
      },
    ]);
    const ctx = makeFetchContext({
      sensorStore: makeSensorStore({ query }),
    });

    const row = await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    expect(row).toMatchObject({
      weekly_aerobic_min: 60,
      weekly_high_intensity_min: 15,
      sessions_per_week: 1.5,
    });
  });
});
