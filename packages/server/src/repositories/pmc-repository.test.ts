import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
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
  const query = vi.fn(
    async (schema: { parse: (row: unknown) => unknown }, queryText = ""): Promise<unknown[]> => {
      const rows = queryText.includes("normalized_power") ? normalizedPowerRows : activityRows;
      return rows.map((row, rowIndex) => {
        try {
          return schema.parse(row);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid PMC sensor-store fixture at row ${rowIndex}: ${message}`);
        }
      });
    },
  );
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
  rawActivityCount = activityRows.length,
) {
  const execute = vi.fn();
  execute.mockResolvedValueOnce([{ activity_count: rawActivityCount }]);
  if (activityRows.length > 0) {
    execute.mockResolvedValueOnce(activityRows.map((row) => ({ id: String(row.id) })));
  }
  execute.mockResolvedValue([]);
  const db = { execute };
  const sensorStore = makeSensorStore(activityRows, normalizedPowerRows);
  return {
    repo: new PmcRepository(db, "user-1", timezone, sensorStore),
    execute: db.execute,
    query: sensorStore.query,
  };
}

describe("PmcRepository", () => {
  function expectCyclingOnlyActivityTypes(activityTypes: unknown) {
    expect(activityTypes).toEqual([...CYCLING_ACTIVITY_TYPES]);
    expect(activityTypes).not.toContain("walking");
    expect(activityTypes).not.toContain("running");
    expect(activityTypes).not.toContain("hiking");
  }

  describe("getChart", () => {
    it("returns empty data with generic model when no raw activities exist", async () => {
      const { repo } = makeRepoHarness([], [], "UTC", 0);

      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model).toEqual({
        type: "generic",
        pairedActivities: 0,
        r2: null,
        ftp: null,
      });
    });

    it("does not scan activity_summary or deduped_sensor when no raw activities exist", async () => {
      const { repo, execute, query } = makeRepoHarness([], [], "UTC", 0);

      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    });

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
      expectCyclingOnlyActivityTypes(vi.mocked(query).mock.calls[0]?.[2]?.activityTypes);
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.stringContaining("analytics.activity_summary"),
        expect.objectContaining({ userId: "user-1", queryDays: 407 }),
      );
      expectCyclingOnlyActivityTypes(vi.mocked(query).mock.calls[1]?.[2]?.activityTypes);
    });

    it("extends query history when requested display days exceed the minimum history", async () => {
      const { repo, query } = makeRepoHarness([], [], "UTC", 1);

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

    it("reads sample counts from the activity summary read model", async () => {
      const { repo, query } = makeRepoHarness(
        [makeActivityRow()],
        [{ activity_id: "activity-1", np: 220 }],
      );

      await repo.getChart(90);

      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.stringContaining("coalesce(asum.hr_sample_count, 0) AS hr_samples"),
        expect.anything(),
      );
      expect(vi.mocked(query).mock.calls[0]?.[1]).not.toContain("sample_counts AS");
      expect(vi.mocked(query).mock.calls[0]?.[1]).not.toContain(
        "INNER JOIN analytics.deduped_sensor AS samples",
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.stringContaining("FROM analytics.activity_summary"),
        expect.anything(),
      );
      expect(vi.mocked(query).mock.calls[1]?.[1]).toContain("normalized_power");
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
