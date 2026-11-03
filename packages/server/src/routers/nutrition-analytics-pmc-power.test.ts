import type { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { pmcThresholdHistoryRows } from "../repositories/pmc-test-helpers.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      sensorStore?: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn().mockReturnValue({
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    },
  }),
}));

vi.mock("@dofek/training/power-analysis", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    linearRegression: vi.fn((xs: number[], ys: number[]) => {
      const count = xs.length;
      if (count < 2) return { slope: 0, intercept: 0, r2: 0 };
      let sumX = 0,
        sumY = 0,
        sumXY = 0,
        sumX2 = 0;
      for (let i = 0; i < count; i++) {
        const xValue = xs[i] ?? 0;
        const yValue = ys[i] ?? 0;
        sumX += xValue;
        sumY += yValue;
        sumXY += xValue * yValue;
        sumX2 += xValue * xValue;
      }
      const denom = count * sumX2 - sumX * sumX;
      if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };
      const slope = (count * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / count;
      return { slope, intercept, r2: 0.8 };
    }),
    fitCriticalPower: vi.fn(() => ({ cp: 250, wPrime: 20000, r2: 0.99 })),
    DURATION_LABELS: { 60: "1 min", 300: "5 min", 1200: "20 min" },
  };
});

import { nutritionAnalyticsRouter } from "./nutrition-analytics.ts";
import { pmcRouter } from "./pmc.ts";
import { powerRouter } from "./power.ts";

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(rows: unknown[] = []): SensorStore {
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

function isPmcActivityChartQuery(queryText: string): boolean {
  return queryText.includes("FROM analytics.activity_summary asum");
}

function isPmcNormalizedPowerQuery(queryText: string): boolean {
  return queryText.includes("FROM analytics.cycling_activity_power_metrics");
}

function makePmcSensorStore(
  activityRows: unknown[],
  normalizedPowerRows: unknown[] = [],
  currentEftp: number | null = null,
): SensorStore {
  return {
    query: vi.fn(
      async (schema: { parse: (row: unknown) => unknown }, queryText = ""): Promise<unknown[]> => {
        let rows: unknown[];
        if (queryText.includes("cycling_threshold_history")) {
          rows = pmcThresholdHistoryRows(currentEftp);
        } else if (isPmcNormalizedPowerQuery(queryText)) {
          rows = normalizedPowerRows;
        } else if (isPmcActivityChartQuery(queryText)) {
          rows = activityRows;
        } else {
          throw new Error(`Unexpected PMC sensor store query: ${queryText.slice(0, 160)}`);
        }
        return rows.map((row) => schema.parse(row));
      },
    ),
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

function makeRawActivityCountDb(activityCount: number, visibleIds: string[] = []) {
  const execute = vi.fn();
  execute.mockResolvedValueOnce([{ activity_count: activityCount }]);
  if (visibleIds.length > 0) {
    execute.mockResolvedValueOnce(visibleIds.map((id) => ({ id })));
  }
  execute.mockResolvedValue([]);
  return { execute };
}

describe("nutritionAnalyticsRouter", () => {
  const createCaller = createTestCallerFactory(nutritionAnalyticsRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      sensorStore: makeSensorStore(rows),
      userId: "user-1",
      timezone: "UTC",
    });
  }

  describe("micronutrientAdequacy", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.micronutrientAdequacy({ days: 30 });
      expect(result).toEqual([]);
    });

    it("computes adequacy percentages", async () => {
      const rows = [
        {
          nutrient: "Vitamin C",
          unit: "mg",
          rda: 90,
          avg_intake: 60,
          days_tracked: 10,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.micronutrientAdequacy({ days: 30 });

      const vitC = result.find((r) => r.nutrient === "Vitamin C");
      expect(vitC).toBeDefined();
      expect(vitC?.avgIntake).toBe(60);
      expect(vitC?.percentRda).toBeCloseTo(66.7, 0);
    });
  });

  describe("adaptiveTdee", () => {
    it("returns null TDEE when insufficient data", async () => {
      const rows = [
        {
          date: new Date().toISOString().slice(0, 10),
          calories_in: 2200,
          resolution_status: "available",
          excluded_source_labels: [],
          weight_kg: 75,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.adaptiveTdee({ days: 90 });

      expect(result.estimatedTdee).toBeNull();
      expect(result.status).toBe("unavailable");
      expect(result.evidence.acceptedWindows).toBe(0);
    });

    it("estimates TDEE from calorie and weight data", async () => {
      // Create 35 days of data (enough for 28-day window)
      const rows = [];
      for (let i = 0; i < 35; i++) {
        const date = new Date();
        date.setDate(date.getDate() - (34 - i));
        rows.push({
          date: date.toISOString().slice(0, 10),
          calories_in: 2200,
          resolution_status: "available",
          excluded_source_labels: [],
          weight_kg: i < 10 || i > 25 ? 75 - i * 0.01 : null,
        });
      }
      const caller = makeCaller(rows);
      const result = await caller.adaptiveTdee({ days: 90 });

      expect(result.dailyData).toHaveLength(90);
      expect(result.status).toBe("available");
      expect(result.evidence.acceptedWindows).toBeGreaterThan(0);
    });
  });

  describe("macroRatios", () => {
    it("computes macro percentages", async () => {
      const rows = [
        {
          date: "2024-01-15",
          protein_g: 150,
          carbs_g: 250,
          fat_g: 70,
          calories: 2200,
          weight_kg: 75,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.macroRatios({ days: 30 });

      expect(result).toHaveLength(1);
      const firstRow = result[0];
      // protein: 150*4=600, carbs: 250*4=1000, fat: 70*9=630. total=2230
      expect(firstRow.proteinPct).toBeCloseTo(26.9, 0);
      expect(firstRow.proteinPerKg).toBe(2); // 150/75
    });

    it("handles null weight", async () => {
      const rows = [
        {
          date: "2024-01-15",
          protein_g: 100,
          carbs_g: 200,
          fat_g: 60,
          calories: 2000,
          weight_kg: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.macroRatios({ days: 30 });

      expect(result[0]?.proteinPerKg).toBeNull();
    });
  });
});

describe("pmcRouter", () => {
  const createCaller = createTestCallerFactory(pmcRouter);

  describe("chart", () => {
    it("versions the availability response cache contract", () => {
      expect(cachedQueryOptions).toContainEqual({
        maxAge: 3_600_000,
        keyVersion: "pmc-chart-power-v2",
      });
    });

    it("returns empty when no cycling activities exist", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore([]),
      });
      const result = await caller.chart({ days: 180 });

      expect(result.data).toEqual([]);
      expect(result.model.ftp).toBeNull();
      expect(result.availability).toMatchObject({
        status: "insufficient_data",
        sourceLabel: "Training load read model",
        observedCount: 0,
        minimumCount: 1,
        message:
          "No training load data is available from the training load read model. Record cycling power with a usable threshold to show this chart.",
      });
    });

    it("computes PMC data from activities", async () => {
      const today = new Date();
      const rows = [
        {
          global_max_hr: 190,
          resting_hr: 55,
          id: "a1",
          date: today.toISOString().slice(0, 10),
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 3600,
        },
      ];
      const caller = createCaller({
        db: makeRawActivityCountDb(
          rows.length,
          rows.map((row) => String(row.id)),
        ),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore(rows, [{ activity_id: "a1", power_tss: 75 }]),
      });
      const result = await caller.chart({ days: 180 });

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.model).toBeDefined();
      expect(result.availability).toMatchObject({
        status: "available",
        sourceLabel: "Training load read model",
        observedCount: result.data.length,
        minimumCount: 1,
        message: "Training load data is available from the training load read model.",
      });
    });

    it("uses power TSS when power data available", async () => {
      const today = new Date();
      const rows = [];
      for (let i = 0; i < 12; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        rows.push({
          global_max_hr: 190,
          resting_hr: 55,
          id: `a${i}`,
          date: date.toISOString().slice(0, 10),
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: 200,
          power_samples: 3600,
          hr_samples: 3600,
        });
      }
      const normalizedPowerRows = rows.map((row) => ({
        activity_id: String(row.id),
        power_tss: 64,
        eftp: 250,
      }));
      const caller = createCaller({
        db: makeRawActivityCountDb(
          rows.length,
          rows.map((row) => String(row.id)),
        ),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore(rows, normalizedPowerRows, 275),
      });
      const result = await caller.chart({ days: 180 });

      expect(result.model).toMatchObject({ ftp: 275 });
      expect(result.data.length).toBeGreaterThan(0);
    });
  });

  describe("access window gating", () => {
    it("chart passes accessWindow to repository (limited window returns empty)", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore([]),
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_recent_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.chart({ days: 180 });
      expect(result.data).toEqual([]);
      expect(result.model.ftp).toBeNull();
    });
  });
});

describe("powerRouter", () => {
  const createCaller = createTestCallerFactory(powerRouter);

  describe("powerCurve", () => {
    it("returns power curve with model", async () => {
      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: {
          query: vi.fn().mockResolvedValue([
            { duration_seconds: 300, best_power: 300, activity_date: "2024-01-15" },
            { duration_seconds: 120, best_power: 400, activity_date: "2024-01-15" },
          ]),
        },
      });
      const result = await caller.powerCurve({ days: 90 });

      expect(result.points.length).toBeGreaterThan(0);
      expect(result.points[0]?.label).toBeTruthy();
      for (const point of result.points) {
        expect(point.bestPower).toBeGreaterThan(0);
      }
    });

    it("returns empty points when no data", async () => {
      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: {
          query: vi.fn().mockResolvedValue([]),
          getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        },
      });
      const result = await caller.powerCurve({ days: 90 });
      expect(result.points).toEqual([]);
    });

    it("throws PRECONDITION_FAILED when sensor store is missing", async () => {
      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.powerCurve({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
      });
    });
  });

  describe("eftpTrend", () => {
    it("returns eFTP trend data", async () => {
      const current = {
        event_at: "2026-08-01T00:00:00Z",
        activity_id: null,
        eftp: 245,
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
        model_version: "v1",
      };
      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        sensorStore: {
          query: vi.fn(async (_schema, queryText = "") =>
            queryText.includes("ORDER BY history.event_at DESC")
              ? [current]
              : [{ date: "2024-01-15", eftp: 250, activityName: "Ride" }],
          ),
        },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.eftpTrend({ days: 365 });

      expect(result.trend).toHaveLength(1);
      expect(result.trend[0]?.eftp).toBe(250);
      expect(result.currentEftp).toBe(245);
      expect(result.currentEvidence.model_version).toBe("v1");
    });

    it("throws PRECONDITION_FAILED when sensor store is missing", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.eftpTrend({ days: 365 })).rejects.toMatchObject<Partial<TRPCError>>({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
      });
    });
  });
});
