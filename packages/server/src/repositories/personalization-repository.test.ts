import { DEFAULT_PARAMS } from "dofek/personalization/params";
import { describe, expect, it, vi } from "vitest";
import { PersonalizationRepository } from "./personalization-repository.ts";

// Mock the personalization modules
vi.mock("dofek/personalization/storage", () => ({
  SETTINGS_KEY: "personalized_params",
  loadPersonalizedParams: vi.fn(),
}));

vi.mock("dofek/personalization/refit", () => ({
  refitAllParams: vi.fn(),
}));

import { refitAllParams } from "dofek/personalization/refit";
// Import mocked functions for test control
import { loadPersonalizedParams } from "dofek/personalization/storage";

const mockedLoadParams = vi.mocked(loadPersonalizedParams);
const mockedRefitAll = vi.mocked(refitAllParams);

describe("PersonalizationRepository", () => {
  function makeRepository() {
    const execute = vi.fn().mockResolvedValue([]);
    const repo = new PersonalizationRepository({ execute }, "user-1");
    return { repo, execute };
  }

  describe("getStatus", () => {
    it("returns defaults when no stored params exist", async () => {
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.isPersonalized).toBe(false);
      expect(result.fittedAt).toBeNull();
      expect(result.defaults).toEqual(DEFAULT_PARAMS);
      expect(result.effective).toEqual(DEFAULT_PARAMS);
      expect(result.parameters).toEqual({
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
    });

    it("returns isPersonalized=true when any parameter is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: { minutes: 450, sampleCount: 30 },
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.isPersonalized).toBe(true);
      expect(result.fittedAt).toBe("2025-06-01T00:00:00Z");
      expect(result.parameters.sleepTarget).toEqual({ minutes: 450, sampleCount: 30 });
    });

    it("returns isPersonalized=true when only exponentialMovingAverage is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 42,
          acuteTrainingLoadDays: 7,
          sampleCount: 100,
          correlation: 0.85,
        },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toBe(true);
    });

    it("returns isPersonalized=true when only readinessWeights is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: {
          hrv: 0.4,
          restingHr: 0.3,
          sleep: 0.2,
          respiratoryRate: 0.1,
          sampleCount: 50,
          correlation: 0.8,
        },
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toBe(true);
    });

    it("returns isPersonalized=true when only stressThresholds is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: {
          hrvThresholds: [30, 50, 70] satisfies [number, number, number],
          rhrThresholds: [50, 60, 70] satisfies [number, number, number],
          sampleCount: 30,
        },
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toBe(true);
    });

    it("returns isPersonalized=true when only trainingImpulseConstants is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: {
          genderFactor: 1.92,
          exponent: 1.67,
          sampleCount: 100,
          r2: 0.95,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toBe(true);
    });

    it("returns fittedAt as null when stored params are null", async () => {
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.fittedAt).toStrictEqual(null);
    });

    it("returns isPersonalized=false when stored params exist but all are null", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.isPersonalized).toBe(false);
    });

    it("merges stored params with defaults for effective params", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 50,
          acuteTrainingLoadDays: 10,
          sampleCount: 100,
          correlation: 0.85,
        },
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.effective.exponentialMovingAverage).toEqual({
        chronicTrainingLoadDays: 50,
        acuteTrainingLoadDays: 10,
      });
      // Non-fitted params should use defaults
      expect(result.effective.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    });
  });

  describe("refit", () => {
    it("returns fitted parameters and effective params", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-15T12:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 45,
          acuteTrainingLoadDays: 9,
          sampleCount: 200,
          correlation: 0.9,
        },
        readinessWeights: null,
        sleepTarget: { minutes: 460, sampleCount: 60 },
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();

      const result = await repo.refit();

      expect(result.fittedAt).toBe("2025-06-15T12:00:00Z");
      expect(result.parameters.exponentialMovingAverage).toEqual({
        chronicTrainingLoadDays: 45,
        acuteTrainingLoadDays: 9,
        sampleCount: 200,
        correlation: 0.9,
      });
      expect(result.parameters.sleepTarget).toEqual({ minutes: 460, sampleCount: 60 });
      expect(result.effective.exponentialMovingAverage).toEqual({
        chronicTrainingLoadDays: 45,
        acuteTrainingLoadDays: 9,
      });
      expect(result.effective.sleepTarget).toEqual({ minutes: 460 });
      // Unfitted params use defaults in effective
      expect(result.effective.readinessWeights).toEqual(DEFAULT_PARAMS.readinessWeights);
    });

    it("calls refitAllParams with correct user", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-15T12:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();

      await repo.refit();

      expect(mockedRefitAll).toHaveBeenCalledWith(expect.anything(), "user-1");
    });
  });

  describe("reset", () => {
    it("returns default effective params", async () => {
      const { repo } = makeRepository();

      const result = await repo.reset();

      expect(result.effective).toEqual(DEFAULT_PARAMS);
    });

    it("calls execute to delete stored params", async () => {
      const { repo, execute } = makeRepository();

      await repo.reset();

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
