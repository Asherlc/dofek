import { captureException } from "dofek/lib/error-reporting";
import { describe, expect, it, vi } from "vitest";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: vi.fn().mockResolvedValue(undefined) },
}));

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
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
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

import { bodyAnalyticsRouter } from "./body-analytics.ts";

const createCaller = createTestCallerFactory(bodyAnalyticsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    sensorStore: makeMockSensorStore(withDecisionProvenance(rows)),
    userId: "user-1",
    timezone: "UTC",
  });
}

function withDecisionProvenance(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const date = typeof row.date === "string" ? row.date : "2026-01-01";
    return {
      ...row,
      recorded_at: typeof row.recorded_at === "string" ? row.recorded_at : `${date}T08:00:00.000Z`,
      recorded_at_local:
        typeof row.recorded_at_local === "string" ? row.recorded_at_local : `${date} 08:00:00`,
      provider_id: typeof row.provider_id === "string" ? row.provider_id : "test-provider",
      source_name: typeof row.source_name === "string" ? row.source_name : null,
    };
  });
}

function makeCallerWithSettings(
  bodyRows: Record<string, unknown>[],
  settingRows: Record<string, unknown>[],
) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(settingRows) },
    sensorStore: makeMockSensorStore(withDecisionProvenance(bodyRows)),
    userId: "user-1",
    timezone: "UTC",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bodyAnalyticsRouter", () => {
  it("versions both weight response cache contracts", () => {
    expect(
      cachedQueryOptions.filter((options) => options.keyVersion === "health-status-evidence-v4"),
    ).toHaveLength(2);
  });

  describe("smoothedWeight", () => {
    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.smoothedWeight({ days: 90, endDate: "2024-01-08" });
      expect(result).toEqual([]);
    });

    it("applies EWMA smoothing to weight data", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80 },
        { date: "2024-01-02", weight_kg: 81 },
        { date: "2024-01-03", weight_kg: 79 },
        { date: "2024-01-04", weight_kg: 80.5 },
        { date: "2024-01-05", weight_kg: 80 },
        { date: "2024-01-06", weight_kg: 80.2 },
        { date: "2024-01-07", weight_kg: 80.1 },
        { date: "2024-01-08", weight_kg: 79.8 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.smoothedWeight({ days: 90, endDate: "2024-01-08" });

      expect(result).toHaveLength(8);
      expect(result[0]?.rawWeight).toBe(80);
      expect(result[0]?.smoothedWeight).toBe(80);
      // Smoothed should differ from raw after first point
      expect(result[1]?.smoothedWeight).not.toBe(result[1]?.rawWeight);
      // Weekly change should be null for first 7 entries, defined for 8th
      expect(result[6]?.weeklyChange).toBeNull();
      expect(result[7]?.weeklyChange).toBeDefined();
      expect(result[7]?.weeklyChange).not.toBeNull();
    });
  });

  describe("recomposition", () => {
    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.recomposition({ days: 180, endDate: "2026-03-15" });
      expect(result).toEqual([]);
    });

    it("calculates fat and lean mass from weight and body fat", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80, body_fat_pct: 20 },
        { date: "2024-01-02", weight_kg: 80, body_fat_pct: 19.5 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.recomposition({ days: 180, endDate: "2026-03-15" });

      expect(result).toHaveLength(2);
      expect(result[0]?.fatMassKg).toBe(16);
      expect(result[0]?.leanMassKg).toBe(64);
      // Smoothed should equal raw for first entry
      expect(result[0]?.smoothedFatMass).toBe(16);
      expect(result[0]?.smoothedLeanMass).toBe(64);
    });
  });

  describe("weightTrend", () => {
    it("returns insufficient when less than 7 data points", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80 },
        { date: "2024-01-02", weight_kg: 80.5 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("insufficient");
      expect(result.currentWeekly).toBeNull();
      expect(result.current4Week).toBeNull();
    });

    it("calculates weight trend with sufficient data", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80 + i * 0.1,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).not.toBe("insufficient");
      expect(result.currentWeekly).not.toBeNull();
    });

    it("detects gaining trend", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80 + i * 2, // large gain
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("gaining");
    });

    it("detects stable trend", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("stable");
    });
  });

  describe("weightOverview", () => {
    it("uses the selected range for chart data and at least 90 days for prediction", async () => {
      const smoothedWeightSpy = vi
        .spyOn(BodyAnalyticsRepository.prototype, "getSmoothedWeight")
        .mockResolvedValueOnce([]);
      const weightPredictionSpy = vi
        .spyOn(BodyAnalyticsRepository.prototype, "getWeightPrediction")
        .mockResolvedValueOnce({
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        });
      const caller = makeCaller();

      await caller.weightOverview({ days: 7, endDate: "2026-03-15" });

      expect(smoothedWeightSpy).toHaveBeenCalledWith(7, "2026-03-15");
      expect(weightPredictionSpy).toHaveBeenCalledWith(90, "2026-03-15", null);
    });

    it("returns smoothed weight and prediction from the same fetch", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
        body_fat_pct: 20,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightOverview({ days: 90, endDate: "2024-01-20" });

      expect(result.smoothedWeight).toHaveLength(20);
      expect(result.prediction?.ratePerWeek).not.toBeNull();
      expect(result.prediction?.periodDeltas).toBeDefined();
      expect(result.healthStatus).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: "trend_weight",
            intent: "neutral",
            value: expect.any(Number),
          }),
        ]),
      );
    });

    it("returns server-authored measurement provenance and variation context", async () => {
      vi.spyOn(BodyAnalyticsRepository.prototype, "getBodyDecisionContext").mockResolvedValueOnce({
        latestMeasurement: {
          date: "2024-01-20",
          recordedAt: "2024-01-20T08:00:00.000Z",
          recordedAtLocal: "2024-01-20 08:00:00",
          weightKg: 79.8,
          providerId: "withings",
          sourceName: "Body+",
        },
        trendWeight: {
          smoothing: "ewma",
          alpha: 0.1,
          gapHandling: "linear_interpolation",
          invalidWeightHandling: "exclude_non_positive",
          outlierHandling: "retain",
        },
        variation: {
          status: "available",
          observations: 12,
          minimumObservations: 8,
          maximumObservations: 30,
          method: "tukey_inner_fence",
          lowerResidualKg: -0.6,
          upperResidualKg: 0.7,
          outliersIncluded: true,
        },
      });
      const caller = makeCaller([]);

      const result = await caller.weightOverview({ days: 90, endDate: "2024-01-20" });

      expect(result.decisionContext.latestMeasurement).toMatchObject({
        providerId: "withings",
        sourceName: "Body+",
        recordedAt: "2024-01-20T08:00:00.000Z",
      });
      expect(result.decisionContext.variation).toMatchObject({
        status: "available",
        lowerResidualKg: -0.6,
        upperResidualKg: 0.7,
      });
    });

    it("returns neutral body fat classifications from server-owned recomposition data", async () => {
      vi.spyOn(BodyAnalyticsRepository.prototype, "getRecomposition").mockResolvedValueOnce([
        {
          date: "2024-01-19",
          weightKg: 80,
          bodyFatPct: 21,
          fatMassKg: 16.8,
          leanMassKg: 63.2,
          smoothedFatMass: 16.8,
          smoothedLeanMass: 63.2,
        },
        {
          date: "2024-01-20",
          weightKg: 80,
          bodyFatPct: 23,
          fatMassKg: 18.4,
          leanMassKg: 61.6,
          smoothedFatMass: 17,
          smoothedLeanMass: 63,
        },
      ]);
      const caller = makeCaller([]);

      const result = await caller.weightOverview({ days: 90, endDate: "2024-01-20" });

      expect(result.healthStatus).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: "body_fat_percentage",
            value: 23,
            baseline: 22,
            intent: "neutral",
          }),
        ]),
      );
    });

    it("fetches full history through the selected end date for finite ranges", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.weightOverview({ days: 90, endDate: "2026-03-15" });

      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain(
        "toDate(toTimeZone(recorded_at, {timezone:String})) <= toDate({endDate:String})",
      );
      expect(queryText).not.toContain("subtractDays");
      expect(queryParams).toMatchObject({ endDate: "2026-03-15" });
      expect(queryParams).not.toHaveProperty("days");
    });

    it("omits the lower date bound when days is null", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.weightOverview({ days: null, endDate: "2026-03-15" });

      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain("WHERE user_id = {userId:UUID}");
      expect(queryText).not.toContain("subtractDays");
      expect(queryParams).toMatchObject({ endDate: "2026-03-15" });
      expect(queryParams).not.toHaveProperty("days");
    });

    it("propagates the underlying error when the smoothed weight fetch fails", async () => {
      const sensorStore = makeMockSensorStore([]);
      sensorStore.query = vi.fn().mockRejectedValue(new Error("connection reset"));
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.weightOverview({ days: 90, endDate: "2026-03-15" })).rejects.toThrow(
        "connection reset",
      );
    });

    it("returns smoothed weight with a null prediction when only the prediction fetch fails", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
        body_fat_pct: 20,
      }));
      const predictionError = new Error("regression blew up");
      vi.spyOn(BodyAnalyticsRepository.prototype, "getWeightPrediction").mockRejectedValueOnce(
        predictionError,
      );
      const caller = makeCaller(rows);

      const result = await caller.weightOverview({ days: 90, endDate: "2024-01-20" });

      expect(result.smoothedWeight).toHaveLength(20);
      expect(result.prediction).toBeNull();
      expect(captureException).toHaveBeenCalledWith(predictionError);
    });

    it("returns a semantic API error when recomposition cannot be loaded", async () => {
      const recompositionError = new Error("relation analytics.body_composition does not exist");
      vi.spyOn(BodyAnalyticsRepository.prototype, "getRecomposition").mockRejectedValueOnce(
        recompositionError,
      );
      const caller = makeCaller([]);

      await expect(
        caller.weightOverview({ days: 90, endDate: "2024-01-20" }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Body composition data is temporarily unavailable. Please try again.",
      });
      expect(captureException).toHaveBeenCalledWith(recompositionError);
    });
  });

  describe("weightPrediction", () => {
    it("returns prediction with all fields when sufficient data", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
        key: "goalWeight",
        value: null,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.ratePerWeek).not.toBeNull();
      expect(result.periodDeltas).toBeDefined();
      expect(result.projectionLine.length).toBeGreaterThan(0);
    });

    it("returns empty prediction when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.ratePerWeek).toBeNull();
      expect(result.goal).toBeNull();
      expect(result.projectionLine).toEqual([]);
    });

    it("uses numeric goal weight setting in prediction", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = makeCallerWithSettings(rows, [{ key: "goalWeight", value: 75 }]);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.goal?.goalWeightKg).toBe(75);
      expect(result.goal?.remainingKg).toBeLessThan(0);
    });

    it("ignores non-numeric goal weight setting", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = makeCallerWithSettings(rows, [{ key: "goalWeight", value: "not-a-number" }]);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.goal).toBeNull();
      expect(result.ratePerWeek).not.toBeNull();
      expect(result.projectionLine.length).toBeGreaterThan(0);
    });

    it("continues prediction when goal weight settings lookup fails", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = createCaller({
        db: { execute: vi.fn().mockRejectedValue(new Error("settings unavailable")) },
        sensorStore: makeMockSensorStore(rows),
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.weightPrediction({ days: 90, endDate: "2026-03-15" }),
      ).resolves.toMatchObject({
        goal: null,
        ratePerWeek: expect.any(Number),
      });
      expect(captureException).toHaveBeenCalledTimes(1);
    });

    it("returns null goal when goal weight value is null", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = makeCallerWithSettings(rows, [{ key: "goalWeight", value: null }]);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.goal).toBeNull();
      expect(result.ratePerWeek).not.toBeNull();
      expect(result.projectionLine.length).toBeGreaterThan(0);
    });

    it("returns null goal when no goal weight setting row exists", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        sensorStore: makeMockSensorStore(rows),
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.goal).toBeNull();
      expect(captureException).not.toHaveBeenCalled();
    });

    it("returns null goal when goal weight value is not finite", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: 80 - index * 0.1,
      }));
      const caller = makeCallerWithSettings(rows, [{ key: "goalWeight", value: Infinity }]);
      const result = await caller.weightPrediction({ days: 90, endDate: "2026-03-15" });

      expect(result.goal).toBeNull();
      expect(result.ratePerWeek).not.toBeNull();
      expect(captureException).not.toHaveBeenCalled();
    });
  });

  describe("recomposition selected range", () => {
    it("omits the lower date bound when days is null", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.recomposition({ days: null, endDate: "2026-03-15" });

      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain("body_fat_pct IS NOT NULL");
      expect(queryText).not.toContain("subtractDays");
      expect(queryParams).not.toHaveProperty("days");
    });
  });

  describe("setGoalWeight", () => {
    it("stores goal weight and returns it", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ key: "goalWeight", value: 75 }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.setGoalWeight({ weightKg: 75 });

      expect(result.goalWeightKg).toBe(75);
    });

    it("clears goal weight when null", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ key: "goalWeight", value: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.setGoalWeight({ weightKg: null });

      expect(result.goalWeightKg).toBeNull();
    });
  });

  describe("access window gating", () => {
    it("smoothedWeight passes accessWindow to repository (limited window returns empty)", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeMockSensorStore([]),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.smoothedWeight({ days: 90, endDate: "2026-04-26" });
      expect(result).toEqual([]);
    });
  });
});
