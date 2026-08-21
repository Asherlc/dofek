import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { PowerRepository } from "./power-repository.ts";

function makeDb(...callResults: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (const rows of callResults) {
    execute.mockResolvedValueOnce(rows);
  }
  return { execute };
}

function makeAnalyticsStore() {
  return {
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn(),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ConstructorParameters<typeof PowerRepository>[2];
}

function makeAnalyticsStoreFromDb(db: ReturnType<typeof makeDb>) {
  return {
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn(() => db.execute()),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    query: vi.fn(async (_schema: unknown, queryText?: string) => {
      if (queryText?.includes("activity_power_curve")) {
        return [];
      }
      return db.execute();
    }),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ConstructorParameters<typeof PowerRepository>[2];
}

describe("PowerRepository", () => {
  function expectCyclingOnlyActivityTypes(activityTypes: unknown) {
    expect(activityTypes).toEqual([...CYCLING_ACTIVITY_TYPES]);
    expect(activityTypes).not.toContain("walking");
    expect(activityTypes).not.toContain("running");
    expect(activityTypes).not.toContain("hiking");
  }

  it("can be instantiated", () => {
    const db = makeDb();
    const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
    expect(repo).toBeInstanceOf(PowerRepository);
  });

  describe("getPowerCurve", () => {
    it("returns empty points array when no samples", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(result.points).toEqual([]);
      expect(result.model).toBeNull();
    });

    it("does not scan power samples when no raw activities exist", async () => {
      const analyticsStore = makeAnalyticsStore();
      const db = makeDb([{ activity_count: 0 }]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore, db);
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(result).toEqual({ points: [], model: null });
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(analyticsStore.getPowerCurveSamples).not.toHaveBeenCalled();
    });

    it("reads power samples from the ClickHouse analytics store instead of Postgres", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(analyticsStore.getPowerCurveSamples).toHaveBeenCalledWith(90, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
    });

    it("omits the read-model lower-bound predicate for an unbounded power curve", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([
        { duration_seconds: 300, best_power: 300, activity_date: "2024-06-16" },
      ]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);

      await repo.getPowerCurve(ChartRange.fromDays(null));

      const queryText = analyticsStore.query.mock.calls[0]?.[1];
      const queryParams = analyticsStore.query.mock.calls[0]?.[2];
      expect(queryText).toContain("FROM analytics.activity_power_curve AS power_curve FINAL");
      expect(queryText).not.toContain("power_curve.started_at > now() - INTERVAL");
      expect(queryParams).not.toHaveProperty("days");
    });

    it("passes null to raw sample fallback for an unbounded power curve", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);

      await repo.getPowerCurve(ChartRange.fromDays(null));

      expect(analyticsStore.getPowerCurveSamples).toHaveBeenCalledWith(null, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
    });

    it("computes power curve from samples", async () => {
      // Build enough samples to cover 5s duration at 1s intervals
      const samples = Array.from({ length: 10 }, (_, index) => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200 + index,
        interval_s: 1,
      }));
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce(samples);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(result.points.length).toBeGreaterThan(0);
      expect(result.points[0]).toMatchObject({
        durationSeconds: expect.any(Number),
        label: expect.any(String),
        bestPower: expect.any(Number),
        activityDate: "2024-06-15",
      });
    });

    it("generates fallback label for unknown duration seconds", async () => {
      // 7s is not in DURATION_LABELS, so fallback to "7s"
      const samples = Array.from({ length: 10 }, () => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200,
        interval_s: 1,
      }));
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce(samples);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));
      // Check that labels are either from DURATION_LABELS or end with "s"
      for (const point of result.points) {
        expect(point.label.length).toBeGreaterThan(0);
      }
    });

    it("aggregates read-model power curve rows without scanning raw samples", async () => {
      const readModelRows = [
        { duration_seconds: 300, best_power: 280, activity_date: "2024-06-15" },
        { duration_seconds: 300, best_power: 300, activity_date: "2024-06-16" },
        { duration_seconds: 1200, best_power: 250, activity_date: "2024-06-15" },
      ];
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(readModelRows);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(analyticsStore.getPowerCurveSamples).not.toHaveBeenCalled();
      expect(analyticsStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("activity_power_curve"),
        expect.objectContaining({
          userId: "user-1",
          timezone: "UTC",
          days: 90,
        }),
      );
      expectCyclingOnlyActivityTypes(analyticsStore.query.mock.calls[0]?.[2]?.activityTypes);
      const queryText = analyticsStore.query.mock.calls[0]?.[1];
      expect(queryText).toContain("power_curve.started_at > now() - INTERVAL {days:Int32} DAY");
      expect(queryText).toContain("INNER JOIN analytics.activity_summary AS activity_summary");
      expect(queryText).not.toContain("analytics.activity_summary AS activity_summary FINAL");
      expect(queryText).toContain(
        "has({activityTypes:Array(String)}, activity_summary.canonical_type)",
      );

      const fiveMinutePoint = result.points.find((point) => point.durationSeconds === 300);
      const twentyMinutePoint = result.points.find((point) => point.durationSeconds === 1200);

      expect(fiveMinutePoint).toMatchObject({
        bestPower: 300,
        activityDate: "2024-06-16",
      });
      expect(twentyMinutePoint).toMatchObject({
        bestPower: 250,
        activityDate: "2024-06-15",
      });
      expect(result.points.length).toBeGreaterThan(0);
    });
  });

  describe("getEftpTrend", () => {
    it("returns empty trend when no samples", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([]);
      analyticsStore.getNormalizedPowerSamples.mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toEqual([]);
      expect(result.currentEftp).toBeNull();
      expect(result.model).toBeNull();
    });

    it("omits the read-model lower-bound predicate and uses unbounded fallback samples for all-time eFTP trend", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([]);
      analyticsStore.getNormalizedPowerSamples.mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);

      await repo.getEftpTrend(ChartRange.fromDays(null));

      const queryText = analyticsStore.query.mock.calls[0]?.[1];
      const queryParams = analyticsStore.query.mock.calls[0]?.[2];
      expect(queryText).toContain("FROM analytics.activity_summary");
      expect(queryText).not.toContain("started_at > now() - INTERVAL {days:Int32} DAY");
      expect(queryParams).not.toHaveProperty("days");
      expect(analyticsStore.getNormalizedPowerSamples).toHaveBeenCalledWith(null, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
      expect(analyticsStore.getPowerCurveSamples).toHaveBeenCalledWith(90, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
    });

    it("computes eFTP from raw power samples when the activity summary has no normalized power", async () => {
      const rawPowerSamples = Array.from({ length: 60 }, () => ({
        activity_id: "act-raw-power",
        activity_date: "2026-07-01",
        activity_name: "Power Meter Ride",
        power: 200,
        interval_s: 1,
      }));
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([]);
      analyticsStore.getNormalizedPowerSamples.mockResolvedValueOnce(rawPowerSamples);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(analyticsStore.getNormalizedPowerSamples).toHaveBeenCalledWith(365, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
      expect(result.trend).toStrictEqual([
        {
          date: "2026-07-01",
          activityName: "Power Meter Ride",
          eftp: 190,
        },
      ]);
      expect(result.currentEftp).toBe(190);
    });

    it("does not scan normalized power or power curve samples when no raw activities exist", async () => {
      const analyticsStore = makeAnalyticsStore();
      const db = makeDb([{ activity_count: 0 }]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore, db);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result).toEqual({ trend: [], currentEftp: null, model: null });
      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(analyticsStore.query).not.toHaveBeenCalled();
      expect(analyticsStore.getPowerCurveSamples).not.toHaveBeenCalled();
    });

    it("reads eFTP samples from the activity_summary read model", async () => {
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(analyticsStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.activity_summary"),
        expect.objectContaining({
          days: 365,
        }),
      );
      const queryText = analyticsStore.query.mock.calls[0]?.[1];
      expect(queryText).toContain("started_at > now() - INTERVAL {days:Int32} DAY");
      expectCyclingOnlyActivityTypes(analyticsStore.query.mock.calls[0]?.[2]?.activityTypes);
      expect(analyticsStore.getPowerCurveSamples).toHaveBeenCalledWith(90, "user-1", "UTC", [
        ...CYCLING_ACTIVITY_TYPES,
      ]);
    });

    it("computes eFTP as NP * 0.95", async () => {
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: "2024-06-15",
          activity_name: "Morning Ride",
          normalized_power: 200,
        },
      ];

      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(1);
      expect(result.trend[0]?.date).toBe("2024-06-15");
      expect(result.trend[0]?.activityName).toBe("Morning Ride");
      // NP = 200, eFTP = 200 * 0.95 = 190
      expect(result.trend[0]?.eftp).toBe(190);
    });

    it("rounds eFTP to integer (Math.round)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: today,
          activity_name: "Ride",
          normalized_power: 251,
        },
      ];
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // NP = 251, eFTP = 251 * 0.95 = 238.45 → 238
      expect(result.trend[0]?.eftp).toBe(238);
      expect(Number.isInteger(result.trend[0]?.eftp)).toBe(true);
    });

    it("returns null currentEftp when no CP model and no recent trend data", async () => {
      // Old data that falls outside 90-day cutoff for fallback
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 200);
      const dateStr = oldDate.toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: dateStr,
          activity_name: "Old Ride",
          normalized_power: 200,
        },
      ];
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // Trend exists but is outside 90-day window for currentEftp
      expect(result.trend).toHaveLength(1);
      expect(result.currentEftp).toBeNull();
    });

    it("falls back to max NP * 0.95 when CP model fails", async () => {
      // Use a recent date so the fallback filter includes it
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: today,
          activity_name: "Ride",
          normalized_power: 250,
        },
      ];

      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.model).toBeNull();
      // NP = 250, eFTP = 250 * 0.95 = 237.5 => 238
      expect(result.currentEftp).toBe(238);
    });

    it("uses 90-day window for CP model fallback (not 30 or 180)", async () => {
      const boundaryDate = new Date();
      boundaryDate.setDate(boundaryDate.getDate() - 90);
      const boundaryDateStr = boundaryDate.toISOString().slice(0, 10);

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 91);
      const oldDateStr = oldDate.toISOString().slice(0, 10);

      const npRows = [
        {
          activity_id: "act-boundary",
          activity_date: boundaryDateStr,
          activity_name: "Boundary Ride",
          normalized_power: 280,
        },
        {
          activity_id: "act-old",
          activity_date: oldDateStr,
          activity_name: "Old Ride",
          normalized_power: 300,
        },
      ];

      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows).mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(2);
      // Exactly 90 days ago is included; 91 days ago is excluded from the fallback window.
      expect(result.currentEftp).toBe(266);
    });

    it("uses 0.95 multiplier for eFTP (not 0.9 or 1.0)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: today,
          activity_name: "Ride",
          normalized_power: 200,
        },
      ];
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // NP = 200, eFTP = 200 * 0.95 = 190 (not 180 if 0.9, not 200 if 1.0)
      expect(result.trend[0]?.eftp).toBe(190);
    });

    it("queries activity_summary and the power curve read model before falling back to raw samples", async () => {
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: "2024-06-15",
          activity_name: "Ride",
          normalized_power: 200,
        },
      ];
      const analyticsStore = makeAnalyticsStore();
      analyticsStore.query.mockResolvedValueOnce(npRows).mockResolvedValueOnce([]);
      analyticsStore.getPowerCurveSamples.mockResolvedValueOnce([]);
      const repo = new PowerRepository("user-1", "UTC", analyticsStore);
      await repo.getEftpTrend(ChartRange.fromDays(365));
      expect(analyticsStore.query).toHaveBeenCalledTimes(2);
      expect(analyticsStore.getPowerCurveSamples).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPowerCurve", () => {
    it("uses fallback label format 'Xs' for unknown durations", async () => {
      // Build 8 samples at 1s intervals to get a 5s duration point
      const samples = Array.from({ length: 8 }, () => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      // All points should have non-empty labels (either from DURATION_LABELS or fallback "Xs")
      if (result.points.length > 0) {
        expect(result.points.every((point) => point.label.length > 0)).toBe(true);
      }
    });
  });

  describe("getPowerCurve mapping", () => {
    it("maps each field to the correct property (durationSeconds, label, bestPower, activityDate)", async () => {
      const samples = Array.from({ length: 10 }, (_, index) => ({
        activity_id: "act-map",
        activity_date: "2024-08-01",
        power: 250 + index,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      expect(result.points.length).toBeGreaterThan(0);
      for (const point of result.points) {
        // durationSeconds should be a positive number
        expect(point.durationSeconds).toBeGreaterThan(0);
        // label should be a non-empty string
        expect(typeof point.label).toBe("string");
        expect(point.label.length).toBeGreaterThan(0);
        // bestPower should be a positive number
        expect(point.bestPower).toBeGreaterThan(0);
        // activityDate should be "2024-08-01"
        expect(point.activityDate).toBe("2024-08-01");
      }
    });

    it("returns model as null when not enough data for CP fitting", async () => {
      const samples = Array.from({ length: 10 }, () => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));
      // With only one short activity, CP model cannot be fitted
      expect(result.model).toStrictEqual(null);
    });
  });

  describe("getEftpTrend mapping", () => {
    it("maps activityName to trend output correctly (non-null case)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-named",
          activity_date: today,
          activity_name: "Evening Ride",
          normalized_power: 220,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(1);
      expect(result.trend[0]?.activityName).toStrictEqual("Evening Ride");
      expect(result.trend[0]?.date).toBe(today);
      // NP=220, eFTP=220*0.95=209
      expect(result.trend[0]?.eftp).toBe(209);
    });

    it("maps activityName as null when activity has no name", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-noname",
          activity_date: today,
          activity_name: null,
          normalized_power: 200,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      for (const entry of result.trend) {
        expect(entry.activityName).toStrictEqual(null);
      }
    });

    it("currentEftp uses model.cp when CP model is available", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-cp",
          activity_date: today,
          activity_name: "Test",
          normalized_power: 250,
        },
      ];

      const pcSamples = [
        ...Array.from({ length: 120 }, () => ({
          activity_id: "pc-sprint",
          activity_date: today,
          power: 400,
          interval_s: 1,
        })),
        ...Array.from({ length: 1200 }, () => ({
          activity_id: "pc-endurance",
          activity_date: today,
          power: 200,
          interval_s: 1,
        })),
      ];

      const db = makeDb(npRows, pcSamples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      // If a CP model was fitted, currentEftp should equal model.cp
      if (result.model) {
        expect(result.currentEftp).toBe(result.model.cp);
      }
    });

    it("eFTP uses multiplication not division (NP * 0.95 not NP / 0.95)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-arith",
          activity_date: today,
          activity_name: "Test Ride",
          normalized_power: 100,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // NP=100, eFTP = 100 * 0.95 = 95 (if / instead of *, would be ~105)
      expect(result.trend[0]?.eftp).toBe(95);
      expect(result.trend[0]?.eftp).toBeLessThan(100);
    });

    it("currentEftp fallback filters by >= cutoff (not > cutoff)", async () => {
      const exactCutoff = new Date();
      exactCutoff.setDate(exactCutoff.getDate() - 89);
      const cutoffStr = exactCutoff.toISOString().slice(0, 10);

      const npRows = [
        {
          activity_id: "act-boundary",
          activity_date: cutoffStr,
          activity_name: "Boundary Ride",
          normalized_power: 200,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(1);
      expect(result.currentEftp).toBe(190);
    });

    it("returns complete trend object with all three keys", async () => {
      const db = makeDb([], []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // ObjectLiteral mutation: ensure all keys are present
      expect(Object.keys(result).sort()).toStrictEqual(["currentEftp", "model", "trend"]);
    });

    it("returns complete power curve object with points and model keys", async () => {
      const db = makeDb([]);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));
      expect(Object.keys(result).sort()).toStrictEqual(["model", "points"]);
    });

    it("trend entry has exactly three keys: date, eftp, activityName", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-keys",
          activity_date: today,
          activity_name: "Ride",
          normalized_power: 200,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(1);
      expect(Object.keys(result.trend[0] ?? {}).sort()).toStrictEqual([
        "activityName",
        "date",
        "eftp",
      ]);
    });

    it("power curve point has exactly four keys", async () => {
      const samples = Array.from({ length: 10 }, (_, index) => ({
        activity_id: "act-1",
        activity_date: "2024-06-15",
        power: 200 + index,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));
      if (result.points.length > 0) {
        expect(Object.keys(result.points[0] ?? {}).sort()).toStrictEqual([
          "activityDate",
          "bestPower",
          "durationSeconds",
          "label",
        ]);
      }
    });

    it("selects max eFTP from recent trend when CP model is null", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const npRows = [
        {
          activity_id: "act-high",
          activity_date: today,
          activity_name: "Strong Ride",
          normalized_power: 300,
        },
        {
          activity_id: "act-low",
          activity_date: yesterdayStr,
          activity_name: "Easy Ride",
          normalized_power: 200,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend).toHaveLength(2);
      expect(result.model).toStrictEqual(null);
      // Fallback: max of 300*0.95=285 and 200*0.95=190 -> 285
      expect(result.currentEftp).toBe(285);
    });
  });

  describe("mutation-killing: arithmetic and comparison operators", () => {
    it("eFTP rounding uses Math.round not Math.floor or Math.ceil", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-round",
          activity_date: today,
          activity_name: "Test Ride",
          normalized_power: 210,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      // NP=210, 210*0.95=199.5, Math.round(199.5)=200
      expect(result.trend[0]?.eftp).toBe(200);
    });

    it("currentEftp fallback uses Math.max not Math.min on eFTP values", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const npRows = [
        {
          activity_id: "act-max-check",
          activity_date: today,
          activity_name: "Hard Ride",
          normalized_power: 280,
        },
        {
          activity_id: "act-min-check",
          activity_date: yesterdayStr,
          activity_name: "Easy Ride",
          normalized_power: 180,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      // Should pick max: 280*0.95=266 not min: 180*0.95=171
      expect(result.currentEftp).toBe(266);
      expect(result.currentEftp).not.toBe(171);
    });

    it("currentEftp is null (not -Infinity or 0) when model is null and recent array is empty", async () => {
      // recent.length > 0 ? Math.max(...) : null
      // If > mutated to >=, empty array would produce Math.max() = -Infinity
      const db = makeDb([], []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));
      expect(result.currentEftp).toStrictEqual(null);
    });

    it("date filter uses >= for cutoff comparison (not strictly >)", async () => {
      vi.useFakeTimers();
      try {
        // Pin UTC so cutoff math matches activity_date strings (YYYY-MM-DD).
        vi.setSystemTime(new Date("2026-05-24T12:00:00.000Z"));
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const npRows = [
          {
            activity_id: "act-gte",
            activity_date: cutoff.toISOString().slice(0, 10),
            activity_name: "Boundary Ride",
            normalized_power: 240,
          },
        ];
        const db = makeDb(npRows, []);
        const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
        const result = await repo.getEftpTrend(ChartRange.fromDays(365));

        // 240*0.95=228, should be included exactly at the 90-day cutoff.
        expect(result.currentEftp).toBe(228);
      } finally {
        vi.useRealTimers();
      }
    });

    it("currentEftp prefers model.cp over fallback when model exists", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-cp-pref",
          activity_date: today,
          activity_name: "Test",
          normalized_power: 250,
        },
      ];

      const pcSamples = [
        ...Array.from({ length: 120 }, () => ({
          activity_id: "pc-short",
          activity_date: today,
          power: 450,
          interval_s: 1,
        })),
        ...Array.from({ length: 1200 }, () => ({
          activity_id: "pc-long",
          activity_date: today,
          power: 210,
          interval_s: 1,
        })),
      ];

      const db = makeDb(npRows, pcSamples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      if (result.model) {
        // currentEftp should equal model.cp (not the NP-based fallback)
        expect(result.currentEftp).toBe(result.model.cp);
      }
    });

    it("DURATION_LABELS fallback uses durationSeconds with 's' suffix (not empty string)", async () => {
      // DURATION_LABELS[result.durationSeconds] ?? `${result.durationSeconds}s`
      const samples = Array.from({ length: 15 }, (_, index) => ({
        activity_id: "act-label",
        activity_date: "2024-06-15",
        power: 200 + index,
        interval_s: 1,
      }));
      const db = makeDb(samples);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));

      for (const point of result.points) {
        // Every label should be non-empty
        expect(point.label.length).toBeGreaterThan(0);
        // If it's a fallback label, it should end with 's'
        if (
          !point.label.includes("min") &&
          !point.label.includes("sec") &&
          !point.label.includes("hr")
        ) {
          expect(point.label).toMatch(/\d+s$/);
        }
      }
    });

    it("getPowerCurve returns points array (not null or undefined) when no samples", async () => {
      const db = makeDb([]);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getPowerCurve(ChartRange.fromDays(90));
      expect(Array.isArray(result.points)).toBe(true);
      expect(result.points).toStrictEqual([]);
      expect(result.model).toBeNull();
    });

    it("getEftpTrend trend maps date from activity_date (not activityName)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const npRows = [
        {
          activity_id: "act-date-map",
          activity_date: today,
          activity_name: "Not A Date",
          normalized_power: 200,
        },
      ];
      const db = makeDb(npRows, []);
      const repo = new PowerRepository("user-1", "UTC", makeAnalyticsStoreFromDb(db));
      const result = await repo.getEftpTrend(ChartRange.fromDays(365));

      expect(result.trend[0]?.date).toBe(today);
      expect(result.trend[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.trend[0]?.date).not.toBe("Not A Date");
    });
  });
});
