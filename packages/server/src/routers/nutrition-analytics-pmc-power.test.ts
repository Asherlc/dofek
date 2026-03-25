import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null; timezone: string }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
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

vi.mock("@dofek/training/power-analysis", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    linearRegression: vi.fn((xs: number[], ys: number[]) => {
      const n = xs.length;
      if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
      let sumX = 0,
        sumY = 0,
        sumXY = 0,
        sumX2 = 0;
      for (let i = 0; i < n; i++) {
        const x = xs[i] ?? 0;
        const y = ys[i] ?? 0;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      }
      const denom = n * sumX2 - sumX * sumX;
      if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      return { slope, intercept, r2: 0.8 };
    }),
    fitCriticalPower: vi.fn(() => ({ cp: 250, wPrime: 20000, r2: 0.99 })),
    DURATION_LABELS: { 60: "1 min", 300: "5 min", 1200: "20 min" },
  };
});

import { nutritionAnalyticsRouter } from "./nutrition-analytics.ts";
import { pmcRouter } from "./pmc.ts";
import { powerRouter } from "./power.ts";

describe("nutritionAnalyticsRouter", () => {
  const createCaller = createTestCallerFactory(nutritionAnalyticsRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
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
          avg_vitamin_c_mg: 60,
          days_vitamin_c_mg: 10,
          avg_iron_mg: 12,
          days_iron_mg: 10,
          avg_fiber_g: 25,
          days_fiber_g: 10,
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

  describe("caloricBalance", () => {
    it("returns caloric balance rows", async () => {
      const rows = [
        {
          date: "2024-01-15",
          calories_in: 2200,
          active_energy: 500,
          basal_energy: 1800,
          total_expenditure: 2300,
          balance: -100,
          rolling_avg_balance: -50,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.caloricBalance({ days: 30 });

      expect(result).toHaveLength(1);
      expect(result[0]?.caloriesIn).toBe(2200);
      expect(result[0]?.balance).toBe(-100);
    });
  });

  describe("adaptiveTdee", () => {
    it("returns null TDEE when insufficient data", async () => {
      const rows = [{ date: "2024-01-15", calories_in: 2200, weight_kg: 75 }];
      const caller = makeCaller(rows);
      const result = await caller.adaptiveTdee({ days: 90 });

      expect(result.estimatedTdee).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it("estimates TDEE from calorie and weight data", async () => {
      // Create 35 days of data (enough for 28-day window)
      const rows = [];
      for (let i = 0; i < 35; i++) {
        const d = new Date("2024-01-01");
        d.setDate(d.getDate() + i);
        rows.push({
          date: d.toISOString().slice(0, 10),
          calories_in: 2200,
          weight_kg: i < 10 || i > 25 ? 75 - i * 0.01 : null,
        });
      }
      const caller = makeCaller(rows);
      const result = await caller.adaptiveTdee({ days: 90 });

      expect(result.dailyData).toHaveLength(35);
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
      const r = result[0];
      // protein: 150*4=600, carbs: 250*4=1000, fat: 70*9=630. total=2230
      expect(r.proteinPct).toBeCloseTo(26.9, 0);
      expect(r.proteinPerKg).toBe(2); // 150/75
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
      });
      const result = await caller.chart({ days: 180 });

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
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
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.chart({ days: 180 });

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.model).toBeDefined();
    });

    it("uses power TSS when power data available", async () => {
      const today = new Date();
      // Need 10+ paired activities for learned model
      const rows = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        rows.push({
          global_max_hr: 190,
          resting_hr: 55,
          id: `a${i}`,
          date: d.toISOString().slice(0, 10),
          duration_min: 60,
          avg_hr: 155,
          max_hr: 180,
          avg_power: 200,
          power_samples: 3600,
          hr_samples: 3600,
        });
      }
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.chart({ days: 180 });

      expect(result.model.ftp).not.toBeNull();
      expect(result.data.length).toBeGreaterThan(0);
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
        db: { execute: vi.fn().mockResolvedValue(samples) },
        userId: "user-1",
        timezone: "UTC",
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
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.powerCurve({ days: 90 });
      expect(result.points).toEqual([]);
    });
  });

  describe("eftpTrend", () => {
    it("returns eFTP trend data", async () => {
      const execute = vi.fn();
      // First call: Normalized Power samples — 300 samples at 1s with ~260W average
      const normalizedPowerSamples = makePowerSamples(
        "act-1",
        "2024-01-15",
        Array.from({ length: 300 }, () => 260),
      ).map((s) => ({ ...s, activity_name: "Ride" }));
      execute.mockResolvedValueOnce(normalizedPowerSamples);
      // Second call: power curve samples — 1200 samples for CP model
      const pcSamples = makePowerSamples(
        "act-1",
        "2024-01-15",
        Array.from({ length: 1200 }, (_, i) => 250 + Math.round(50 * Math.sin(i / 100))),
      );
      execute.mockResolvedValueOnce(pcSamples);

      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.eftpTrend({ days: 365 });

      expect(result.trend).toHaveLength(1);
      // Normalized Power of constant 260W = 260, eFTP = 260 * 0.95 = 247
      expect(result.trend[0]?.eftp).toBe(247);
    });
  });
});
