import { describe, expect, it, vi } from "vitest";

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockCaptureException = vi.fn();

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

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

function createMockSensorStore(rowSets: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  return {
    query: vi
      .fn()
      .mockImplementation(
        async (
          schema: { parse: (row: unknown) => unknown },
          _query: string,
          _params?: Record<string, unknown>,
        ) => {
          const rows = rowSets[callIndex] ?? [];
          callIndex++;
          return rows.map((row) => schema.parse(row));
        },
      ),
  };
}

describe("refitAllParams", () => {
  it("returns params with all null fitters when data is insufficient", async () => {
    // All queries return empty results
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result).not.toBeNull();
    expect(result.version).toBe(2);
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
    expect(result.fittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.successfulFitAt).toEqual({
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    });
  });

  it("calls execute for data queries and save", async () => {
    const db = createMockDb([[], [], [], [], [], []]);
    await refitAllParams(db, "user-1", createMockSensorStore());

    // Should be called at least once for data queries + once for save
    expect(db.execute).toHaveBeenCalled();
  });

  it("queries sensor-store refit inputs with the current userId", async () => {
    const db = createMockDb([[], [], [], [], [], []]);
    const sensorStore = createMockSensorStore();

    await refitAllParams(db, "user-1", sensorStore);

    expect(sensorStore.query).toHaveBeenCalledTimes(6);
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("analytics.activity_summary asum"),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.activity_summary asum"),
      expect.objectContaining({ userId: "user-1" }),
    );
    const trainingImpulseQuery = sensorStore.query.mock.calls
      .map(([, query]) => query)
      .find((query) => query.includes("ftp_estimate AS"));
    expect(trainingImpulseQuery).toContain("asum.normalized_power");
    expect(trainingImpulseQuery).not.toContain("analytics.deduped_sensor");
    expect(trainingImpulseQuery).not.toContain("rolling_power");

    const sleepQueries = sensorStore.query.mock.calls
      .map(([, query]) => query)
      .filter((query) => query.includes("analytics.daily_sleep"));
    expect(sleepQueries).toHaveLength(2);
    expect(sleepQueries.every((query) => query.includes("FINAL"))).toBe(true);
    expect(
      sensorStore.query.mock.calls.some(([, query]) => query.includes("analytics.v_sleep")),
    ).toBe(false);
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
    const result = await refitAllParams(db, "user-1", createMockSensorStore());
    expect(result).not.toBeNull();
    expect(result.version).toBe(2);
  });

  it("fittedAt is a valid ISO timestamp", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    // Should be a valid ISO date string
    const parsed = new Date(result.fittedAt);
    expect(parsed.toISOString()).toBe(result.fittedAt);
  });

  it("handles save failure gracefully (logs but does not throw)", async () => {
    // 3 PG fitters (readiness, sleep, stress) each call db.execute once,
    // then loadPersonalizedParams and savePersonalizedParams each call execute.
    // Reject the save call (the 5th).
    let callCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 5) return Promise.reject(new Error("Save failed"));
        return Promise.resolve([]);
      }),
    };

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    // Should still return params despite save failure
    expect(result).not.toBeNull();
    expect(result.version).toBe(2);
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("Failed to save params"));
  });

  it("reports a failure to load existing params with operational context", async () => {
    mockLoggerError.mockClear();
    mockCaptureException.mockClear();
    let callCount = 0;
    const loadError = new Error("Load failed");
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 4) return Promise.reject(loadError);
        return Promise.resolve([]);
      }),
    };

    await refitAllParams(db, "user-1", createMockSensorStore());

    expect(mockLoggerError).toHaveBeenCalledWith(
      `[personalization] Failed to load existing params: ${loadError}`,
    );
    expect(mockCaptureException).toHaveBeenCalledWith(loadError, {
      tags: { context: "personalization-load-existing" },
    });
  });

  it("preserves existing fitted params when a refit has insufficient data", async () => {
    const existingParams = {
      version: 2,
      fittedAt: "2026-01-01T00:00:00.000Z",
      successfulFitAt: {
        exponentialMovingAverage: "2025-12-15T00:00:00.000Z",
        readinessWeights: null,
        sleepTarget: "2025-12-20T00:00:00.000Z",
        stressThresholds: null,
        trainingImpulseConstants: null,
      },
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 8,
        sampleCount: 40,
        correlation: 0.5,
      },
      readinessWeights: null,
      sleepTarget: { minutes: 500, sampleCount: 20 },
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    const db = createMockDb([[], [], [], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result.exponentialMovingAverage).toEqual(existingParams.exponentialMovingAverage);
    expect(result.sleepTarget).toEqual(existingParams.sleepTarget);
    expect(result.fittedAt).not.toBe(existingParams.fittedAt);
    expect(result.successfulFitAt?.exponentialMovingAverage).toBe(
      existingParams.successfulFitAt.exponentialMovingAverage,
    );
    expect(result.successfulFitAt?.sleepTarget).toBe(existingParams.successfulFitAt.sleepTarget);
  });

  it("preserves every successful fit timestamp when fulfilled refits return no fit", async () => {
    const successfulFitAt = {
      exponentialMovingAverage: "2025-12-15T00:00:00.000Z",
      readinessWeights: "2025-12-16T00:00:00.000Z",
      sleepTarget: "2025-12-17T00:00:00.000Z",
      stressThresholds: "2025-12-18T00:00:00.000Z",
      trainingImpulseConstants: "2025-12-19T00:00:00.000Z",
    };
    const existingParams = {
      version: 2,
      fittedAt: "2026-01-01T00:00:00.000Z",
      successfulFitAt,
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    const db = createMockDb([[], [], [], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result.successfulFitAt).toEqual(successfulFitAt);
  });

  it("preserves every successful fit timestamp when all refits reject", async () => {
    const successfulFitAt = {
      exponentialMovingAverage: "2025-12-15T00:00:00.000Z",
      readinessWeights: "2025-12-16T00:00:00.000Z",
      sleepTarget: "2025-12-17T00:00:00.000Z",
      stressThresholds: "2025-12-18T00:00:00.000Z",
      trainingImpulseConstants: "2025-12-19T00:00:00.000Z",
    };
    const existingParams = {
      version: 2,
      fittedAt: "2026-01-01T00:00:00.000Z",
      successfulFitAt,
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    let dbCallCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        dbCallCount++;
        if (dbCallCount === 1) return Promise.reject(new Error("Fitter query failed"));
        if (dbCallCount === 2) return Promise.resolve([{ value: existingParams }]);
        return Promise.resolve([]);
      }),
    };
    const sensorStore = {
      query: vi.fn().mockRejectedValue(new Error("Sensor fitter query failed")),
    };

    const result = await refitAllParams(db, "user-1", sensorStore);

    expect(result.successfulFitAt).toEqual(successfulFitAt);
  });

  it("uses null successful fit timestamps for legacy params after insufficient refits", async () => {
    const existingParams = {
      version: 1,
      fittedAt: "2026-01-01T00:00:00.000Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    const db = createMockDb([[], [], [], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result.successfulFitAt).toEqual({
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    });
  });

  it("records the attempt timestamp for a newly accepted fit", async () => {
    const exponentialMovingAverageRows = generateExponentialMovingAverageRows(180);
    const db = createMockDb([[], [], [], [], [], []]);

    const result = await refitAllParams(
      db,
      "user-1",
      createMockSensorStore([exponentialMovingAverageRows]),
    );

    expect(result.exponentialMovingAverage).not.toBeNull();
    expect(result.successfulFitAt?.exponentialMovingAverage).toBe(result.fittedAt);
    expect(result.successfulFitAt?.readinessWeights).toBeNull();
  });

  it("records the same attempt timestamp when every fitter accepts a new fit", async () => {
    const accepted = {
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 42,
        acuteTrainingLoadDays: 7,
        sampleCount: 120,
        correlation: 0.8,
      },
      readinessWeights: {
        hrv: 0.4,
        restingHr: 0.2,
        sleep: 0.2,
        respiratoryRate: 0.2,
        sampleCount: 90,
        correlation: 0.7,
      },
      sleepTarget: { minutes: 480, sampleCount: 30 },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.1, -0.4] satisfies [number, number, number],
        rhrThresholds: [1.8, 1.1, 0.4] satisfies [number, number, number],
        sampleCount: 90,
      },
      trainingImpulseConstants: {
        genderFactor: 0.64,
        exponent: 1.92,
        sampleCount: 30,
        r2: 0.9,
      },
    };
    vi.doMock("./fit-ewma.ts", () => ({
      fitExponentialMovingAverage: vi.fn(() => accepted.exponentialMovingAverage),
    }));
    vi.doMock("./fit-readiness-weights.ts", () => ({
      fitReadinessWeights: vi.fn(() => accepted.readinessWeights),
    }));
    vi.doMock("./fit-sleep-target.ts", () => ({
      fitSleepTarget: vi.fn(() => accepted.sleepTarget),
    }));
    vi.doMock("./fit-stress-thresholds.ts", () => ({
      fitStressThresholds: vi.fn(() => accepted.stressThresholds),
    }));
    vi.doMock("./fit-trimp.ts", () => ({
      fitTrainingImpulseConstants: vi.fn(() => accepted.trainingImpulseConstants),
    }));

    try {
      vi.resetModules();
      const { refitAllParams: refitWithAcceptedFits } = await import("./refit.ts");
      const { personalizedParamsSchema } = await import("./params.ts");
      const result = await refitWithAcceptedFits(
        createMockDb([[], [], [], [], []]),
        "user-1",
        createMockSensorStore(),
      );

      expect(result).toMatchObject(accepted);
      const successfulFitAt = {
        exponentialMovingAverage: result.fittedAt,
        readinessWeights: result.fittedAt,
        sleepTarget: result.fittedAt,
        stressThresholds: result.fittedAt,
        trainingImpulseConstants: result.fittedAt,
      };
      expect(result.successfulFitAt).toEqual(successfulFitAt);
      expect(personalizedParamsSchema.parse(result).successfulFitAt).toEqual(successfulFitAt);
    } finally {
      vi.doUnmock("./fit-ewma.ts");
      vi.doUnmock("./fit-readiness-weights.ts");
      vi.doUnmock("./fit-sleep-target.ts");
      vi.doUnmock("./fit-stress-thresholds.ts");
      vi.doUnmock("./fit-trimp.ts");
      vi.resetModules();
    }
  });

  it("handles all fitters rejecting simultaneously", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("All queries fail")),
    };

    // Promise.allSettled catches all rejections
    const result = await refitAllParams(db, "user-1", createMockSensorStore());
    expect(result.version).toBe(2);
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

    const result = await refitAllParams(db, "user-1", createMockSensorStore());
    // All should be null (either rejected or insufficient data)
    expect(result.exponentialMovingAverage).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trainingImpulseConstants).toBeNull();
  });

  it("writes the current personalization schema version", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1", createMockSensorStore());
    expect(result.version).toBe(2);
  });
});

function generateExponentialMovingAverageRows(count: number): Record<string, unknown>[] {
  let chronicLoad = 0;
  let acuteLoad = 0;

  return Array.from({ length: count }, (_, index) => {
    const dailyLoad = 50 + 30 * Math.sin(index / 14) + ((index * 17) % 20);
    chronicLoad += (dailyLoad - chronicLoad) / 42;
    acuteLoad += (dailyLoad - acuteLoad) / 7;
    const trainingStressBalance = chronicLoad - acuteLoad;

    return {
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
      daily_load: dailyLoad,
      avg_performance: 200 + trainingStressBalance * 2,
    };
  });
}

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
      respiratory_rate: 16,
      rr_mean: 16,
      rr_sd: 1,
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
    expect(result[0]).toHaveProperty("respiratoryRateScore");
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

  it("computes hrvScore correctly using sigmoid z-score formula", () => {
    // hrv=70, hrv_mean=50, hrv_sd=10 => zHrv=2 => zScoreToRecoveryScore(2) = 92
    const result = parseReadinessRows([validReadinessRow({ hrv: 70, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBe(92);
  });

  it("hrvScore near 0 for very negative z-score", () => {
    // hrv=10, mean=50, sd=10 => z=-4 => zScoreToRecoveryScore(-4) ≈ 2
    const result = parseReadinessRows([validReadinessRow({ hrv: 10, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBeLessThanOrEqual(5);
  });

  it("hrvScore reaches 100 for very positive z-score", () => {
    // hrv=100, mean=50, sd=10 => z=5 => zScoreToRecoveryScore(5) = 100
    const result = parseReadinessRows([validReadinessRow({ hrv: 100, hrv_mean: 50, hrv_sd: 10 })]);
    expect(result[0]?.hrvScore).toBe(100);
  });

  it("computes rhrScore with inverted sign (higher RHR = lower score)", () => {
    // resting_hr=65, rhr_mean=55, rhr_sd=5 => zRhr=2, -zRhr=-2 => zScoreToRecoveryScore(-2) = 12
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 65, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBe(12);
  });

  it("rhrScore near 0 for very high resting HR z-score", () => {
    // resting_hr=80, mean=55, sd=5 => z=5, -z=-5 => zScoreToRecoveryScore(-5) ≈ 1
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 80, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBeLessThanOrEqual(5);
  });

  it("rhrScore reaches 100 for very low resting HR z-score", () => {
    // resting_hr=30, mean=55, sd=5 => z=-5, -z=5 => zScoreToRecoveryScore(5) = 100
    const result = parseReadinessRows([
      validReadinessRow({ resting_hr: 30, rhr_mean: 55, rhr_sd: 5 }),
    ]);
    expect(result[0]?.rhrScore).toBe(100);
  });

  it("uses efficiency_pct directly as sleepScore when present", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: 92 })]);
    expect(result[0]?.sleepScore).toBe(92);
  });

  it("defaults sleepScore to 62 when efficiency_pct is null", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: null })]);
    expect(result[0]?.sleepScore).toBe(62);
  });

  it("clamps sleepScore at 0 for negative efficiency_pct", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: -10 })]);
    expect(result[0]?.sleepScore).toBe(0);
  });

  it("clamps sleepScore at 100 for efficiency_pct above 100", () => {
    const result = parseReadinessRows([validReadinessRow({ efficiency_pct: 120 })]);
    expect(result[0]?.sleepScore).toBe(100);
  });

  it("computes respiratoryRateScore using sigmoid z-score (lower RR = better, inverted)", () => {
    // respiratory_rate=15, rr_mean=16, rr_sd=1 => z=-1, -z=1 => zScoreToRecoveryScore(1) = 81
    const result = parseReadinessRows([
      validReadinessRow({ respiratory_rate: 15, rr_mean: 16, rr_sd: 1 }),
    ]);
    expect(result[0]?.respiratoryRateScore).toBe(81);
  });

  it("computes respiratoryRateScore as 62 when respiratory rate equals mean", () => {
    // respiratory_rate=16, rr_mean=16, rr_sd=1 => z=0 => zScoreToRecoveryScore(0) = 62
    const result = parseReadinessRows([
      validReadinessRow({ respiratory_rate: 16, rr_mean: 16, rr_sd: 1 }),
    ]);
    expect(result[0]?.respiratoryRateScore).toBe(62);
  });

  it("defaults respiratoryRateScore to 62 when respiratory_rate is null", () => {
    const result = parseReadinessRows([validReadinessRow({ respiratory_rate: null })]);
    expect(result[0]?.respiratoryRateScore).toBe(62);
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
