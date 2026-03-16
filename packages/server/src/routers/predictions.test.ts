import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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

vi.mock("../insights/engine.ts", () => ({
  joinByDate: vi.fn(() => []),
}));

vi.mock("../ml/features.ts", () => ({
  getPredictionTarget: vi.fn((id: string) => {
    if (id === "hrv") return { id: "hrv", label: "HRV", unit: "ms" };
    return null;
  }),
  PREDICTION_TARGETS: [{ id: "hrv", label: "HRV", unit: "ms" }],
}));

vi.mock("../ml/activity-features.ts", () => ({
  ACTIVITY_PREDICTION_TARGETS: [
    { id: "avg_power", label: "Average Power", unit: "W", activityType: "cardio" },
    { id: "total_volume", label: "Total Volume", unit: "kg", activityType: "strength" },
  ],
  buildActivityDataset: vi.fn(() => null),
  buildDailyContext: vi.fn(),
}));

vi.mock("../ml/predictor.ts", () => ({
  trainPredictor: vi.fn(() => ({
    predictions: [],
    model: { r2: 0.5 },
  })),
  trainFromDataset: vi.fn(() => ({
    predictions: [],
    model: { r2: 0.6 },
  })),
}));

import { predictionsRouter } from "./predictions.ts";

const createCaller = createTestCallerFactory(predictionsRouter);

describe("predictionsRouter", () => {
  describe("targets", () => {
    it("returns available prediction targets", async () => {
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.targets();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty("id");
      expect(result[0]).toHaveProperty("label");
      expect(result[0]).toHaveProperty("type");
    });
  });

  describe("predict", () => {
    it("trains a daily prediction for known target", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });
      const result = await caller.predict({ target: "hrv", days: 365 });

      expect(result).not.toBeNull();
      // Should call execute 5 times for the 5 parallel queries
      expect(execute).toHaveBeenCalledTimes(5);
    });

    it("returns null for unknown target", async () => {
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.predict({ target: "unknown_target", days: 365 });
      expect(result).toBeNull();
    });

    it("handles cardio activity target", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });
      const result = await caller.predict({ target: "avg_power", days: 365 });

      // buildActivityDataset returns null so result is null
      expect(result).toBeNull();
    });

    it("handles strength activity target", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute },
        userId: "user-1",
      });
      const result = await caller.predict({ target: "total_volume", days: 365 });
      expect(result).toBeNull();
    });
  });
});
