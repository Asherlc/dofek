import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/data-join.ts";
import { joinByDate } from "../insights/data-join.ts";
import {
  CorrelationRepository,
  computeCorrelation,
  computeCorrelationV2,
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

describe("computeCorrelationV2 mutation boundaries", () => {
  it("applies negative, zero, and positive lags to the exact eligible calendar days", () => {
    const joined = Array.from({ length: 7 }, (_, index) =>
      makeJoinedDay({
        date: `2025-01-0${index + 1}`,
        resting_hr: 60 + index,
        hrv: 30 + index,
      }),
    );

    const negative = computeCorrelationV2(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 7,
      lag: -1,
      endDate: "2025-01-07",
    });
    const zero = computeCorrelationV2(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 7,
      lag: 0,
      endDate: "2025-01-07",
    });
    const positive = computeCorrelationV2(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: 7,
      lag: 1,
      endDate: "2025-01-07",
    });

    expect(negative.dataPoints).toEqual([
      { date: "2025-01-02", x: 61, y: 30 },
      { date: "2025-01-03", x: 62, y: 31 },
      { date: "2025-01-04", x: 63, y: 32 },
      { date: "2025-01-05", x: 64, y: 33 },
      { date: "2025-01-06", x: 65, y: 34 },
      { date: "2025-01-07", x: 66, y: 35 },
    ]);
    expect(negative.coverage).toEqual({
      selectedDayCount: 7,
      eligiblePairDayCount: 6,
      observedXDayCount: 6,
      observedYDayCount: 6,
      pairedDayCount: 6,
      missingPairDayCount: 0,
    });
    expect(zero.dataPoints).toHaveLength(7);
    expect(zero.coverage).toEqual({
      selectedDayCount: 7,
      eligiblePairDayCount: 7,
      observedXDayCount: 7,
      observedYDayCount: 7,
      pairedDayCount: 7,
      missingPairDayCount: 0,
    });
    expect(positive.dataPoints).toEqual([
      { date: "2025-01-01", x: 60, y: 31 },
      { date: "2025-01-02", x: 61, y: 32 },
      { date: "2025-01-03", x: 62, y: 33 },
      { date: "2025-01-04", x: 63, y: 34 },
      { date: "2025-01-05", x: 64, y: 35 },
      { date: "2025-01-06", x: 65, y: 36 },
    ]);
  });

  it("sorts an all-time spine and returns no eligible dates when its end precedes the data", () => {
    const joined = [
      makeJoinedDay({ date: "2025-01-05", resting_hr: 65, hrv: 35 }),
      makeJoinedDay({ date: "2025-01-03", resting_hr: 63, hrv: 33 }),
      makeJoinedDay({ date: "2025-01-04", resting_hr: 64, hrv: 34 }),
    ];

    const sorted = computeCorrelationV2(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: null,
      lag: 0,
      endDate: "2025-01-06",
    });
    const beforeData = computeCorrelationV2(joined, {
      metricX: "resting_hr",
      metricY: "hrv",
      days: null,
      lag: 0,
      endDate: "2025-01-02",
    });
    const emptyAllTime = computeCorrelationV2([], {
      metricX: "resting_hr",
      metricY: "hrv",
      days: null,
      lag: 0,
    });

    expect(sorted.coverage).toEqual({
      selectedDayCount: 4,
      eligiblePairDayCount: 4,
      observedXDayCount: 3,
      observedYDayCount: 3,
      pairedDayCount: 3,
      missingPairDayCount: 1,
    });
    expect(beforeData.coverage).toEqual({
      selectedDayCount: 0,
      eligiblePairDayCount: 0,
      observedXDayCount: 0,
      observedYDayCount: 0,
      pairedDayCount: 0,
      missingPairDayCount: 0,
    });
    expect(beforeData.uncertainty).toMatchObject({
      availability: "unavailable",
      blockLength: 0,
      reason: "insufficient_pairs",
    });
    expect(emptyAllTime.coverage.selectedDayCount).toBe(0);
  });

  it("reports exact labels and singular counts below the five-pair boundary", () => {
    const onePair = computeCorrelationV2(
      [makeJoinedDay({ date: "2025-01-05", resting_hr: 60, hrv: 30 })],
      {
        metricX: "resting_hr",
        metricY: "hrv",
        days: 5,
        lag: 0,
        endDate: "2025-01-05",
      },
    );
    const fourPairs = computeCorrelationV2(
      Array.from({ length: 4 }, (_, index) =>
        makeJoinedDay({
          date: `2025-01-0${index + 1}`,
          resting_hr: 60 + index,
          hrv: 30 + index,
        }),
      ),
      {
        metricX: "resting_hr",
        metricY: "hrv",
        days: 4,
        lag: 0,
        endDate: "2025-01-04",
      },
    );

    expect(onePair.insight).toBe(
      "Insufficient data to describe the relationship between Resting Heart Rate and Heart Rate Variability (only 1 paired calendar day; 4 more are required).",
    );
    expect(onePair.uncertainty).toMatchObject({
      blockLength: 2,
      reason: "insufficient_pairs",
    });
    expect(fourPairs.insight).toBe(
      "Insufficient data to describe the relationship between Resting Heart Rate and Heart Rate Variability (only 4 paired calendar days; 1 more is required).",
    );
  });

  it("returns the exact bounded effect, regression, and insight at the available boundary", () => {
    const result = computeCorrelationV2(
      Array.from({ length: 5 }, (_, index) =>
        makeJoinedDay({
          date: `2025-01-0${index + 1}`,
          resting_hr: 60 + index,
          hrv: 30 - index,
        }),
      ),
      {
        metricX: "resting_hr",
        metricY: "hrv",
        days: 5,
        lag: 0,
        endDate: "2025-01-05",
      },
    );

    expect(result).toMatchObject({
      availability: "available",
      regression: {
        slope: -1,
        intercept: 90,
        rSquared: 1,
      },
      sampleCount: 5,
      insight:
        "resting heart rate vs heart rate variability on the same calendar day: Spearman rho = -1.00 across 5 paired calendar days.",
    });
    expect(result.spearmanRho).toBeCloseTo(-1, 12);
  });

  it("preserves missing calendar markers while bootstrapping paired observations", () => {
    const result = computeCorrelationV2(
      Array.from({ length: 10 }, (_, index) =>
        makeJoinedDay({
          date: `2025-01-${String(index + 1).padStart(2, "0")}`,
          resting_hr: index % 2 === 0 || index % 4 === 1 ? 60 + index : null,
          hrv: index % 2 === 0 ? 40 - index : index % 4 === 3 ? 100 + index : null,
        }),
      ),
      {
        metricX: "resting_hr",
        metricY: "hrv",
        days: 10,
        lag: 0,
        endDate: "2025-01-10",
      },
    );

    expect(result.coverage).toEqual({
      selectedDayCount: 10,
      eligiblePairDayCount: 10,
      observedXDayCount: 8,
      observedYDayCount: 7,
      pairedDayCount: 5,
      missingPairDayCount: 5,
    });
    expect(result.uncertainty).toMatchObject({
      availability: "available",
      method: "circular_moving_block_bootstrap",
      blockLength: 3,
      requestedReplicateCount: 2_000,
      validReplicateCount: 2_000,
    });
    if (result.uncertainty.availability !== "available") {
      throw new Error("Expected an available uncertainty interval");
    }
    expect(result.uncertainty.attemptedReplicateCount).toBeGreaterThan(2_000);
    expect(result.uncertainty.lower).toBeCloseTo(-1, 12);
    expect(result.uncertainty.upper).toBeCloseTo(-1, 12);
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
    it("queries canonical Postgres and ClickHouse correlation sources", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce(
        Array.from({ length: 5 }, (_, index) =>
          makeJoinedDay({
            date: `2024-06-0${index + 1}`,
            resting_hr: 60 + index,
            hrv: 30 - index,
          }),
        ),
      );
      const db = makeDb();
      const sensorStore = makeSensorStore();
      const repo = new CorrelationRepository(db, "user-1", "UTC", sensorStore);
      const result = await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-05");
      expect(result).toMatchObject({
        availability: "available",
        sampleCount: 5,
      });
      if (result.availability !== "available") {
        throw new Error("Expected an available legacy correlation");
      }
      expect(result.spearmanRho).toBeCloseTo(-1, 12);
      expect(db.execute).toHaveBeenCalledTimes(2);
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.v_body_measurement"),
        expect.anything(),
      );
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.activity_summary"),
        expect.anything(),
      );
      const activityQuery = sensorStore.query.mock.calls.find(([, query]) =>
        query.includes("analytics.activity_summary"),
      );
      expect(activityQuery?.[1]).toMatch(
        /toDate\(toTimeZone\(started_at, \{timezone:String\}\)\)\)\s+AS date/,
      );
      expect(activityQuery?.[2]).toEqual(expect.objectContaining({ timezone: "UTC" }));
    });

    it("returns insufficient result for empty data", async () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1", "UTC", makeSensorStore());
      const result = await repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01");
      expect(result.sampleCount).toBe(0);
      expect(result.confidenceLevel).toBe("insufficient");
    });
  });

  describe("computeV2", () => {
    it("propagates the required end date and computation arguments", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce(
        Array.from({ length: 5 }, (_, index) =>
          makeJoinedDay({
            date: `2024-06-0${index + 1}`,
            resting_hr: 60 + index,
            hrv: 30 - index,
          }),
        ),
      );
      const db = makeDb();
      const sensorStore = makeSensorStore();
      const repo = new CorrelationRepository(db, "user-1", "America/Los_Angeles", sensorStore);

      const result = await repo.computeV2("resting_hr", "hrv", 5, 0, "2024-06-05");

      expect(result).toMatchObject({
        availability: "available",
        sampleCount: 5,
        interpretationWarning:
          "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.",
      });
      expect(result.spearmanRho).toBeCloseTo(-1, 12);
      const activityQuery = sensorStore.query.mock.calls.find(([, query]) =>
        query.includes("analytics.activity_summary"),
      );
      expect(activityQuery?.[2]).toEqual(
        expect.objectContaining({
          timezone: "America/Los_Angeles",
          endDate: "2024-06-05",
          days: 5,
        }),
      );
    });

    it("includes the interpretation warning when paired data is insufficient", async () => {
      const db = makeDb();
      const repo = new CorrelationRepository(db, "user-1", "UTC", makeSensorStore());

      const result = await repo.computeV2("resting_hr", "hrv", 90, 0, "2024-06-01");

      expect(result).toMatchObject({
        availability: "insufficient",
        interpretationWarning:
          "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.",
      });
    });
  });
});
