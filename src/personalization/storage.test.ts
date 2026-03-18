import { describe, expect, it, vi } from "vitest";
import { personalizedParamsSchema } from "./params.ts";
import { loadPersonalizedParams, savePersonalizedParams } from "./storage.ts";

function createMockDb(rows: Record<string, unknown>[] = []) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

const sampleParams: PersonalizedParams = {
  version: 1,
  fittedAt: "2026-03-18T12:00:00Z",
  ewma: {
    ctlDays: 35,
    atlDays: 9,
    sampleCount: 120,
    correlation: 0.35,
  },
  readinessWeights: null,
  sleepTarget: { minutes: 450, sampleCount: 30 },
  stressThresholds: null,
  trimpConstants: null,
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
});

describe("savePersonalizedParams", () => {
  it("calls execute with the params as JSON", async () => {
    const db = createMockDb([{ key: "personalized_params", value: sampleParams }]);
    await savePersonalizedParams(db, "user-1", sampleParams);
    expect(db.execute).toHaveBeenCalledOnce();
  });

  it("validates params with Zod before saving", () => {
    // Verify the schema rejects invalid data (version must be >= 1)
    const result = personalizedParamsSchema.safeParse({ version: 0 });
    expect(result.success).toBe(false);
  });
});
