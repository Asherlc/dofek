import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

const { mockInvalidateUserQueryDomains, mockLoggerError } = vi.hoisted(() => ({
  mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
  mockLoggerError: vi.fn(),
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
}));

vi.mock("../logger.ts", () => ({
  logger: { error: mockLoggerError },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

const fakeSensorStore = {
  query: vi.fn().mockResolvedValue([]),
  getActivitySummaries: vi.fn().mockResolvedValue([]),
  getStream: vi.fn().mockResolvedValue([]),
  getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
  getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
  getPowerCurveSamples: vi.fn().mockResolvedValue([]),
  getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
  getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
  getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
  getPaceCurveRows: vi.fn().mockResolvedValue([]),
} satisfies ActivitySensorStore;

const mockLoadPersonalizedParams = vi.fn();
vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: (...args: unknown[]) => mockLoadPersonalizedParams(...args),
  SETTINGS_KEY: "personalized_params",
}));

const mockRefitAllParams = vi.fn();
vi.mock("dofek/personalization/refit", () => ({
  refitAllParams: (...args: unknown[]) => mockRefitAllParams(...args),
}));

vi.mock("dofek/personalization/params", async () => {
  const actual = await vi.importActual("dofek/personalization/params");
  return actual;
});

import type { PersonalizedParams } from "dofek/personalization/params";
import { DEFAULT_PARAMS } from "dofek/personalization/params";
import { personalizationRouter } from "./personalization.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(personalizationRouter);

describe("personalizationRouter", () => {
  beforeEach(() => {
    mockInvalidateUserQueryDomains.mockClear();
    mockLoggerError.mockClear();
  });

  describe("status", () => {
    it("returns an actionable user-safe error when activity analytics are unavailable", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.status()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Personalization is unavailable because activity analytics are not configured. Contact your administrator.",
      });
      expect(mockLoggerError).toHaveBeenCalledWith(
        "[personalization] personalization.status requires CLICKHOUSE_URL",
      );
    });

    it("returns not personalized with defaults when no stored params", async () => {
      mockLoadPersonalizedParams.mockResolvedValue(null);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(false);
      expect(result.fittedAt).toBeNull();
      expect(result.defaults).toEqual(DEFAULT_PARAMS);
      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(result.parameters.exponentialMovingAverage).toBeNull();
      expect(result.parameters.readinessWeights).toBeNull();
      expect(result.parameters.sleepTarget).toBeNull();
      expect(result.parameters.stressThresholds).toBeNull();
      expect(result.parameters.trainingImpulseConstants).toBeNull();
      expect(result.modelCards).toHaveLength(5);
      expect(result.modelCards.every((card) => card.status === "default")).toBe(true);
    });

    it("returns isPersonalized=true when at least one sub-param is non-null", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 35,
          acuteTrainingLoadDays: 9,
          sampleCount: 120,
          correlation: 0.35,
        },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(true);
      expect(result.fittedAt).toBe("2026-03-18T12:00:00Z");
      expect(result.effective.exponentialMovingAverage.chronicTrainingLoadDays).toBe(35);
      expect(result.parameters.exponentialMovingAverage).not.toBeNull();
      expect(result.modelCards[0]).toMatchObject({
        key: "exponentialMovingAverage",
        status: "personalized",
        lastSuccessfulFitAt: null,
        lastFitSummary: "Successful fit time unavailable until this model is refit",
      });
    });

    it("returns isPersonalized=false when all sub-params are null", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(false);
      expect(result.fittedAt).toBe("2026-03-18T12:00:00Z");
    });

    it("passes db and userId to loadPersonalizedParams", async () => {
      mockLoadPersonalizedParams.mockResolvedValue(null);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({
        db: mockDb,
        userId: "user-42",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      await caller.status();

      expect(mockLoadPersonalizedParams).toHaveBeenCalledWith(mockDb, "user-42");
    });

    it("returns effective params that merge stored with defaults", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 28,
          acuteTrainingLoadDays: 5,
          sampleCount: 100,
          correlation: 0.3,
        },
        readinessWeights: null,
        sleepTarget: { minutes: 450, sampleCount: 30 },
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.status();

      expect(result.effective.exponentialMovingAverage.chronicTrainingLoadDays).toBe(28);
      expect(result.effective.exponentialMovingAverage.acuteTrainingLoadDays).toBe(5);
      expect(result.effective.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
      expect(result.effective.sleepTarget.minutes).toBe(450);
      expect(result.effective.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
      expect(result.effective.trainingImpulseConstants).toEqual(
        DEFAULT_PARAMS.trainingImpulseConstants,
      );
    });
  });

  describe("refit", () => {
    it("calls refitAllParams and returns results", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 35,
          acuteTrainingLoadDays: 9,
          sampleCount: 120,
          correlation: 0.35,
        },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({
        db: mockDb,
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.refit();

      expect(mockRefitAllParams).toHaveBeenCalledWith(mockDb, "user-1", fakeSensorStore);
      expect(result.fittedAt).toBe("2026-03-18T14:00:00Z");
      expect(result.effective.exponentialMovingAverage.chronicTrainingLoadDays).toBe(35);
      expect(result.parameters.exponentialMovingAverage).not.toBeNull();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalization"]);
    });

    it("returns defaults for null sub-params in effective", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.refit();

      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(result.parameters.exponentialMovingAverage).toBeNull();
      expect(result.parameters.readinessWeights).toBeNull();
      expect(result.parameters.sleepTarget).toBeNull();
      expect(result.parameters.stressThresholds).toBeNull();
      expect(result.parameters.trainingImpulseConstants).toBeNull();
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalization"]);
    });

    it("passes db and userId to refitAllParams", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({
        db: mockDb,
        userId: "user-99",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      await caller.refit();

      expect(mockRefitAllParams).toHaveBeenCalledWith(mockDb, "user-99", fakeSensorStore);
    });
  });

  describe("reset", () => {
    it("deletes personalized params and returns defaults", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      const result = await caller.reset();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["personalization"]);
    });

    it("calls db.execute to delete the settings row", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: fakeSensorStore,
      });

      await caller.reset();

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });
});
