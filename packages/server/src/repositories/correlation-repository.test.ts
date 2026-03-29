import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/engine.ts";
import {
  CorrelationRepository,
  computeCorrelation,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "./correlation-repository.ts";

vi.mock("../insights/engine.ts", () => ({
  joinByDate: vi.fn().mockReturnValue([]),
}));

function makeJoinedDay(overrides: Partial<JoinedDay> & { date: string }): JoinedDay {
  return {
    resting_hr: null,
    hrv: null,
    spo2_avg: null,
    skin_temp_c: null,
    sleep_duration_min: null,
    deep_min: null,
    rem_min: null,
    sleep_efficiency: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
    steps: null,
    active_energy_kcal: null,
    exercise_minutes: null,
    cardio_minutes: null,
    strength_minutes: null,
    flexibility_minutes: null,
    weight_kg: null,
    body_fat_pct: null,
    weight_30d_avg: null,
    ...overrides,
  };
}

// ── extractMetricValue ──────────────────────────────────────────────────

describe("extractMetricValue", () => {
  it("returns the value for a known metric", () => {
    const day = makeJoinedDay({ date: "2024-01-01", resting_hr: 62 });
    expect(extractMetricValue(day, "resting_hr")).toBe(62);
  });

  it("returns null for a null field", () => {
    const day = makeJoinedDay({ date: "2024-01-01", hrv: null });
    expect(extractMetricValue(day, "hrv")).toBeNull();
  });

  it("returns null for an unknown metric id", () => {
    const day = makeJoinedDay({ date: "2024-01-01" });
    expect(extractMetricValue(day, "nonexistent_metric")).toBeNull();
  });
});

// ── downsample ──────────────────────────────────────────────────────────

describe("downsample", () => {
  it("returns the original array when length <= max", () => {
    const arr = [1, 2, 3];
    expect(downsample(arr, 5)).toBe(arr);
  });

  it("returns the original array when length equals max", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(downsample(arr, 5)).toBe(arr);
  });

  it("reduces the array to the specified max", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = downsample(arr, 10);
    expect(result).toHaveLength(10);
  });

  it("samples evenly across the array", () => {
    const arr = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const result = downsample(arr, 5);
    expect(result).toEqual([0, 20, 40, 60, 80]);
  });
});

// ── computeStats ────────────────────────────────────────────────────────

describe("computeStats", () => {
  it("computes correct stats for a set of values", () => {
    const stats = computeStats([10, 20, 30, 40, 50]);
    expect(stats.mean).toBe(30);
    expect(stats.median).toBe(30);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.n).toBe(5);
    expect(stats.stddev).toBeCloseTo(Math.sqrt(250), 5);
  });

  it("handles even-length arrays for median", () => {
    const stats = computeStats([10, 20, 30, 40]);
    expect(stats.median).toBe(25);
  });

  it("handles a single value", () => {
    const stats = computeStats([42]);
    expect(stats.mean).toBe(42);
    expect(stats.median).toBe(42);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
    expect(stats.stddev).toBe(0);
    expect(stats.n).toBe(1);
  });
});

// ── emptyStats ──────────────────────────────────────────────────────────

describe("emptyStats", () => {
  it("returns all zeros", () => {
    expect(emptyStats()).toEqual({ mean: 0, median: 0, stddev: 0, min: 0, max: 0, n: 0 });
  });

  it("returns a new object each time", () => {
    expect(emptyStats()).not.toBe(emptyStats());
  });
});

// ── computeCorrelation with empty data ──────────────────────────────────

describe("computeCorrelation", () => {
  it("returns insufficient result when data is empty", () => {
    const result = computeCorrelation([], {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 0,
    });
    expect(result.sampleCount).toBe(0);
    expect(result.confidenceLevel).toBe("insufficient");
    expect(result.spearmanRho).toBe(0);
    expect(result.pearsonR).toBe(0);
    expect(result.dataPoints).toEqual([]);
  });

  it("returns insufficient result with fewer than 5 paired points", () => {
    const joined = [
      makeJoinedDay({ date: "2024-01-01", resting_hr: 60, hrv: 40 }),
      makeJoinedDay({ date: "2024-01-02", resting_hr: 62, hrv: 38 }),
      makeJoinedDay({ date: "2024-01-03", resting_hr: 58, hrv: 42 }),
    ];
    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 0,
    });
    expect(result.sampleCount).toBe(3);
    expect(result.confidenceLevel).toBe("insufficient");
    expect(result.insight).toContain("Insufficient data");
  });

  it("computes correlation with sufficient data", () => {
    const joined = Array.from({ length: 10 }, (_, i) =>
      makeJoinedDay({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        resting_hr: 60 + i,
        hrv: 50 - i,
      }),
    );
    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 0,
    });
    expect(result.sampleCount).toBe(10);
    expect(result.confidenceLevel).not.toBe("insufficient");
    expect(result.spearmanRho).toBeLessThan(0);
    expect(result.pearsonR).toBeLessThan(0);
    expect(result.xStats.n).toBe(10);
    expect(result.yStats.n).toBe(10);
  });
});

// ── CorrelationRepository ───────────────────────────────────────────────

function makeDb() {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([]) // metrics
    .mockResolvedValueOnce([]) // sleep
    .mockResolvedValueOnce([]) // activities
    .mockResolvedValueOnce([]) // nutrition
    .mockResolvedValueOnce([]); // bodyComp
  return { execute };
}

describe("CorrelationRepository", () => {
  describe("getMetrics", () => {
    it("returns correlation metrics with id, label, unit, domain, description", () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1");
      const metrics = repo.getMetrics();
      expect(metrics.length).toBeGreaterThan(0);
      for (const metric of metrics) {
        expect(metric).toHaveProperty("id");
        expect(metric).toHaveProperty("label");
        expect(metric).toHaveProperty("unit");
        expect(metric).toHaveProperty("domain");
        expect(metric).toHaveProperty("description");
      }
    });
  });

  describe("compute", () => {
    it("executes 5 queries (one per dataset)", async () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1");
      await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01");
      expect(db.execute).toHaveBeenCalledTimes(5);
    });

    it("returns insufficient result for empty data", async () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1");
      const result = await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01");
      expect(result.sampleCount).toBe(0);
      expect(result.confidenceLevel).toBe("insufficient");
    });
  });
});
