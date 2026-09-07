import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/data-join.ts";
import { joinByDate } from "../insights/data-join.ts";
import {
  buildCorrelationObservationPage,
  CorrelationRepository,
  computeCorrelation,
  computeCorrelationV2,
  computeStats,
  downsample,
  emptyStats,
  extractMetricValue,
} from "./correlation-repository.ts";

vi.mock("../insights/data-join.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../insights/data-join.ts")>()),
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

  it.each([0, 1, 4])(
    "returns no inferential statistics when only %i paired points are available",
    (pairCount) => {
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
    },
  );

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

describe("buildCorrelationObservationPage", () => {
  const joined = Array.from({ length: 7 }, (_, index) =>
    makeJoinedDay({
      date: `2025-01-0${index + 1}`,
      cardio_minutes: 30 + index,
      weight_30d_avg: 70 + index,
    }),
  );
  const evidenceByDate = new Map([
    [
      "2025-01-06",
      {
        dailyMetricProviderIds: [],
        sleepProviderIds: [],
        nutritionProviderIds: [],
        bodyProviderIds: ["withings"],
        activities: [
          {
            id: "00000000-0000-4000-8000-000000000106",
            activityType: "running",
            label: "Morning run",
          },
        ],
      },
    ],
    [
      "2025-01-07",
      {
        dailyMetricProviderIds: [],
        sleepProviderIds: [],
        nutritionProviderIds: [],
        bodyProviderIds: ["withings"],
        activities: [
          {
            id: "00000000-0000-4000-8000-000000000107",
            activityType: "cycling",
            label: "Evening ride",
          },
        ],
      },
    ],
  ]);

  it("returns newest-first pages whose union equals the full all-time pair count", () => {
    const first = buildCorrelationObservationPage(
      joined,
      {
        metricX: "cardio_duration",
        metricY: "weight_30d",
        days: null,
        lag: 0,
        endDate: "2025-01-07",
      },
      evidenceByDate,
      { pageSize: 3 },
    );
    const second = buildCorrelationObservationPage(
      joined,
      {
        metricX: "cardio_duration",
        metricY: "weight_30d",
        days: null,
        lag: 0,
        endDate: "2025-01-07",
      },
      evidenceByDate,
      { pageSize: 3, cursor: first.nextCursor ?? undefined },
    );
    const third = buildCorrelationObservationPage(
      joined,
      {
        metricX: "cardio_duration",
        metricY: "weight_30d",
        days: null,
        lag: 0,
        endDate: "2025-01-07",
      },
      evidenceByDate,
      { pageSize: 3, cursor: second.nextCursor ?? undefined },
    );

    expect(first.items.map((item) => item.x.date)).toEqual([
      "2025-01-07",
      "2025-01-06",
      "2025-01-05",
    ]);
    expect(first.totalCount).toBe(7);
    expect([...first.items, ...second.items, ...third.items].map((item) => item.x.date)).toEqual([
      "2025-01-07",
      "2025-01-06",
      "2025-01-05",
      "2025-01-04",
      "2025-01-03",
      "2025-01-02",
      "2025-01-01",
    ]);
    expect(third.nextCursor).toBeNull();
  });

  it("returns explicit lagged X and Y dates and exact activity record navigation", () => {
    const page = buildCorrelationObservationPage(
      joined,
      {
        metricX: "cardio_duration",
        metricY: "weight_30d",
        days: null,
        lag: 1,
        endDate: "2025-01-07",
      },
      evidenceByDate,
      { pageSize: 2 },
    );

    expect(page.items[0]).toEqual({
      x: {
        metricId: "cardio_duration",
        date: "2025-01-06",
        value: 35,
        contributors: [
          {
            kind: "record",
            label: "Morning run",
            providerIds: [],
            target: {
              type: "activity",
              activityId: "00000000-0000-4000-8000-000000000106",
            },
          },
        ],
      },
      y: {
        metricId: "weight_30d",
        date: "2025-01-07",
        value: 76,
        contributors: [
          {
            kind: "aggregate_inputs",
            label: "30-day body measurement inputs",
            providerIds: ["withings"],
            target: { type: "metric_family", family: "body" },
          },
        ],
      },
    });
  });

  it.each([
    ["resting_hr", "Daily recovery aggregate inputs", []],
    ["hrv", "Daily recovery aggregate inputs", ["apple_health"]],
    ["sleep_duration", "Selected sleep-session input", ["eight_sleep"]],
    ["protein", "Canonical daily nutrition inputs", ["cronometer"]],
    ["steps", "Daily activity aggregate inputs", ["apple_health"]],
    ["weight", "Body measurement inputs", ["withings"]],
    ["body_fat", "Body measurement inputs", ["withings"]],
  ] as const)("returns the correct aggregate provenance for %s", (metricId, label, providerIds) => {
    const day = makeJoinedDay({
      date: "2025-02-01",
      resting_hr: 60,
      hrv: 45,
      sleep_duration_min: 480,
      protein_g: 120,
      steps: 8_000,
      weight_kg: 72,
      body_fat_pct: 18,
    });
    const page = buildCorrelationObservationPage(
      [day],
      {
        metricX: metricId,
        metricY: metricId === "hrv" ? "weight" : "hrv",
        days: null,
        lag: 0,
        endDate: day.date,
      },
      new Map([
        [
          day.date,
          {
            dailyMetricProviderIds: ["apple_health"],
            sleepProviderIds: ["eight_sleep"],
            nutritionProviderIds: ["cronometer"],
            bodyProviderIds: ["withings"],
            activities: [],
          },
        ],
      ]),
      { pageSize: 1 },
    );

    expect(page.items[0]?.x.contributors).toEqual([
      {
        kind: "aggregate_inputs",
        label,
        providerIds,
        target: {
          type: "metric_family",
          family:
            metricId === "sleep_duration"
              ? "sleep"
              : metricId === "protein"
                ? "nutrition"
                : metricId === "steps"
                  ? "activity"
                  : metricId === "weight" || metricId === "body_fat"
                    ? "body"
                    : "recovery",
        },
      },
    ]);
  });

  it.each(["hrv", "sleep_duration", "protein", "weight"] as const)(
    "returns empty provider context for %s when no evidence exists",
    (metricId) => {
      const day = makeJoinedDay({
        date: "2025-02-01",
        hrv: 45,
        sleep_duration_min: 480,
        protein_g: 120,
        weight_kg: 72,
      });
      const page = buildCorrelationObservationPage(
        [day],
        {
          metricX: metricId,
          metricY: metricId === "hrv" ? "weight" : "hrv",
          days: null,
          lag: 0,
          endDate: day.date,
        },
        new Map(),
        { pageSize: 1 },
      );

      expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual([]);
    },
  );

  it("filters activity contributors by metric and falls back to aggregate inputs", () => {
    const day = makeJoinedDay({
      date: "2025-02-01",
      hrv: 45,
      exercise_minutes: 90,
      cardio_minutes: 30,
      strength_minutes: 45,
    });
    const activities = [
      {
        id: "00000000-0000-4000-8000-000000000201",
        activityType: "running",
        label: "Run",
      },
      {
        id: "00000000-0000-4000-8000-000000000202",
        activityType: "strength",
        label: "Lift",
      },
      {
        id: "00000000-0000-4000-8000-000000000203",
        activityType: "yoga",
        label: "Yoga",
      },
    ];
    const evidence = new Map([
      [
        day.date,
        {
          dailyMetricProviderIds: [],
          sleepProviderIds: [],
          nutritionProviderIds: [],
          bodyProviderIds: [],
          activities,
        },
      ],
    ]);
    const contributors = (metricX: "exercise_duration" | "cardio_duration" | "strength_duration") =>
      buildCorrelationObservationPage(
        [day],
        { metricX, metricY: "hrv", days: null, lag: 0, endDate: day.date },
        evidence,
        { pageSize: 1 },
      ).items[0]?.x.contributors;

    expect(contributors("exercise_duration")?.map((contributor) => contributor.label)).toEqual([
      "Run",
      "Lift",
      "Yoga",
    ]);
    expect(contributors("cardio_duration")?.map((contributor) => contributor.label)).toEqual([
      "Run",
    ]);
    expect(contributors("strength_duration")?.map((contributor) => contributor.label)).toEqual([
      "Lift",
    ]);

    const noRecordsPage = buildCorrelationObservationPage(
      [day],
      {
        metricX: "strength_duration",
        metricY: "hrv",
        days: null,
        lag: 0,
        endDate: day.date,
      },
      new Map([
        [
          day.date,
          {
            dailyMetricProviderIds: [],
            sleepProviderIds: [],
            nutritionProviderIds: [],
            bodyProviderIds: ["withings"],
            activities: [],
          },
        ],
      ]),
      { pageSize: 1 },
    );
    expect(noRecordsPage.items[0]?.x.contributors).toEqual([
      {
        kind: "aggregate_inputs",
        label: "Daily activity aggregate inputs",
        providerIds: [],
        target: { type: "metric_family", family: "activity" },
      },
    ]);
  });

  it("uses the inclusive 30-day provider window and returns sorted unique providers", () => {
    const day = makeJoinedDay({
      date: "2025-02-01",
      hrv: 45,
      weight_30d_avg: 72,
    });
    const evidence = (
      bodyProviderIds: string[],
    ): {
      dailyMetricProviderIds: string[];
      sleepProviderIds: string[];
      nutritionProviderIds: string[];
      bodyProviderIds: string[];
      activities: [];
    } => ({
      dailyMetricProviderIds: [],
      sleepProviderIds: [],
      nutritionProviderIds: [],
      bodyProviderIds,
      activities: [],
    });
    const page = buildCorrelationObservationPage(
      [day],
      {
        metricX: "weight_30d",
        metricY: "hrv",
        days: null,
        lag: 0,
        endDate: day.date,
      },
      new Map([
        ["2025-01-02", evidence(["outside_before"])],
        ["2025-01-03", evidence(["apple_health", "garmin", "withings"])],
        ["2025-02-01", evidence(["oura"])],
        ["2025-02-02", evidence(["outside_future"])],
      ]),
      { pageSize: 1 },
    );

    expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual([
      "apple_health",
      "garmin",
      "oura",
      "withings",
    ]);
  });

  it("does not use earlier body evidence for a same-day body metric", () => {
    const day = makeJoinedDay({
      date: "2025-02-01",
      hrv: 45,
      weight_kg: 72,
    });
    const page = buildCorrelationObservationPage(
      [day],
      {
        metricX: "weight",
        metricY: "hrv",
        days: null,
        lag: 0,
        endDate: day.date,
      },
      new Map([
        [
          "2025-01-15",
          {
            dailyMetricProviderIds: [],
            sleepProviderIds: [],
            nutritionProviderIds: [],
            bodyProviderIds: ["older-provider"],
            activities: [],
          },
        ],
        [
          day.date,
          {
            dailyMetricProviderIds: ["oura"],
            sleepProviderIds: [],
            nutritionProviderIds: [],
            bodyProviderIds: ["withings"],
            activities: [],
          },
        ],
      ]),
      { pageSize: 1 },
    );

    expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual(["withings"]);
  });

  it("excludes observations missing either side of the pair", () => {
    const page = buildCorrelationObservationPage(
      [
        makeJoinedDay({ date: "2025-01-01", hrv: null, weight_kg: 70 }),
        makeJoinedDay({ date: "2025-01-02", hrv: 45, weight_kg: null }),
      ],
      {
        metricX: "hrv",
        metricY: "weight",
        days: null,
        lag: 0,
        endDate: "2025-01-02",
      },
      new Map(),
      { pageSize: 1 },
    );

    expect(page).toEqual({ items: [], totalCount: 0, nextCursor: null });
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
    query: vi.fn(async (_schema: unknown, query: string) => {
      if (query.includes("analytics.daily_sleep")) return [];
      if (query.includes("analytics.v_body_measurement")) return [];
      if (query.includes("analytics.resting_heart_rate_sleep_window")) {
        return [{ date: "2024-01-01", resting_hr: 52 }];
      }
      return [];
    }),
  };
}

function makeCorrelationEvidenceSources() {
  const db = {
    execute: vi
      .fn()
      .mockResolvedValueOnce([
        {
          date: "2026-01-02",
          resting_hr: 52,
          hrv: 45,
          spo2_avg: 98,
          steps: 10_000,
          skin_temp_c: 36.5,
          source_providers: ["oura", "garmin", "oura"],
        },
      ])
      .mockResolvedValueOnce([
        {
          date: "2026-01-02",
          calories: 2_000,
          protein_g: 150,
          carbs_g: 200,
          fat_g: 70,
          fiber_g: 30,
          water_ml: 2_500,
          contributing_providers: ["cronometer", "apple_health", "cronometer"],
        },
      ]),
  };
  const sleepRow = {
    date: "2026-01-02",
    source_name: "Sleep session",
    timezone: "UTC",
    start_utc_offset_minutes: 0,
    end_utc_offset_minutes: 0,
    local_time_source: "provider_timezone",
    started_at: "2026-01-01T22:00:00Z",
    ended_at: "2026-01-02T06:00:00Z",
    duration_minutes: 480,
    deep_minutes: 100,
    rem_minutes: 100,
    light_minutes: 260,
    awake_minutes: 20,
    efficiency_pct: 92,
    staging_available: true,
  };
  const sensorStore = {
    query: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...sleepRow,
          started_at: "2026-01-02T12:00:00Z",
          ended_at: null,
          duration_minutes: 1,
          provider_id: "zero-duration-provider",
          source_providers: ["zero-duration-source"],
        },
        {
          ...sleepRow,
          provider_id: null,
          source_providers: ["sleep-source"],
        },
        {
          ...sleepRow,
          provider_id: "equal-duration-provider",
          source_providers: ["equal-duration-provider"],
        },
      ])
      .mockResolvedValueOnce([
        {
          activity_id: "run-1",
          date: undefined,
          started_at: "2026-01-02T08:00:00Z",
          ended_at: "2026-01-02T08:30:00Z",
          canonical_type: "running",
          name: null,
        },
        {
          activity_id: "lift-1",
          date: "2026-01-02",
          started_at: "2026-01-02T09:00:00Z",
          ended_at: "2026-01-02T09:45:00Z",
          canonical_type: "strength",
          name: "Lift",
        },
        {
          activity_id: "unfinished-1",
          date: "2026-01-02",
          started_at: "2026-01-02T10:00:00Z",
          ended_at: null,
          canonical_type: "cycling",
          name: "Unfinished",
        },
      ])
      .mockResolvedValueOnce([
        {
          date: "2026-01-02",
          recorded_at: "2026-01-02T07:00:00Z",
          provider_id: "withings",
          source_providers: ["apple_health", "withings"],
          weight_kg: 72,
          body_fat_pct: 15,
        },
      ]),
  };
  return { db, sensorStore };
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
        expect(metric).toHaveProperty("availabilityDescription");
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

    it("requires the ClickHouse analytics store", async () => {
      const repo = new CorrelationRepository(makeDb(), "user-1");

      await expect(repo.compute("resting_hr", "hrv", 90, 0, "2024-06-01")).rejects.toThrow(
        "ClickHouse activity analytics store is required for correlations",
      );
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

  describe("listObservations", () => {
    it("strips provenance before joining and merges sorted daily and nutrition evidence", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce([
        makeJoinedDay({
          date: "2026-01-02",
          hrv: 45,
          protein_g: 150,
        }),
      ]);
      const { db, sensorStore } = makeCorrelationEvidenceSources();
      const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

      const page = await repository.listObservations("hrv", "protein", 30, 0, "2026-01-02", {
        pageSize: 25,
      });

      expect(joinByDate).toHaveBeenLastCalledWith(
        [
          {
            date: "2026-01-02",
            resting_hr: 52,
            hrv: 45,
            spo2_avg: 98,
            steps: 10_000,
            skin_temp_c: 36.5,
          },
        ],
        [
          {
            started_at: "2026-01-02T12:00:00.000Z",
            duration_minutes: 1,
            deep_minutes: 100,
            rem_minutes: 100,
            light_minutes: 260,
            awake_minutes: 20,
            efficiency_pct: 92,
            is_nap: false,
          },
          {
            started_at: "2026-01-01T22:00:00.000Z",
            duration_minutes: 480,
            deep_minutes: 100,
            rem_minutes: 100,
            light_minutes: 260,
            awake_minutes: 20,
            efficiency_pct: 92,
            is_nap: false,
          },
          {
            started_at: "2026-01-01T22:00:00.000Z",
            duration_minutes: 480,
            deep_minutes: 100,
            rem_minutes: 100,
            light_minutes: 260,
            awake_minutes: 20,
            efficiency_pct: 92,
            is_nap: false,
          },
        ],
        expect.any(Array),
        [
          {
            date: "2026-01-02",
            calories: 2_000,
            protein_g: 150,
            carbs_g: 200,
            fat_g: 70,
            fiber_g: 30,
            water_ml: 2_500,
          },
        ],
        [
          {
            date: "2026-01-02",
            recorded_at: "2026-01-02T07:00:00.000Z",
            weight_kg: 72,
            body_fat_pct: 15,
          },
        ],
        { minDailyCalories: 1200 },
      );
      expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual(["garmin", "oura"]);
      expect(page.items[0]?.y.contributors[0]?.providerIds).toEqual(["apple_health", "cronometer"]);
    });

    it("selects the longest sleep evidence and merges body provenance", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce([
        makeJoinedDay({
          date: "2026-01-02",
          sleep_duration_min: 480,
          weight_kg: 72,
        }),
      ]);
      const { db, sensorStore } = makeCorrelationEvidenceSources();
      const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

      const page = await repository.listObservations(
        "sleep_duration",
        "weight",
        30,
        0,
        "2026-01-02",
        { pageSize: 25 },
      );

      expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual(["sleep-source"]);
      expect(page.items[0]?.y.contributors[0]?.providerIds).toEqual(["apple_health", "withings"]);
    });

    it("uses exact completed activity records with date and label fallbacks", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce([
        makeJoinedDay({
          date: "2026-01-02",
          exercise_minutes: 75,
          cardio_minutes: 30,
        }),
      ]);
      const { db, sensorStore } = makeCorrelationEvidenceSources();
      const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

      const page = await repository.listObservations(
        "exercise_duration",
        "cardio_duration",
        30,
        0,
        "2026-01-02",
        { pageSize: 25 },
      );

      expect(page.items[0]?.x.contributors).toEqual([
        {
          kind: "record",
          label: "running",
          providerIds: [],
          target: { type: "activity", activityId: "run-1" },
        },
        {
          kind: "record",
          label: "Lift",
          providerIds: [],
          target: { type: "activity", activityId: "lift-1" },
        },
      ]);
      expect(page.items[0]?.y.contributors).toEqual([
        {
          kind: "record",
          label: "running",
          providerIds: [],
          target: { type: "activity", activityId: "run-1" },
        },
      ]);
    });

    it("uses a provider-only sleep source when duration is absent", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce([
        makeJoinedDay({
          date: "2026-01-02",
          sleep_duration_min: 0,
          hrv: 45,
        }),
      ]);
      const db = {
        execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      };
      const sensorStore = {
        query: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              date: "2026-01-02",
              provider_id: "provider-only",
              source_name: null,
              source_providers: [],
              timezone: "UTC",
              start_utc_offset_minutes: 0,
              end_utc_offset_minutes: 0,
              local_time_source: "provider_timezone",
              started_at: "2026-01-02T00:00:00Z",
              ended_at: null,
              duration_minutes: null,
              deep_minutes: null,
              rem_minutes: null,
              light_minutes: null,
              awake_minutes: null,
              efficiency_pct: null,
              staging_available: false,
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
      };
      const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

      const page = await repository.listObservations("sleep_duration", "hrv", 30, 0, "2026-01-02", {
        pageSize: 25,
      });

      expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual(["provider-only"]);
    });

    it("keeps absent evidence families empty after another source creates the day", async () => {
      const makeSparseRepository = (source: "daily" | "nutrition") => {
        const dailyRows =
          source === "daily"
            ? [
                {
                  date: "2026-01-02",
                  resting_hr: 52,
                  hrv: null,
                  spo2_avg: null,
                  steps: null,
                  skin_temp_c: null,
                  source_providers: ["oura"],
                },
              ]
            : [];
        const nutritionRows =
          source === "nutrition"
            ? [
                {
                  date: "2026-01-02",
                  calories: 2_000,
                  protein_g: null,
                  carbs_g: null,
                  fat_g: null,
                  fiber_g: null,
                  water_ml: null,
                  contributing_providers: ["cronometer"],
                },
              ]
            : [];
        const db = {
          execute: vi.fn().mockResolvedValueOnce(dailyRows).mockResolvedValueOnce(nutritionRows),
        };
        const sensorStore = {
          query: vi.fn().mockResolvedValue([]),
        };
        return new CorrelationRepository(db, "user-1", "UTC", sensorStore);
      };
      const cases = [
        {
          source: "daily",
          metricX: "sleep_duration",
          metricY: "protein",
          day: makeJoinedDay({
            date: "2026-01-02",
            sleep_duration_min: 480,
            protein_g: 150,
          }),
        },
        {
          source: "daily",
          metricX: "weight",
          metricY: "exercise_duration",
          day: makeJoinedDay({
            date: "2026-01-02",
            weight_kg: 72,
            exercise_minutes: 30,
          }),
        },
        {
          source: "nutrition",
          metricX: "hrv",
          metricY: "weight",
          day: makeJoinedDay({
            date: "2026-01-02",
            hrv: 45,
            weight_kg: 72,
          }),
        },
      ] as const;

      for (const testCase of cases) {
        vi.mocked(joinByDate).mockReturnValueOnce([testCase.day]);
        const page = await makeSparseRepository(testCase.source).listObservations(
          testCase.metricX,
          testCase.metricY,
          30,
          0,
          "2026-01-02",
          { pageSize: 25 },
        );

        expect(page.items[0]?.x.contributors[0]?.providerIds).toEqual([]);
        expect(page.items[0]?.y.contributors[0]?.providerIds).toEqual([]);
      }
    });

    it("attributes sleep metrics to the selected longest session for a wake date", async () => {
      vi.mocked(joinByDate).mockReturnValueOnce([
        makeJoinedDay({
          date: "2026-01-02",
          sleep_duration_min: 480,
          sleep_efficiency: 92,
        }),
      ]);
      const db = {
        execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      };
      const sensorStore = {
        query: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              date: "2026-01-02",
              provider_id: "long-session-provider",
              source_name: "Long session",
              source_providers: [],
              timezone: "UTC",
              start_utc_offset_minutes: 0,
              end_utc_offset_minutes: 0,
              local_time_source: "provider_timezone",
              started_at: "2026-01-01T22:00:00Z",
              ended_at: "2026-01-02T06:00:00Z",
              duration_minutes: 480,
              deep_minutes: 100,
              rem_minutes: 100,
              light_minutes: 260,
              awake_minutes: 20,
              efficiency_pct: 92,
              staging_available: true,
            },
            {
              date: "2026-01-02",
              provider_id: "short-session-provider",
              source_name: "Short session",
              source_providers: ["short-session-provider"],
              timezone: "UTC",
              start_utc_offset_minutes: 0,
              end_utc_offset_minutes: 0,
              local_time_source: "provider_timezone",
              started_at: "2026-01-01T23:00:00Z",
              ended_at: "2026-01-02T01:00:00Z",
              duration_minutes: 120,
              deep_minutes: 20,
              rem_minutes: 20,
              light_minutes: 70,
              awake_minutes: 10,
              efficiency_pct: 90,
              staging_available: true,
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
      };
      const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

      const page = await repository.listObservations(
        "sleep_duration",
        "sleep_efficiency",
        30,
        0,
        "2026-01-02",
        { pageSize: 25 },
      );

      expect(page.items[0]?.x.contributors[0]).toMatchObject({
        providerIds: ["long-session-provider"],
      });
      expect(page.items[0]?.y.contributors[0]).toMatchObject({
        providerIds: ["long-session-provider"],
      });
    });
  });
});
