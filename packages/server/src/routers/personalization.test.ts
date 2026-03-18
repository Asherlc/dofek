import { describe, expect, it, vi } from "vitest";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

const mockLoadPersonalizedParams = vi.fn();
vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: (...args: unknown[]) => mockLoadPersonalizedParams(...args),
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
  describe("status", () => {
    it("returns not personalized with defaults when no stored params", async () => {
      mockLoadPersonalizedParams.mockResolvedValue(null);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(false);
      expect(result.fittedAt).toBeNull();
      expect(result.defaults).toEqual(DEFAULT_PARAMS);
      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(result.parameters.ewma).toBeNull();
      expect(result.parameters.readinessWeights).toBeNull();
      expect(result.parameters.sleepTarget).toBeNull();
      expect(result.parameters.stressThresholds).toBeNull();
      expect(result.parameters.trimpConstants).toBeNull();
    });

    it("returns isPersonalized=true when at least one sub-param is non-null", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        ewma: { ctlDays: 35, atlDays: 9, sampleCount: 120, correlation: 0.35 },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trimpConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(true);
      expect(result.fittedAt).toBe("2026-03-18T12:00:00Z");
      expect(result.effective.ewma.ctlDays).toBe(35);
      expect(result.parameters.ewma).not.toBeNull();
    });

    it("returns isPersonalized=false when all sub-params are null", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        ewma: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trimpConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      const result = await caller.status();

      expect(result.isPersonalized).toBe(false);
      expect(result.fittedAt).toBe("2026-03-18T12:00:00Z");
    });

    it("passes db and userId to loadPersonalizedParams", async () => {
      mockLoadPersonalizedParams.mockResolvedValue(null);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-42" });

      await caller.status();

      expect(mockLoadPersonalizedParams).toHaveBeenCalledWith(mockDb, "user-42");
    });

    it("returns effective params that merge stored with defaults", async () => {
      const stored: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T12:00:00Z",
        ewma: { ctlDays: 28, atlDays: 5, sampleCount: 100, correlation: 0.3 },
        readinessWeights: null,
        sleepTarget: { minutes: 450, sampleCount: 30 },
        stressThresholds: null,
        trimpConstants: null,
      };
      mockLoadPersonalizedParams.mockResolvedValue(stored);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      const result = await caller.status();

      expect(result.effective.ewma.ctlDays).toBe(28);
      expect(result.effective.ewma.atlDays).toBe(5);
      expect(result.effective.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
      expect(result.effective.sleepTarget.minutes).toBe(450);
      expect(result.effective.stressThresholds).toEqual(DEFAULT_PARAMS.stressThresholds);
      expect(result.effective.trimpConstants).toEqual(DEFAULT_PARAMS.trimpConstants);
    });
  });

  describe("refit", () => {
    it("calls refitAllParams and returns results", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        ewma: { ctlDays: 35, atlDays: 9, sampleCount: 120, correlation: 0.35 },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trimpConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-1" });

      const result = await caller.refit();

      expect(mockRefitAllParams).toHaveBeenCalledWith(mockDb, "user-1");
      expect(result.fittedAt).toBe("2026-03-18T14:00:00Z");
      expect(result.effective.ewma.ctlDays).toBe(35);
      expect(result.parameters.ewma).not.toBeNull();
    });

    it("returns defaults for null sub-params in effective", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        ewma: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trimpConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });

      const result = await caller.refit();

      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(result.parameters.ewma).toBeNull();
      expect(result.parameters.readinessWeights).toBeNull();
      expect(result.parameters.sleepTarget).toBeNull();
      expect(result.parameters.stressThresholds).toBeNull();
      expect(result.parameters.trimpConstants).toBeNull();
    });

    it("passes db and userId to refitAllParams", async () => {
      const refitResult: PersonalizedParams = {
        version: 1,
        fittedAt: "2026-03-18T14:00:00Z",
        ewma: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trimpConstants: null,
      };
      mockRefitAllParams.mockResolvedValue(refitResult);
      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-99" });

      await caller.refit();

      expect(mockRefitAllParams).toHaveBeenCalledWith(mockDb, "user-99");
    });
  });

  describe("reset", () => {
    it("deletes personalized params and returns defaults", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      const result = await caller.reset();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.effective).toEqual(DEFAULT_PARAMS);
    });

    it("calls db.execute to delete the settings row", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.reset();

      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });
});
