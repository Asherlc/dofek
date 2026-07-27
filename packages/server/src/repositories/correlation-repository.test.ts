import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/data-join.ts";
import {
  CorrelationRepository,
  computeCorrelation,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "./correlation-repository.ts";

vi.mock("../insights/data-join.ts", () => ({
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
  it("pairs an outcome only with the exact requested calendar date when observations have gaps", () => {
    const joined = [
      makeJoinedDay({ date: "2024-01-01", resting_hr: 61, hrv: 31 }),
      makeJoinedDay({ date: "2024-01-03", resting_hr: 63, hrv: 33 }),
      makeJoinedDay({ date: "2024-01-04", resting_hr: 64, hrv: 34 }),
      makeJoinedDay({ date: "2024-01-05", resting_hr: 65, hrv: 35 }),
      makeJoinedDay({ date: "2024-01-06", resting_hr: 66, hrv: 36 }),
      makeJoinedDay({ date: "2024-01-07", resting_hr: 67, hrv: 37 }),
      makeJoinedDay({ date: "2024-01-08", resting_hr: 68, hrv: 38 }),
    ];

    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 1,
    });

    expect(result.sampleCount).toBe(5);
    expect(result.dataPoints).toEqual([
      { x: 63, y: 34, date: "2024-01-03" },
      { x: 64, y: 35, date: "2024-01-04" },
      { x: 65, y: 36, date: "2024-01-05" },
      { x: 66, y: 37, date: "2024-01-06" },
      { x: 67, y: 38, date: "2024-01-07" },
    ]);
  });

  it("pairs a negative lag with the exact preceding calendar date", () => {
    const joined = [
      makeJoinedDay({ date: "2024-03-09", resting_hr: 59, hrv: 29 }),
      makeJoinedDay({ date: "2024-03-11", resting_hr: 61, hrv: 31 }),
      makeJoinedDay({ date: "2024-03-12", resting_hr: 62, hrv: 32 }),
      makeJoinedDay({ date: "2024-03-13", resting_hr: 63, hrv: 33 }),
      makeJoinedDay({ date: "2024-03-14", resting_hr: 64, hrv: 34 }),
      makeJoinedDay({ date: "2024-03-15", resting_hr: 65, hrv: 35 }),
      makeJoinedDay({ date: "2024-03-16", resting_hr: 66, hrv: 36 }),
    ];

    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: -1,
    });

    expect(result.sampleCount).toBe(5);
    expect(result.dataPoints).toEqual([
      { x: 62, y: 31, date: "2024-03-12" },
      { x: 63, y: 32, date: "2024-03-13" },
      { x: 64, y: 33, date: "2024-03-14" },
      { x: 65, y: 34, date: "2024-03-15" },
      { x: 66, y: 35, date: "2024-03-16" },
    ]);
  });

  it("keeps calendar pairing stable across a leap-day month boundary", () => {
    const joined = [
      makeJoinedDay({ date: "2024-02-27", resting_hr: 57, hrv: 27 }),
      makeJoinedDay({ date: "2024-02-28", resting_hr: 58, hrv: 28 }),
      makeJoinedDay({ date: "2024-02-29", resting_hr: 59, hrv: 29 }),
      makeJoinedDay({ date: "2024-03-01", resting_hr: 61, hrv: 31 }),
      makeJoinedDay({ date: "2024-03-02", resting_hr: 62, hrv: 32 }),
      makeJoinedDay({ date: "2024-03-03", resting_hr: 63, hrv: 33 }),
    ];

    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 1,
    });

    expect(result.sampleCount).toBe(5);
    expect(result.dataPoints).toContainEqual({ x: 58, y: 29, date: "2024-02-28" });
    expect(result.dataPoints).toContainEqual({ x: 59, y: 31, date: "2024-02-29" });
  });

  it("excludes an exact-date pair when the outcome metric is missing", () => {
    const joined = Array.from({ length: 6 }, (_, index) =>
      makeJoinedDay({
        date: `2024-04-${String(index + 1).padStart(2, "0")}`,
        resting_hr: 60 + index,
        hrv: index === 3 ? null : 30 + index,
      }),
    );

    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 1,
    });

    expect(result.sampleCount).toBe(4);
    expect(result.dataPoints).toEqual([
      { x: 60, y: 31, date: "2024-04-01" },
      { x: 61, y: 32, date: "2024-04-02" },
      { x: 63, y: 34, date: "2024-04-04" },
      { x: 64, y: 35, date: "2024-04-05" },
    ]);
  });

  it.each([
    0, 1, 4,
  ])("returns no inferential statistics when only %i paired points are available", (pairCount) => {
    const joined = Array.from({ length: pairCount }, (_, index) =>
      makeJoinedDay({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        resting_hr: 60 + index,
        hrv: 40 - index,
      }),
    );
    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 0,
    });

    expect(result).toMatchObject({
      availability: "insufficient",
      sampleCount: pairCount,
      additionalSamplesRequired: 5 - pairCount,
      confidenceLevel: "insufficient",
    });
    expect(result).not.toHaveProperty("spearmanRho");
    expect(result).not.toHaveProperty("spearmanPValue");
    expect(result).not.toHaveProperty("pearsonR");
    expect(result).not.toHaveProperty("pearsonPValue");
    expect(result).not.toHaveProperty("regression");
    expect(result.insight).toBe(
      `Insufficient data to analyze the relationship between Resting Heart Rate and Heart Rate Variability (only ${pairCount} overlapping data ${
        pairCount === 1 ? "point" : "points"
      }; ${5 - pairCount} more ${5 - pairCount === 1 ? "sample is" : "samples are"} required).`,
    );
  });

  it("returns inferential statistics at the 5-pair boundary", () => {
    const joined = Array.from({ length: 5 }, (_, index) =>
      makeJoinedDay({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        resting_hr: 60 + index,
        hrv: 40 - index,
      }),
    );
    const result = computeCorrelation(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 90,
      lag: 0,
    });

    expect(result).toMatchObject({
      availability: "available",
      sampleCount: 5,
    });
    expect(result).toHaveProperty("spearmanRho");
    expect(result).toHaveProperty("spearmanPValue");
    expect(result).toHaveProperty("pearsonR");
    expect(result).toHaveProperty("pearsonPValue");
    expect(result).toHaveProperty("regression");
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

function makeSensorStore() {
  return {
    query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 52 }]),
  };
}

describe("CorrelationRepository", () => {
  describe("getMetrics", () => {
    it("returns correlation metrics with id, label, unit, domain, description", () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1", "UTC", makeSensorStore());
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
    it("executes 3 Postgres queries and reads sleep/body composition from ClickHouse", async () => {
      const db = makeDb();
      const sensorStore = makeSensorStore();
      const repo = new CorrelationRepository(db, "user-1", "UTC", sensorStore);
      await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01");
      expect(db.execute).toHaveBeenCalledTimes(3);
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.v_body_measurement"),
        expect.anything(),
      );
    });

    it("returns insufficient result for empty data", async () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01");
      expect(result.sampleCount).toBe(0);
      expect(result.confidenceLevel).toBe("insufficient");
    });
  });
});
