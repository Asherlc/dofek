import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/engine.ts";
import {
  computeCorrelation,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "./correlation.ts";

function makeDay(overrides: Partial<JoinedDay> & { date: string }): JoinedDay {
  return {
    resting_hr: null,
    hrv: null,
    spo2_avg: null,
    steps: null,
    active_energy_kcal: null,
    skin_temp_c: null,
    sleep_duration_min: null,
    deep_min: null,
    rem_min: null,
    sleep_efficiency: null,
    exercise_minutes: null,
    cardio_minutes: null,
    strength_minutes: null,
    flexibility_minutes: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
    weight_kg: null,
    body_fat_pct: null,
    weight_30d_avg: null,
    body_fat_30d_avg: null,
    weight_30d_delta: null,
    body_fat_30d_delta: null,
    ...overrides,
  };
}

describe("extractMetricValue", () => {
  it("extracts a known metric from a JoinedDay", () => {
    const day = makeDay({ date: "2025-01-01", hrv: 55 });
    expect(extractMetricValue(day, "hrv")).toBe(55);
  });

  it("returns null for a metric with no data", () => {
    const day = makeDay({ date: "2025-01-01" });
    expect(extractMetricValue(day, "hrv")).toBeNull();
  });

  it("returns null for an unknown metric id", () => {
    const day = makeDay({ date: "2025-01-01", hrv: 55 });
    expect(extractMetricValue(day, "nonexistent")).toBeNull();
  });
});

describe("computeCorrelation", () => {
  function generateCorrelatedDays(n: number): JoinedDay[] {
    const days: JoinedDay[] = [];
    for (let i = 0; i < n; i++) {
      const date = `2025-01-${String(i + 1).padStart(2, "0")}`;
      days.push(
        makeDay({
          date,
          protein_g: 100 + i * 2,
          hrv: 50 + i, // Perfectly correlated with protein
        }),
      );
    }
    return days;
  }

  it("computes correlation between two metrics with sufficient data", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBe(30);
    expect(result.spearmanRho).toBeCloseTo(1, 1);
    expect(result.pearsonR).toBeCloseTo(1, 1);
    expect(result.regression.rSquared).toBeCloseTo(1, 1);
    expect(result.confidenceLevel).toBe("strong");
    expect(result.dataPoints.length).toBe(30);
    expect(result.insight).toContain("protein");
    expect(result.insight).toContain("heart rate variability");
  });

  it("returns insufficient results when too few data points", () => {
    const days = generateCorrelatedDays(3);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBeLessThan(5);
    expect(result.confidenceLevel).toBe("insufficient");
  });

  it("supports lag > 0 to offset metrics by days", () => {
    // Create data where protein today correlates with HRV tomorrow
    const days: JoinedDay[] = [];
    for (let i = 0; i < 30; i++) {
      days.push(
        makeDay({
          date: `2025-01-${String(i + 1).padStart(2, "0")}`,
          protein_g: 100 + i * 5,
          hrv: i > 0 ? 50 + (i - 1) : 50, // HRV follows previous day's protein pattern
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 1,
    });

    expect(result.sampleCount).toBe(29); // one less due to lag
    expect(result.insight).toMatch(/next.day|1.day later/i);
  });

  it("downsamples data points when too many", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 500; i++) {
      days.push(
        makeDay({
          date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          steps: 5000 + i * 10,
          calories: 2000 + i * 5,
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "steps",
      metricY: "calories",
      days: 365,
      lag: 0,
    });

    expect(result.dataPoints.length).toBeLessThanOrEqual(300);
  });

  it("handles metrics with mostly null values", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 30; i++) {
      days.push(
        makeDay({
          date: `2025-01-${String(i + 1).padStart(2, "0")}`,
          hrv: i % 10 === 0 ? 55 : null, // only 3 non-null values
          steps: 8000 + i * 100,
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "hrv",
      metricY: "steps",
      days: 365,
      lag: 0,
    });

    expect(result.sampleCount).toBeLessThan(5);
    expect(result.confidenceLevel).toBe("insufficient");
  });

  it("includes descriptive stats for both axes", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });

    expect(result.xStats.mean).toBeGreaterThan(0);
    expect(result.xStats.min).toBeLessThanOrEqual(result.xStats.max);
    expect(result.yStats.mean).toBeGreaterThan(0);
    expect(result.yStats.n).toBe(30);
  });

  it("correctly extracts all metric types from JoinedDay", () => {
    const day = makeDay({
      date: "2025-01-01",
      resting_hr: 60,
      hrv: 50,
      spo2_avg: 98,
      skin_temp_c: 36.5,
      sleep_duration_min: 480,
      deep_min: 100,
      rem_min: 80,
      sleep_efficiency: 85,
      calories: 2000,
      protein_g: 100,
      carbs_g: 250,
      fat_g: 70,
      fiber_g: 30,
      steps: 10000,
      active_energy_kcal: 500,
      exercise_minutes: 60,
      cardio_minutes: 30,
      strength_minutes: 20,
      weight_kg: 75,
      body_fat_pct: 20,
      weight_30d_avg: 74.5,
    });

    // Recovery
    expect(extractMetricValue(day, "resting_hr")).toBe(60);
    expect(extractMetricValue(day, "hrv")).toBe(50);
    expect(extractMetricValue(day, "spo2")).toBe(98);
    expect(extractMetricValue(day, "skin_temp")).toBe(36.5);
    // Sleep
    expect(extractMetricValue(day, "sleep_duration")).toBe(480);
    expect(extractMetricValue(day, "deep_sleep")).toBe(100);
    expect(extractMetricValue(day, "rem_sleep")).toBe(80);
    expect(extractMetricValue(day, "sleep_efficiency")).toBe(85);
    // Nutrition
    expect(extractMetricValue(day, "calories")).toBe(2000);
    expect(extractMetricValue(day, "protein")).toBe(100);
    expect(extractMetricValue(day, "carbs")).toBe(250);
    expect(extractMetricValue(day, "fat")).toBe(70);
    expect(extractMetricValue(day, "fiber")).toBe(30);
    // Activity
    expect(extractMetricValue(day, "steps")).toBe(10000);
    expect(extractMetricValue(day, "active_calories")).toBe(500);
    expect(extractMetricValue(day, "exercise_duration")).toBe(60);
    expect(extractMetricValue(day, "cardio_duration")).toBe(30);
    expect(extractMetricValue(day, "strength_duration")).toBe(20);
    // Body
    expect(extractMetricValue(day, "weight")).toBe(75);
    expect(extractMetricValue(day, "body_fat")).toBe(20);
    expect(extractMetricValue(day, "weight_30d")).toBe(74.5);
  });

  it("handles edge case with exactly MAX_DATA_POINTS data points", () => {
    const days: JoinedDay[] = [];
    for (let i = 0; i < 300; i++) {
      days.push(
        makeDay({
          date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          steps: 5000 + i,
          calories: 2000 + i,
        }),
      );
    }

    const result = computeCorrelation(days, {
      metricX: "steps",
      metricY: "calories",
      days: 365,
      lag: 0,
    });

    expect(result.dataPoints.length).toBeLessThanOrEqual(300);
    expect(result.sampleCount).toBe(300);
  });

  it("returns consistent stats when computed with different lag values", () => {
    const days = generateCorrelatedDays(30);
    const result0 = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    const result1 = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 1,
    });

    expect(result0.sampleCount).toBeGreaterThan(result1.sampleCount);
    expect(result0.dataPoints.length).toBeGreaterThan(0);
    expect(result1.dataPoints.length).toBeGreaterThan(0);
  });

  it("returns neutral color for insufficient data", () => {
    const days = generateCorrelatedDays(3);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    expect(result.correlationColor).toBe("#71717a");
  });

  it("uses metric labels in insight text", () => {
    const days = generateCorrelatedDays(30);
    const result = computeCorrelation(days, {
      metricX: "protein",
      metricY: "hrv",
      days: 365,
      lag: 0,
    });
    // Verify labels are used (not raw IDs)
    expect(result.insight).toContain("protein");
    expect(result.insight).not.toContain("protein_g");
  });
});

describe("downsample", () => {
  it("returns the same array when arr.length <= max", () => {
    const arr = [1, 2, 3];
    expect(downsample(arr, 5)).toEqual([1, 2, 3]);
    expect(downsample(arr, 3)).toEqual([1, 2, 3]);
  });

  it("returns exactly max items when arr.length > max", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(arr, 10);
    expect(result).toHaveLength(10);
  });

  it("picks evenly spaced items for a known input", () => {
    // 10 items downsampled to 4: step = 10/4 = 2.5
    // indices: floor(0*2.5)=0, floor(1*2.5)=2, floor(2*2.5)=5, floor(3*2.5)=7
    const arr = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const result = downsample(arr, 4);
    expect(result).toEqual([0, 20, 50, 70]);
  });

  it("handles empty array", () => {
    expect(downsample([], 5)).toEqual([]);
  });

  it("handles max=0", () => {
    const result = downsample([1, 2, 3], 0);
    expect(result).toEqual([]);
  });

  it("returns first and sampled items preserving order", () => {
    const arr = [10, 20, 30, 40, 50, 60];
    const result = downsample(arr, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(10);
  });
});

describe("computeStats", () => {
  it("computes correct mean for known values", () => {
    const stats = computeStats([2, 4, 6, 8, 10]);
    expect(stats.mean).toBe(6);
  });

  it("computes correct median for odd-length array", () => {
    const stats = computeStats([3, 1, 5, 2, 4]);
    expect(stats.median).toBe(3);
  });

  it("computes correct median for even-length array", () => {
    const stats = computeStats([1, 3, 5, 7]);
    expect(stats.median).toBe(4);
  });

  it("computes correct min and max", () => {
    const stats = computeStats([10, -3, 7, 0, 42]);
    expect(stats.min).toBe(-3);
    expect(stats.max).toBe(42);
  });

  it("computes correct stddev (sample std dev, using n-1)", () => {
    const stats = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.stddev).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it("n equals the input length", () => {
    const stats = computeStats([1, 2, 3, 4, 5, 6, 7]);
    expect(stats.n).toBe(7);
  });

  it("handles single-element array", () => {
    const stats = computeStats([42]);
    expect(stats.mean).toBe(42);
    expect(stats.median).toBe(42);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
    expect(stats.stddev).toBe(0);
    expect(stats.n).toBe(1);
  });
});

describe("emptyStats", () => {
  it("returns all fields as 0", () => {
    const stats = emptyStats();
    expect(stats).toEqual({ mean: 0, median: 0, stddev: 0, min: 0, max: 0, n: 0 });
  });
});

// ---------------------------------------------------------------------------
// Router procedure tests (kill delegation mutations in correlation.ts)
// ---------------------------------------------------------------------------

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
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

// Must import router AFTER vi.mock declarations
const { correlationRouter } = await import("./correlation.ts");
const { createTestCallerFactory } = await import("./test-helpers.ts");

const createCaller = createTestCallerFactory(correlationRouter);

describe("correlationRouter", () => {
  describe("metrics", () => {
    it("returns available correlation metrics", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.metrics();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("id");
      expect(result[0]).toHaveProperty("label");
    });
  });

  describe("compute", () => {
    it("returns correlation result with insufficient data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.compute({
        metricX: "resting_hr",
        metricY: "hrv",
        days: 90,
        lag: 0,
      });

      expect(result).toHaveProperty("sampleCount");
      expect(result).toHaveProperty("pearsonR");
      expect(result.confidenceLevel).toBe("insufficient");
    });

    it("uses default days (365) and lag (0) when not specified", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      // Should not throw — defaults should apply
      const result = await caller.compute({
        metricX: "resting_hr",
        metricY: "hrv",
      });
      expect(result).toHaveProperty("sampleCount");
    });

    it("rejects lag below 0", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      await expect(
        caller.compute({ metricX: "resting_hr", metricY: "hrv", lag: -1 }),
      ).rejects.toThrow();
    });

    it("rejects lag above 7", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      await expect(
        caller.compute({ metricX: "resting_hr", metricY: "hrv", lag: 8 }),
      ).rejects.toThrow();
    });
  });
});
