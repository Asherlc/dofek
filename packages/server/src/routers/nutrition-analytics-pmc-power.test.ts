import type { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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
    cachedProtectedQuery: () => trpc.procedure,
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

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

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
  return queryText.includes("CROSS JOIN user_baseline ub");
}

function isPmcNormalizedPowerQuery(queryText: string): boolean {
  return (
    queryText.includes("FROM analytics.activity_summary") &&
    queryText.includes("normalized_power IS NOT NULL")
  );
}

function makePmcSensorStore(
  activityRows: unknown[],
  normalizedPowerRows: unknown[] = [],
): SensorStore {
  return {
    query: vi.fn(
      async (schema: { parse: (row: unknown) => unknown }, queryText = ""): Promise<unknown[]> => {
        let rows: unknown[];
        if (isPmcNormalizedPowerQuery(queryText)) {
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
    it("returns empty when no globalMaxHr", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore([]),
      });
      const result = await caller.chart({ days: 180 });

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
      expect(result.availability).toMatchObject({
        status: "insufficient_data",
        sourceLabel: "Training load read model",
        observedCount: 0,
        minimumCount: 1,
        message:
          "No training load data is available from the training load read model. Record at least 1 activity with heart-rate or power data to show this chart.",
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
        sensorStore: makePmcSensorStore(rows),
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
      // Need 10+ paired activities for learned model
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
        np: 200,
      }));
      const caller = createCaller({
        db: makeRawActivityCountDb(
          rows.length,
          rows.map((row) => String(row.id)),
        ),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makePmcSensorStore(rows, normalizedPowerRows),
      });
      const result = await caller.chart({ days: 180 });

      expect(result.model.ftp).not.toBeNull();
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
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.chart({ days: 180 });
      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
    });
  });
});

describe("powerRouter", () => {
  const createCaller = createTestCallerFactory(powerRouter);

  /** Generate 1-second power samples for a single activity. */
  function makePowerSamples(
    activityId: string,
    activityDate: string,
    powers: number[],
    intervalSeconds = 1,
  ) {
    return powers.map((power) => ({
      activity_id: activityId,
      activity_date: activityDate,
      power,
      interval_s: intervalSeconds,
    }));
  }

  describe("powerCurve", () => {
    it("returns power curve with model", async () => {
      // 1200 samples at 1s = 20 minutes of data — covers 5s through 1200s durations
      const samples = makePowerSamples(
        "act-1",
        "2024-01-15",
        Array.from({ length: 1200 }, (_, i) => 250 + Math.round(50 * Math.sin(i / 100))),
      );
      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: {
          query: vi.fn().mockResolvedValue([]),
          getPowerCurveSamples: vi.fn().mockResolvedValue(samples),
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
      // First call: query() reads from analytics.activity_summary for NP data
      const npRows = [
        {
          activity_id: "act-1",
          activity_date: "2024-01-15",
          activity_name: "Ride",
          normalized_power: 260,
        },
      ];
      // Second call: power curve samples — 1200 samples for CP model fallback
      const pcSamples = makePowerSamples(
        "act-1",
        "2024-01-15",
        Array.from({ length: 1200 }, (_, i) => 250 + Math.round(50 * Math.sin(i / 100))),
      );

      const caller = createCaller({
        db: makeRawActivityCountDb(1),
        sensorStore: {
          query: vi.fn(async (_schema, queryText = "") => {
            if (queryText.includes("activity_power_curve")) {
              return [];
            }
            return npRows;
          }),
          getPowerCurveSamples: vi.fn().mockResolvedValue(pcSamples),
        },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.eftpTrend({ days: 365 });

      expect(result.trend).toHaveLength(1);
      // Normalized Power of constant 260W = 260, eFTP = 260 * 0.95 = 247
      expect(result.trend[0]?.eftp).toBe(247);
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
