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

import { parseExponentialMovingAverageRows, parseStressRows, refitAllParams } from "./refit.ts";

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
    expect(result.stressThresholds).toBeNull();
    expect(result.fittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
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
    let callCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 3) return Promise.reject(new Error("Save failed"));
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
        if (callCount === 2) return Promise.reject(loadError);
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
        stressThresholds: null,
      },
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 8,
        sampleCount: 40,
        correlation: 0.5,
      },
      stressThresholds: null,
    };
    const db = createMockDb([[], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result.exponentialMovingAverage).toEqual(existingParams.exponentialMovingAverage);
    expect(result.fittedAt).not.toBe(existingParams.fittedAt);
    expect(result.successfulFitAt?.exponentialMovingAverage).toBe(
      existingParams.successfulFitAt.exponentialMovingAverage,
    );
  });

  it("preserves every successful fit timestamp when fulfilled refits return no fit", async () => {
    const successfulFitAt = {
      exponentialMovingAverage: "2025-12-15T00:00:00.000Z",
      stressThresholds: "2025-12-18T00:00:00.000Z",
    };
    const existingParams = {
      version: 2,
      fittedAt: "2026-01-01T00:00:00.000Z",
      successfulFitAt,
      exponentialMovingAverage: null,
      stressThresholds: null,
    };
    const db = createMockDb([[], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());

    expect(result.successfulFitAt).toEqual(successfulFitAt);
  });

  it("preserves every successful fit timestamp when all refits reject", async () => {
    const successfulFitAt = {
      exponentialMovingAverage: "2025-12-15T00:00:00.000Z",
      stressThresholds: "2025-12-18T00:00:00.000Z",
    };
    const existingParams = {
      version: 2,
      fittedAt: "2026-01-01T00:00:00.000Z",
      successfulFitAt,
      exponentialMovingAverage: null,
      stressThresholds: null,
    };
    let dbCallCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        dbCallCount++;
        if (dbCallCount === 1) return Promise.resolve([{ value: existingParams }]);
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
      stressThresholds: null,
    };
    const db = createMockDb([[], [{ value: existingParams }], []]);

    const result = await refitAllParams(db, "user-1", createMockSensorStore());
    expect(result.successfulFitAt).toEqual({
      exponentialMovingAverage: null,
      stressThresholds: null,
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
  });

  it("records the same attempt timestamp when every fitter accepts a new fit", async () => {
    const accepted = {
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 42,
        acuteTrainingLoadDays: 7,
        sampleCount: 120,
        correlation: 0.8,
      },
      stressThresholds: {
        hrvThresholds: [-1.8, -1.1, -0.4] satisfies [number, number, number],
        rhrThresholds: [1.8, 1.1, 0.4] satisfies [number, number, number],
        sampleCount: 90,
      },
    };
    vi.doMock("./fit-ewma.ts", () => ({
      fitExponentialMovingAverage: vi.fn(() => accepted.exponentialMovingAverage),
    }));
    vi.doMock("./fit-stress-thresholds.ts", () => ({
      fitStressThresholds: vi.fn(() => accepted.stressThresholds),
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
        stressThresholds: result.fittedAt,
      };
      expect(result.successfulFitAt).toEqual(successfulFitAt);
      expect(personalizedParamsSchema.parse(result).successfulFitAt).toEqual(successfulFitAt);
    } finally {
      vi.doUnmock("./fit-ewma.ts");
      vi.doUnmock("./fit-stress-thresholds.ts");
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
    expect(result.stressThresholds).toBeNull();
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
    expect(result.stressThresholds).toBeNull();
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
