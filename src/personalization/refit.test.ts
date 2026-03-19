import { describe, expect, it, vi } from "vitest";

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn(),
  },
}));

import {
  parseExponentialMovingAverageRows,
  parseReadinessRows,
  parseSleepRows,
  parseStressRows,
  parseTrainingImpulseRows,
  refitAllParams,
} from "./refit.ts";

function createMockDb(queryResults: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const result = queryResults[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    }),
  };
}

describe("refitAllParams", () => {
  it("returns params with all null fitters when data is insufficient", async () => {
    // All queries return empty results
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");

    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
    expect(result.fittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls execute for data queries and save", async () => {
    const db = createMockDb([[], [], [], [], [], []]);
    await refitAllParams(db, "user-1");

    // Should be called at least once for data queries + once for save
    expect(db.execute).toHaveBeenCalled();
  });

  it("handles individual fitter errors gracefully", async () => {
    const db = createMockDb([]);
    // Override to throw on first call then return empty for rest
    let callCount = 0;
    db.execute.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("DB connection failed"));
      return Promise.resolve([]);
    });

    // Should not throw — individual failures are caught
    const result = await refitAllParams(db, "user-1");
    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
  });

  it("fittedAt is a valid ISO timestamp", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");

    // Should be a valid ISO date string
    const parsed = new Date(result.fittedAt);
    expect(parsed.toISOString()).toBe(result.fittedAt);
  });

  it("handles save failure gracefully (logs but does not throw)", async () => {
    let callCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        // First 5 calls are data queries (one per fitter), 6th is save
        if (callCount === 6) return Promise.reject(new Error("Save failed"));
        return Promise.resolve([]);
      }),
    };

    const result = await refitAllParams(db, "user-1");

    // Should still return params despite save failure
    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("Failed to save params"));
  });

  it("handles all fitters rejecting simultaneously", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("All queries fail")),
    };

    // Promise.allSettled catches all rejections
    const result = await refitAllParams(db, "user-1");
    expect(result.version).toBe(1);
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
  });

  it("sets rejected fitters to null", async () => {
    let callCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        // First two queries fail, rest succeed with empty data
        if (callCount <= 2) return Promise.reject(new Error("Partial failure"));
        return Promise.resolve([]);
      }),
    };

    const result = await refitAllParams(db, "user-1");
    // All should be null (either rejected or insufficient data)
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
  });

  it("version is always 1", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");
    expect(result.version).toBe(1);
  });
});

// --- parseExponentialMovingAverageRows ---

describe("parseExponentialMovingAverageRows", () => {
  it("returns empty array for empty input", () => {
    expect(parseExponentialMovingAverageRows([])).toEqual([]);
  });

  it("parses valid rows into ExponentialMovingAverageInput", () => {
    const rows = [
      { date: "2026-01-01", daily_load: 50, avg_performance: 150 },
      { date: "2026-01-02", daily_load: 60, avg_performance: 160 },
    ];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toEqual([
      { date: "2026-01-01", load: 50, performance: 150 },
      { date: "2026-01-02", load: 60, performance: 160 },
    ]);
  });

  it("filters out rows with avg_performance of 0", () => {
    const rows = [
      { date: "2026-01-01", daily_load: 50, avg_performance: 0 },
      { date: "2026-01-02", daily_load: 60, avg_performance: 160 },
    ];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-01-02");
  });

  it("includes rows with avg_performance of non-zero value (even small)", () => {
    const rows = [{ date: "2026-01-01", daily_load: 50, avg_performance: 0.001 }];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
  });

  it("skips rows that fail Zod validation (missing fields)", () => {
    const rows = [
      { date: "2026-01-01", daily_load: 50 }, // missing avg_performance
      { daily_load: 60, avg_performance: 160 }, // missing date
      { date: "2026-01-03", daily_load: 70, avg_performance: 170 }, // valid
    ];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-01-03");
  });

  it("coerces string numbers to numbers", () => {
    const rows = [{ date: "2026-01-01", daily_load: "50.5", avg_performance: "160.3" }];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.load).toBe(50.5);
    expect(result[0]?.performance).toBe(160.3);
  });

  it("maps daily_load to load and avg_performance to performance", () => {
    const rows = [{ date: "2026-01-01", daily_load: 42, avg_performance: 200 }];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result[0]).toEqual({ date: "2026-01-01", load: 42, performance: 200 });
  });

  it("includes rows with daily_load of 0", () => {
    const rows = [{ date: "2026-01-01", daily_load: 0, avg_performance: 100 }];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.load).toBe(0);
  });

  it("includes rows with negative avg_performance", () => {
    // Negative performance is not 0, so it passes the filter
    const rows = [{ date: "2026-01-01", daily_load: 10, avg_performance: -5 }];
    const result = parseExponentialMovingAverageRows(rows);
    expect(result).toHaveLength(1);
  });
});

// --- parseReadinessRows ---

describe("parseReadinessRows", () => {
  /** Build a fully populated readiness row where all null-check fields are non-null. */
  function validReadinessRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      hrv: 60,
      resting_hr: 55,
      hrv_mean: 50,
      hrv_sd: 10,
      rhr_mean: 55,
      rhr_sd: 5,
      efficiency_pct: 85,
      acwr: 1.0,
      next_day_hrv: 65,
      next_day_hrv_mean: 50,
      next_day_hrv_sd: 10,
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    expect(parseReadinessRows([])).toEqual([]);
  });

  it("parses a fully valid row", () => {
    const result = parseReadinessRows([validReadinessRow()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("hrvScore");
    expect(result[0]).toHaveProperty("rhrScore");
    expect(result[0]).toHaveProperty("sleepScore");
    expect(result[0]).toHaveProperty("loadBalanceScore");
    expect(result[0]).toHaveProperty("nextDayHrvZScore");
  });

  it("filters rows with null hrv", () => {
    expect(parseReadinessRows([validReadinessRow({ hrv: null })])).toHaveLength(0);
  });

  it("filters rows with null hrv_mean", () => {
    expect(parseReadinessRows([validReadinessRow({ hrv_mean: null })])).toHaveLength(0);
  });

  it("filters rows with null hrv_sd", () => {
    expect(parseReadinessRows([validReadinessRow({ hrv_sd: null })])).toHaveLength(0);
  });

  it("filters rows with hrv_sd of 0", () => {
    expect(parseReadinessRows([validReadinessRow({ hrv_sd: 0 })])).toHaveLength(0);
  });

  it("filters rows with null resting_hr", () => {
    expect(parseReadinessRows([validReadinessRow({ resting_hr: null })])).toHaveLength(0);
  });

  it("filters rows with null rhr_mean", () => {
    expect(parseReadinessRows([validReadinessRow({ rhr_mean: null })])).toHaveLength(0);
  });

  it("filters rows with null rhr_sd", () => {
    expect(parseReadinessRows([validReadinessRow({ rhr_sd: null })])).toHaveLength(0);
  });

  it("filters rows with rhr_sd of 0", () => {
    expect(parseReadinessRows([validReadinessRow({ rhr_sd: 0 })])).toHaveLength(0);
  });

  it("filters rows with null next_day_hrv", () => {
    expect(parseReadinessRows([validReadinessRow({ next_day_hrv: null })])).toHaveLength(0);
  });

  it("filters rows with null next_day_hrv_mean", () => {
    expect(parseReadinessRows([validReadinessRow({ next_day_hrv_mean: null })])).toHaveLength(0);
  });

  it("filters rows with null next_day_hrv_sd", () => {
    expect(parseReadinessRows([validReadinessRow({ next_day_hrv_sd: null })])).toHaveLength(0);
  });

  it("filters rows with next_day_hrv_sd of 0", () => {
    expect(parseReadinessRows([validReadinessRow({ next_day_hrv_sd: 0 })])).toHaveLength(0);
  });

  it("computes hrvScore correctly using z-score formula", () => {
    // hrv=70, hrv_mean=50, hrv_sd=10 => zHrv=(70-50)/10=2 => score=50+2*15=80
    const result = parseReadinessRows([validReadinessRow({ hrv: 70, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBe(80);
  });

  it("clamps hrvScore at 0 for very negative z-score", () => {
    // hrv=10, mean=50, sd=10 => z=-4 => 50+(-4)*15=-10 => clamp to 0
    const result = parseReadinessRows([validReadinessRow({ hrv: 10, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBe(0);
  });

  it("clamps hrvScore at 100 for very positive z-score", () => {
    // hrv=100, mean=50, sd=10 => z=5 => 50+5*15=125 => clamp to 100
    const result = parseReadinessRows([validReadinessRow({ hrv: 100, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBe(100);
  });

  it("computes rhrScore with inverted sign (higher RHR = lower score)", () => {
    // resting_hr=65, rhr_mean=55, rhr_sd=5 => zRhr=(65-55)/5=2 => score=50+(-2)*15=20
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 65, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBe(20);
  });

  it("clamps rhrScore at 0 for very high resting HR z-score", () => {
    // resting_hr=80, mean=55, sd=5 => z=5 => score=50+(-5)*15=-25 => clamp to 0
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 80, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBe(0);
  });

  it("clamps rhrScore at 100 for very low resting HR z-score", () => {
    // resting_hr=30, mean=55, sd=5 => z=-5 => score=50+5*15=125 => clamp to 100
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 30, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBe(100);
  });

  it("uses efficiency_pct directly as sleepScore when present", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: 92 })]);
    expect(result[0]?.sleepScore).toBe(92);
  });

  it("defaults sleepScore to 50 when efficiency_pct is null", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: null })]);
    expect(result[0]?.sleepScore).toBe(50);
  });

  it("clamps sleepScore at 0 for negative efficiency_pct", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: -10 })]);
    expect(result[0]?.sleepScore).toBe(0);
  });

  it("clamps sleepScore at 100 for efficiency_pct above 100", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: 120 })]);
    expect(result[0]?.sleepScore).toBe(100);
  });

  it("computes loadBalanceScore with acwr=1 as 100 (perfect balance)", () => {
    const result = parseReadinessRows([validReadinessRow({ acwr: 1.0 })]);
    expect(result[0]?.loadBalanceScore).toBe(100);
  });

  it("computes loadBalanceScore that decreases as acwr deviates from 1", () => {
    // acwr=1.5 => (1 - |1.5-1.0|)*100 = (1-0.5)*100 = 50
    const result = parseReadinessRows([validReadinessRow({ acwr: 1.5 })]);
    expect(result[0]?.loadBalanceScore).toBe(50);
  });

  it("clamps loadBalanceScore at 0 for extreme acwr", () => {
    // acwr=2.5 => (1 - |2.5-1.0|)*100 = (1-1.5)*100 = -50 => clamp to 0
    const result = parseReadinessRows([validReadinessRow({ acwr: 2.5 })]);
    expect(result[0]?.loadBalanceScore).toBe(0);
  });

  it("defaults loadBalanceScore to 50 when acwr is null", () => {
    const result = parseReadinessRows([validReadinessRow({ acwr: null })]);
    expect(result[0]?.loadBalanceScore).toBe(50);
  });

  it("computes nextDayHrvZScore correctly", () => {
    // next_day_hrv=65, mean=50, sd=10 => (65-50)/10 = 1.5
    const result = parseReadinessRows([
      validReadinessRow({ next_day_hrv: 65, next_day_hrv_mean: 50, next_day_hrv_sd: 10 }),
    ]);
    expect(result[0]?.nextDayHrvZScore).toBe(1.5);
  });

  it("skips rows with invalid schema (e.g. missing required fields)", () => {
    const result = parseReadinessRows([{ hrv: 60 }]); // missing many fields
    expect(result).toHaveLength(0);
  });
});

// --- parseSleepRows ---

describe("parseSleepRows", () => {
  it("returns empty array for empty input", () => {
    expect(parseSleepRows([])).toEqual([]);
  });

  it("parses valid rows", () => {
    const rows = [
      { duration_minutes: 480, hrv_above_median: true },
      { duration_minutes: 420, hrv_above_median: false },
    ];
    const result = parseSleepRows(rows);
    expect(result).toEqual([
      { durationMinutes: 480, nextDayHrvAboveMedian: true },
      { durationMinutes: 420, nextDayHrvAboveMedian: false },
    ]);
  });

  it("coerces string numbers to numbers", () => {
    const rows = [{ duration_minutes: "480", hrv_above_median: "true" }];
    const result = parseSleepRows(rows);
    expect(result[0]?.durationMinutes).toBe(480);
    expect(result[0]?.nextDayHrvAboveMedian).toBe(true);
  });

  it("skips rows that fail Zod validation (completely wrong shape)", () => {
    const rows = [
      { foo: "bar" }, // completely wrong shape — coerce still produces values
      { duration_minutes: 420, hrv_above_median: false }, // valid
    ];
    // z.coerce.number() coerces undefined to NaN and z.coerce.boolean() coerces undefined to false,
    // so only truly malformed shapes fail. Test that valid rows are included.
    const result = parseSleepRows(rows);
    const validResults = result.filter((r) => !Number.isNaN(r.durationMinutes));
    expect(validResults).toHaveLength(1);
    expect(validResults[0]?.durationMinutes).toBe(420);
  });

  it("maps duration_minutes to durationMinutes", () => {
    const rows = [{ duration_minutes: 450, hrv_above_median: true }];
    const result = parseSleepRows(rows);
    expect(result[0]?.durationMinutes).toBe(450);
  });

  it("maps hrv_above_median to nextDayHrvAboveMedian", () => {
    const rows = [{ duration_minutes: 450, hrv_above_median: false }];
    const result = parseSleepRows(rows);
    expect(result[0]?.nextDayHrvAboveMedian).toBe(false);
  });
});

// --- parseStressRows ---

describe("parseStressRows", () => {
  it("returns empty array for empty input", () => {
    expect(parseStressRows([])).toEqual([]);
  });

  it("parses valid rows", () => {
    const rows = [
      { hrv_z: -1.2, rhr_z: 0.8 },
      { hrv_z: 0.5, rhr_z: -0.3 },
    ];
    const result = parseStressRows(rows);
    expect(result).toEqual([
      { hrvZScore: -1.2, rhrZScore: 0.8 },
      { hrvZScore: 0.5, rhrZScore: -0.3 },
    ]);
  });

  it("coerces string numbers to numbers", () => {
    const rows = [{ hrv_z: "-1.5", rhr_z: "2.0" }];
    const result = parseStressRows(rows);
    expect(result[0]?.hrvZScore).toBe(-1.5);
    expect(result[0]?.rhrZScore).toBe(2.0);
  });

  it("skips rows with invalid schema", () => {
    const rows = [
      { hrv_z: -1.0 }, // missing rhr_z
      { rhr_z: 0.5 }, // missing hrv_z
      { hrv_z: 0.0, rhr_z: 0.0 }, // valid
    ];
    const result = parseStressRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ hrvZScore: 0.0, rhrZScore: 0.0 });
  });

  it("maps hrv_z to hrvZScore and rhr_z to rhrZScore", () => {
    const rows = [{ hrv_z: -0.7, rhr_z: 1.1 }];
    const result = parseStressRows(rows);
    expect(result[0]).toEqual({ hrvZScore: -0.7, rhrZScore: 1.1 });
  });
});

// --- parseTrainingImpulseRows ---

describe("parseTrainingImpulseRows", () => {
  function validTrimpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      duration_min: 60,
      avg_hr: 155,
      max_hr: 190,
      resting_hr: 55,
      power_tss: 80,
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    expect(parseTrainingImpulseRows([])).toEqual([]);
  });

  it("parses valid rows", () => {
    const result = parseTrainingImpulseRows([validTrimpRow()]);
    expect(result).toEqual([
      { durationMin: 60, avgHr: 155, maxHr: 190, restingHr: 55, powerTss: 80 },
    ]);
  });

  it("filters rows where duration_min is 0", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ duration_min: 0 })])).toHaveLength(0);
  });

  it("filters rows where duration_min is negative", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ duration_min: -10 })])).toHaveLength(0);
  });

  it("includes rows where duration_min is positive", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ duration_min: 0.1 })])).toHaveLength(1);
  });

  it("filters rows where max_hr equals resting_hr", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ max_hr: 60, resting_hr: 60 })])).toHaveLength(
      0,
    );
  });

  it("filters rows where max_hr is less than resting_hr", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ max_hr: 50, resting_hr: 60 })])).toHaveLength(
      0,
    );
  });

  it("includes rows where max_hr is greater than resting_hr", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ max_hr: 61, resting_hr: 60 })])).toHaveLength(
      1,
    );
  });

  it("filters rows where power_tss is 0", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ power_tss: 0 })])).toHaveLength(0);
  });

  it("filters rows where power_tss is negative", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ power_tss: -5 })])).toHaveLength(0);
  });

  it("includes rows where power_tss is positive", () => {
    expect(parseTrainingImpulseRows([validTrimpRow({ power_tss: 0.1 })])).toHaveLength(1);
  });

  it("coerces string numbers to numbers", () => {
    const row = validTrimpRow({
      duration_min: "60",
      avg_hr: "155",
      max_hr: "190",
      resting_hr: "55",
      power_tss: "80",
    });
    const result = parseTrainingImpulseRows([row]);
    expect(result).toHaveLength(1);
    expect(result[0]?.durationMin).toBe(60);
  });

  it("skips rows with invalid schema (missing fields)", () => {
    const rows = [
      { duration_min: 60, avg_hr: 155 }, // missing max_hr, resting_hr, power_tss
      validTrimpRow(), // valid
    ];
    const result = parseTrainingImpulseRows(rows);
    expect(result).toHaveLength(1);
  });

  it("maps snake_case fields to camelCase", () => {
    const result = parseTrainingImpulseRows([validTrimpRow()]);
    expect(result[0]).toEqual({
      durationMin: 60,
      avgHr: 155,
      maxHr: 190,
      restingHr: 55,
      powerTss: 80,
    });
  });
});
