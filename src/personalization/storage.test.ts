import { describe, expect, it, vi } from "vitest";
import type { PersonalizedParams } from "./params.ts";
import { loadPersonalizedParams, savePersonalizedParams } from "./storage.ts";

function createMockDb(rows: Record<string, unknown>[] = []) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

const sampleParams: PersonalizedParams = {
  version: 1,
  fittedAt: "2026-03-18T12:00:00Z",
  exponentialMovingAverage: {
    chronicTrainingLoadDays: 35,
    acuteTrainingLoadDays: 9,
    sampleCount: 120,
    correlation: 0.35,
  },
  readinessWeights: null,
  sleepTarget: { minutes: 450, sampleCount: 30 },
  stressThresholds: null,
  trainingImpulseConstants: null,
};

describe("loadPersonalizedParams", () => {
  it("returns null when no setting exists", async () => {
    const db = createMockDb([]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("parses and returns valid stored params", async () => {
    const db = createMockDb([{ value: sampleParams }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toEqual(sampleParams);
  });

  it("returns null when stored value fails Zod validation", async () => {
    const db = createMockDb([{ value: { version: 0, garbage: true } }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
  });

  it("returns null when stored value is a string instead of object", async () => {
    const db = createMockDb([{ value: "not an object" }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
  });

  it("returns null when row exists but value is null", async () => {
    const db = createMockDb([{ value: null }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
  });

  it("returns null when row exists but value is undefined", async () => {
    const db = createMockDb([{ value: undefined }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
  });

  it("uses safeParse so invalid data does not throw", async () => {
    const db = createMockDb([{ value: { version: -5, broken: true } }]);
    // Should not throw, just returns null
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toBeNull();
  });

  it("returns full params object with all sub-objects populated", async () => {
    const fullParams: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: {
        chronicTrainingLoadDays: 35,
        acuteTrainingLoadDays: 9,
        sampleCount: 120,
        correlation: 0.35,
      },
      readinessWeights: {
        hrv: 0.5,
        restingHr: 0.15,
        sleep: 0.2,
        loadBalance: 0.15,
        sampleCount: 90,
        correlation: 0.25,
      },
      sleepTarget: { minutes: 450, sampleCount: 30 },
      stressThresholds: {
        hrvThresholds: [-1.2, -0.8, -0.3],
        rhrThresholds: [1.2, 0.8, 0.3],
        sampleCount: 80,
      },
      trainingImpulseConstants: { genderFactor: 0.7, exponent: 1.8, sampleCount: 25, r2: 0.45 },
    };
    const db = createMockDb([{ value: fullParams }]);
    const result = await loadPersonalizedParams(db, "user-1");
    expect(result).toEqual(fullParams);
  });
});

describe("savePersonalizedParams", () => {
  it("calls execute with the params as JSON", async () => {
    const db = createMockDb([{ key: "personalized_params", value: sampleParams }]);
    await savePersonalizedParams(db, "user-1", sampleParams);
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("throws when params fail Zod validation before saving", async () => {
    const db = createMockDb();
    // Construct an object that the type system accepts but Zod rejects at runtime.
    // We build a "valid" object then corrupt it after assignment.
    const invalidParams: PersonalizedParams = {
      version: 1, // will be overwritten below
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    // Corrupt the version at runtime so Zod rejects it
    Object.assign(invalidParams, { version: 0 });

    // personalizedParamsSchema.parse() should throw before execute is called
    await expect(savePersonalizedParams(db, "user-1", invalidParams)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does not call execute when validation fails", async () => {
    const db = createMockDb();
    const invalidParams: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };
    Object.assign(invalidParams, { version: -1 });

    try {
      await savePersonalizedParams(db, "user-1", invalidParams);
    } catch {
      // expected
    }

    expect(db.execute).not.toHaveBeenCalled();
  });

  it("saves params with all null sub-objects", async () => {
    const db = createMockDb();
    const nullParams: PersonalizedParams = {
      version: 1,
      fittedAt: "2026-03-18T12:00:00Z",
      exponentialMovingAverage: null,
      readinessWeights: null,
      sleepTarget: null,
      stressThresholds: null,
      trainingImpulseConstants: null,
    };

    await savePersonalizedParams(db, "user-1", nullParams);
    expect(db.execute).toHaveBeenCalledOnce();
  });
});
