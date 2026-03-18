import { describe, expect, it, vi } from "vitest";
import { refitAllParams } from "./refit.ts";

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

describe("refitAllParams", () => {
  it("returns params with all null fitters when data is insufficient", async () => {
    // All queries return empty results
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");

    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
    expect(result.ewma).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trimpConstants).toBeNull();
    expect(result.fittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("calls execute for data queries and save", async () => {
    const db = createMockDb([[], [], [], [], [], []]);
    await refitAllParams(db, "user-1");

    // Should be called at least once for data queries + once for save
    expect(db.execute).toHaveBeenCalled();
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
    const result = await refitAllParams(db, "user-1");
    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
  });
});
