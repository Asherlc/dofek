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

  describe("getStatus parameters mapping", () => {
    it("maps all stored parameters to output (not null when stored values exist)", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 42,
          acuteTrainingLoadDays: 7,
          sampleCount: 100,
          correlation: 0.85,
        },
        readinessWeights: {
          hrv: 0.4,
          restingHr: 0.3,
          sleep: 0.2,
          respiratoryRate: 0.1,
          sampleCount: 50,
          correlation: 0.8,
        },
        sleepTarget: { minutes: 450, sampleCount: 30 },
        stressThresholds: {
          hrvThresholds: [30, 50, 70] satisfies [number, number, number],
          rhrThresholds: [50, 60, 70] satisfies [number, number, number],
          sampleCount: 30,
        },
        trainingImpulseConstants: {
          genderFactor: 1.92,
          exponent: 1.67,
          sampleCount: 100,
          r2: 0.95,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();

      // Verify each parameter is passed through, not defaulted to null
      expect(result.parameters.exponentialMovingAverage).not.toBeNull();
      expect(result.parameters.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(42);
      expect(result.parameters.readinessWeights).not.toBeNull();
      expect(result.parameters.readinessWeights?.hrv).toBe(0.4);
      expect(result.parameters.sleepTarget).not.toBeNull();
      expect(result.parameters.sleepTarget?.minutes).toBe(450);
      expect(result.parameters.stressThresholds).not.toBeNull();
      expect(result.parameters.stressThresholds?.hrvThresholds).toEqual([30, 50, 70]);
      expect(result.parameters.trainingImpulseConstants).not.toBeNull();
      expect(result.parameters.trainingImpulseConstants?.genderFactor).toBe(1.92);
    });

    it("maps fittedAt from stored params using ?? null (not empty string)", async () => {
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
      expect(result.fittedAt).toBe("2025-06-01T00:00:00Z");
    });

    it("returns isPersonalized=false when stored is null (not just when all fields are null)", async () => {
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toBe(false);
      // parameters should all be null via ?? null coalescing
      expect(result.parameters.exponentialMovingAverage).toBeNull();
      expect(result.parameters.readinessWeights).toBeNull();
      expect(result.parameters.sleepTarget).toBeNull();
      expect(result.parameters.stressThresholds).toBeNull();
      expect(result.parameters.trainingImpulseConstants).toBeNull();
    });
  });

  describe("refit parameters mapping", () => {
    it("maps all refit output parameters correctly", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-15T12:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 45,
          acuteTrainingLoadDays: 9,
          sampleCount: 200,
          correlation: 0.9,
        },
        readinessWeights: {
          hrv: 0.35,
          restingHr: 0.25,
          sleep: 0.25,
          respiratoryRate: 0.15,
          sampleCount: 100,
          correlation: 0.82,
        },
        sleepTarget: { minutes: 460, sampleCount: 60 },
        stressThresholds: {
          hrvThresholds: [25, 45, 65] satisfies [number, number, number],
          rhrThresholds: [48, 58, 68] satisfies [number, number, number],
          sampleCount: 40,
        },
        trainingImpulseConstants: {
          genderFactor: 1.85,
          exponent: 1.7,
          sampleCount: 150,
          r2: 0.92,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.refit();

      expect(result.parameters.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(45);
      expect(result.parameters.readinessWeights?.hrv).toBe(0.35);
      expect(result.parameters.sleepTarget?.minutes).toBe(460);
      expect(result.parameters.stressThresholds?.hrvThresholds).toEqual([25, 45, 65]);
      expect(result.parameters.trainingImpulseConstants?.genderFactor).toBe(1.85);
    });

    it("maps each refit parameter to the correct output key (not swapped)", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-07-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 50,
          acuteTrainingLoadDays: 8,
          sampleCount: 120,
          correlation: 0.88,
        },
        readinessWeights: {
          hrv: 0.5,
          restingHr: 0.2,
          sleep: 0.15,
          respiratoryRate: 0.15,
          sampleCount: 80,
          correlation: 0.75,
        },
        sleepTarget: { minutes: 470, sampleCount: 45 },
        stressThresholds: {
          hrvThresholds: [20, 40, 60] satisfies [number, number, number],
          rhrThresholds: [45, 55, 65] satisfies [number, number, number],
          sampleCount: 35,
        },
        trainingImpulseConstants: {
          genderFactor: 1.9,
          exponent: 1.65,
          sampleCount: 180,
          r2: 0.93,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.refit();

      // Verify fittedAt comes from params.fittedAt
      expect(result.fittedAt).toBe("2025-07-01T00:00:00Z");

      // Verify each parameter object is mapped to the correct key
      expect(result.parameters.exponentialMovingAverage).toStrictEqual({
        chronicTrainingLoadDays: 50,
        acuteTrainingLoadDays: 8,
        sampleCount: 120,
        correlation: 0.88,
      });
      expect(result.parameters.readinessWeights).toStrictEqual({
        hrv: 0.5,
        restingHr: 0.2,
        sleep: 0.15,
        respiratoryRate: 0.15,
        sampleCount: 80,
        correlation: 0.75,
      });
      expect(result.parameters.sleepTarget).toStrictEqual({
        minutes: 470,
        sampleCount: 45,
      });
      expect(result.parameters.stressThresholds).toStrictEqual({
        hrvThresholds: [20, 40, 60],
        rhrThresholds: [45, 55, 65],
        sampleCount: 35,
      });
      expect(result.parameters.trainingImpulseConstants).toStrictEqual({
        genderFactor: 1.9,
        exponent: 1.65,
        sampleCount: 180,
        r2: 0.93,
      });
    });

    it("maps refit parameters with all null sub-params", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-07-01T00:00:00Z",
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: null,
        stressThresholds: null,
        trainingImpulseConstants: null,
      });
      const { repo } = makeRepository();
      const result = await repo.refit();

      expect(result.parameters.exponentialMovingAverage).toStrictEqual(null);
      expect(result.parameters.readinessWeights).toStrictEqual(null);
      expect(result.parameters.sleepTarget).toStrictEqual(null);
      expect(result.parameters.stressThresholds).toStrictEqual(null);
      expect(result.parameters.trainingImpulseConstants).toStrictEqual(null);
    });
  });

  describe("getStatus ?? null coalescing", () => {
    it("maps each parameter via ?? null, not using defaults when stored has values", async () => {
      const ema = {
        chronicTrainingLoadDays: 42,
        acuteTrainingLoadDays: 7,
        sampleCount: 100,
        correlation: 0.85,
      };
      const weights = {
        hrv: 0.4,
        restingHr: 0.3,
        sleep: 0.2,
        respiratoryRate: 0.1,
        sampleCount: 50,
        correlation: 0.8,
      };
      const sleep = { minutes: 450, sampleCount: 30 };
      const stress = {
        hrvThresholds: [30, 50, 70] satisfies [number, number, number],
        rhrThresholds: [50, 60, 70] satisfies [number, number, number],
        sampleCount: 30,
      };
      const trimp = {
        genderFactor: 1.92,
        exponent: 1.67,
        sampleCount: 100,
        r2: 0.95,
      };

      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: ema,
        readinessWeights: weights,
        sleepTarget: sleep,
        stressThresholds: stress,
        trainingImpulseConstants: trimp,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();

      // Each parameter should be exactly the stored value, not null
      expect(result.parameters.exponentialMovingAverage).toStrictEqual(ema);
      expect(result.parameters.readinessWeights).toStrictEqual(weights);
      expect(result.parameters.sleepTarget).toStrictEqual(sleep);
      expect(result.parameters.stressThresholds).toStrictEqual(stress);
      expect(result.parameters.trainingImpulseConstants).toStrictEqual(trimp);
    });
  });
});
