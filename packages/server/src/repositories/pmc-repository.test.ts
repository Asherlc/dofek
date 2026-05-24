import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { PmcRepository } from "./pmc-repository.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn().mockReturnValue({
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    },
    trainingImpulseConstants: {
      genderFactor: 1.92,
      exponent: 1.67,
    },
  }),
}));

function dateStringDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function makeActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    global_max_hr: 190,
    resting_hr: 60,
    id: "activity-1",
    date: dateStringDaysAgo(2),
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeSensorStore(
  activityRows: unknown[],
  normalizedPowerRows: unknown[],
): ActivitySensorStore {
  const query = vi.fn();
  query.mockResolvedValueOnce(activityRows);
  query.mockResolvedValueOnce(normalizedPowerRows);
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
  } satisfies ActivitySensorStore;
}

function makeRepoHarness(
  activityRows: Record<string, unknown>[] = [],
  normalizedPowerRows: Record<string, unknown>[] = [],
  timezone = "UTC",
) {
  const db = { execute: vi.fn() };
  const sensorStore = makeSensorStore(activityRows, normalizedPowerRows);
  return {
    repo: new PmcRepository(db, "user-1", timezone, sensorStore),
    query: sensorStore.query,
  };
}

describe("PmcRepository", () => {
  describe("getChart", () => {
    it("passes timezone and expanded query window to ClickHouse activity and power queries", async () => {
      const { repo, query } = makeRepoHarness(
        [makeActivityRow({ avg_power: null, power_samples: 0 })],
        [],
        "America/Los_Angeles",
      );

      await repo.getChart(30);

      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.stringContaining("analytics.activity_summary"),
        expect.objectContaining({
          userId: "user-1",
          timezone: "America/Los_Angeles",
          queryDays: 407,
        }),
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.stringContaining("analytics.deduped_sensor"),
        { userId: "user-1", queryDays: 407 },
      );
    });

    it("extends query history when requested display days exceed the minimum history", async () => {
      const { repo, query } = makeRepoHarness([], []);

      await repo.getChart(400);

      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.stringContaining("INTERVAL {queryDays:Int32} DAY"),
        expect.objectContaining({ queryDays: 442 }),
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.stringContaining("INTERVAL {queryDays:Int32} DAY"),
        expect.objectContaining({ queryDays: 442 }),
      );
    });

    it("reads sample counts and normalized power from deduped ClickHouse sensors", async () => {
      const { repo, query } = makeRepoHarness(
        [makeActivityRow()],
        [{ activity_id: "activity-1", np: 220 }],
      );

      await repo.getChart(90);

      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.stringContaining("countIf(channel = 'heart_rate') AS hr_samples"),
        expect.anything(),
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.stringContaining("INNER JOIN analytics.v_activity a ON a.id = ds.activity_id"),
        expect.anything(),
      );
    });

    it("returns chart data built from ClickHouse rows", async () => {
      const { repo } = makeRepoHarness(
        [makeActivityRow({ id: "power-activity" })],
        [{ activity_id: "power-activity", np: 220 }],
      );

      const result = await repo.getChart(90);

      expect(result.model.ftp).toBe(190);
      expect(result.data.length).toBeGreaterThan(0);
      expect(Object.keys(result).sort()).toStrictEqual(["data", "model"]);
    });
  });
});
