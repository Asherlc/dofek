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
    db: {
      execute: vi
        .fn()
        .mockResolvedValueOnce([{ weekly_exercise_min: null }])
        .mockResolvedValueOnce([makeRawHealthspanRow()]),
    },
    userId: "user-1",
    timezone: "UTC",
    accessWindow: fullAccessWindow,
    ...overrides,
  };
}

describe("fetchHealthspanRawData", () => {
  it("reads precomputed zone minutes from the ClickHouse read model", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const ctx = makeFetchContext({
      sensorStore: makeSensorStore({
        query,
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
      }),
    });

    await fetchHealthspanRawData(ctx, "2026-03-15", 14);

    const zoneQuery = query.mock.calls.find(
      ([, queryText]) =>
        typeof queryText === "string" &&
        queryText.includes("analytics.healthspan_activity_zone_minutes"),
    )?.[1];
    expect(zoneQuery).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("analytics.healthspan_activity_zone_minutes"),
      expect.objectContaining({
        windowStart: "2026-03-01 00:00:00",
        windowEndExclusive: "2026-03-16 00:00:00",
      }),
    );
    expect(zoneQuery).toContain("started_at < toDateTime({windowEndExclusive:String})");
    expect(zoneQuery).not.toContain("analytics.deduped_sensor");
    expect(zoneQuery).not.toContain("analytics.activity_summary");
  });
});
