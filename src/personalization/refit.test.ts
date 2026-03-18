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

  it("fittedAt is a valid ISO timestamp", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");

    // Should be a valid ISO date string
    const parsed = new Date(result.fittedAt);
    expect(parsed.toISOString()).toBe(result.fittedAt);
  });

  it("handles save failure gracefully (logs but does not throw)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        callCount++;
        // First 5 calls are data queries (one per fitter), 6th is save
        if (callCount === 6) return Promise.reject(new Error("Save failed"));
        return Promise.resolve([]);
      }),
    };

    const result = await refitAllParams(db, "user-1");

    // Should still return params despite save failure
    expect(result).not.toBeNull();
    expect(result.version).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[personalization] Failed to save params:",
      expect.objectContaining({ message: "Save failed" }),
    );

    consoleSpy.mockRestore();
  });

  it("handles all fitters rejecting simultaneously", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("All queries fail")),
    };

    // Promise.allSettled catches all rejections
    const result = await refitAllParams(db, "user-1");
    expect(result.version).toBe(1);
    expect(result.ewma).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trimpConstants).toBeNull();
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

    const result = await refitAllParams(db, "user-1");
    // All should be null (either rejected or insufficient data)
    expect(result.ewma).toBeNull();
    expect(result.readinessWeights).toBeNull();
    expect(result.sleepTarget).toBeNull();
    expect(result.stressThresholds).toBeNull();
    expect(result.trimpConstants).toBeNull();
  });

  it("version is always 1", async () => {
    const db = createMockDb([[], [], [], [], []]);
    const result = await refitAllParams(db, "user-1");
    expect(result.version).toBe(1);
  });
});
