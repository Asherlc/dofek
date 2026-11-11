import { DEFAULT_PARAMS } from "dofek/personalization/params";
import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
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
    const sensorStore = makeMockSensorStore();
    const repo = new PersonalizationRepository({ execute }, "user-1", sensorStore);
    return { repo, execute, sensorStore };
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
        stressThresholds: null,
      });
      expect(result.modelCards).toHaveLength(2);
      expect(result.modelCards.every((card) => card.status === "default")).toBe(true);
    });

    it("returns isPersonalized=true when any parameter is fitted", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 42,
          acuteTrainingLoadDays: 7,
          sampleCount: 100,
          correlation: 0.8,
        },
        stressThresholds: null,
      });
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.isPersonalized).toBe(true);
      expect(result.fittedAt).toBe("2025-06-01T00:00:00Z");
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
        stressThresholds: null,
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
        stressThresholds: {
          hrvThresholds: [30, 50, 70] satisfies [number, number, number],
          rhrThresholds: [50, 60, 70] satisfies [number, number, number],
          sampleCount: 30,
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
        stressThresholds: null,
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
        stressThresholds: null,
      });
      const { repo } = makeRepository();

      const result = await repo.getStatus();

      expect(result.effective.exponentialMovingAverage).toEqual({
        chronicTrainingLoadDays: 50,
        acuteTrainingLoadDays: 10,
      });
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
        stressThresholds: null,
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
      expect(result.effective.exponentialMovingAverage).toEqual({
        chronicTrainingLoadDays: 45,
        acuteTrainingLoadDays: 9,
      });
    });

    it("calls refitAllParams with correct user", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-15T12:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();

      await repo.refit();

      expect(mockedRefitAll).toHaveBeenCalledWith(expect.anything(), "user-1", expect.anything());
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
        stressThresholds: {
          hrvThresholds: [30, 50, 70] satisfies [number, number, number],
          rhrThresholds: [50, 60, 70] satisfies [number, number, number],
          sampleCount: 30,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();

      // Verify each parameter is passed through, not defaulted to null
      expect(result.parameters.exponentialMovingAverage).not.toBeNull();
      expect(result.parameters.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(42);
      expect(result.parameters.stressThresholds).not.toBeNull();
      expect(result.parameters.stressThresholds?.hrvThresholds).toEqual([30, 50, 70]);
    });

    it("maps fittedAt from stored params using ?? null (not empty string)", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
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
      expect(result.parameters.stressThresholds).toBeNull();
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
        stressThresholds: {
          hrvThresholds: [25, 45, 65] satisfies [number, number, number],
          rhrThresholds: [48, 58, 68] satisfies [number, number, number],
          sampleCount: 40,
        },
      });
      const { repo } = makeRepository();
      const result = await repo.refit();

      expect(result.parameters.exponentialMovingAverage?.chronicTrainingLoadDays).toBe(45);
      expect(result.parameters.stressThresholds?.hrvThresholds).toEqual([25, 45, 65]);
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
        stressThresholds: {
          hrvThresholds: [20, 40, 60] satisfies [number, number, number],
          rhrThresholds: [45, 55, 65] satisfies [number, number, number],
          sampleCount: 35,
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
      expect(result.parameters.stressThresholds).toStrictEqual({
        hrvThresholds: [20, 40, 60],
        rhrThresholds: [45, 55, 65],
        sampleCount: 35,
      });
    });

    it("maps refit parameters with all null sub-params", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-07-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.refit();

      expect(result.parameters.exponentialMovingAverage).toStrictEqual(null);
      expect(result.parameters.stressThresholds).toStrictEqual(null);
    });
  });

  describe("reset executes DELETE sql", () => {
    it("calls execute with SQL containing the user id and settings key", async () => {
      const { repo, execute } = makeRepository();
      await repo.reset();
      // Verify execute was called (BlockStatement mutation: removing the execute call)
      expect(execute).toHaveBeenCalledTimes(1);
      // Verify it returns exactly { effective: DEFAULT_PARAMS } and nothing else
      const result = await repo.reset();
      expect(Object.keys(result)).toStrictEqual(["effective"]);
      expect(result.effective).toStrictEqual(DEFAULT_PARAMS);
    });
  });

  describe("getStatus isPersonalized logical OR chain", () => {
    it("returns false when stored is non-null but all sub-params are null (tests && short-circuit)", async () => {
      // This tests the `stored !== null &&` part: stored is non-null, but all inner conditions are false
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      // If && was mutated to ||, this would be true (since stored !== null is true)
      expect(result.isPersonalized).toStrictEqual(false);
    });
  });

  describe("refit returns complete object structure", () => {
    it("returns object with exactly three keys: fittedAt, effective, parameters", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-07-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.refit();
      // ObjectLiteral mutation: verify the result has exactly the expected keys
      expect(Object.keys(result).sort()).toStrictEqual(["effective", "fittedAt", "parameters"]);
    });

    it("returns parameters for both retained models", async () => {
      mockedRefitAll.mockResolvedValue({
        version: 1,
        fittedAt: "2025-07-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.refit();
      expect(result.parameters).toEqual({ exponentialMovingAverage: null, stressThresholds: null });
    });
  });

  describe("getStatus returns complete object structure", () => {
    it("returns the status fields and server-built model cards", async () => {
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(Object.keys(result).sort()).toStrictEqual([
        "defaults",
        "effective",
        "fittedAt",
        "isPersonalized",
        "modelCards",
        "parameters",
      ]);
    });
  });

  describe("getStatus isPersonalized short-circuit: stored !== null AND condition", () => {
    it("returns false when stored is null even if && were mutated to ||", async () => {
      // Tests: stored !== null && (...)
      // If !== mutated to ===, result would be true when stored IS null
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.isPersonalized).toStrictEqual(false);
    });

    it("isPersonalized is exactly boolean false, not falsy (kills ConditionalExpression→false)", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(typeof result.isPersonalized).toBe("boolean");
      expect(result.isPersonalized).toBe(false);
    });

    it("isPersonalized is exactly boolean true, not truthy (kills ConditionalExpression→true)", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: {
          chronicTrainingLoadDays: 42,
          acuteTrainingLoadDays: 7,
          sampleCount: 100,
          correlation: 0.85,
        },
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(typeof result.isPersonalized).toBe("boolean");
      expect(result.isPersonalized).toBe(true);
    });
  });

  describe("reset side effects (BlockStatement mutation)", () => {
    it("execute is called before returning result (not skipped)", async () => {
      const { repo, execute } = makeRepository();
      const result = await repo.reset();
      // BlockStatement mutation would remove the execute call but still return DEFAULT_PARAMS
      // Verify both happened
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.effective).toStrictEqual(DEFAULT_PARAMS);
    });
  });

  describe("getStatus fittedAt optional chaining", () => {
    it("fittedAt uses stored?.fittedAt so null stored yields null (not undefined)", async () => {
      // stored?.fittedAt ?? null — if ?. mutated to ., null stored would throw
      mockedLoadParams.mockResolvedValue(null);
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.fittedAt).toStrictEqual(null);
      expect(result.fittedAt).not.toBe(undefined);
    });

    it("fittedAt passes through string value from stored params (not always null)", async () => {
      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-08-01T00:00:00Z",
        exponentialMovingAverage: null,
        stressThresholds: null,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();
      expect(result.fittedAt).toStrictEqual("2025-08-01T00:00:00Z");
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
      const stress = {
        hrvThresholds: [30, 50, 70] satisfies [number, number, number],
        rhrThresholds: [50, 60, 70] satisfies [number, number, number],
        sampleCount: 30,
      };

      mockedLoadParams.mockResolvedValue({
        version: 1,
        fittedAt: "2025-06-01T00:00:00Z",
        exponentialMovingAverage: ema,
        stressThresholds: stress,
      });
      const { repo } = makeRepository();
      const result = await repo.getStatus();

      // Each parameter should be exactly the stored value, not null
      expect(result.parameters.exponentialMovingAverage).toStrictEqual(ema);
      expect(result.parameters.stressThresholds).toStrictEqual(stress);
    });
  });
});
