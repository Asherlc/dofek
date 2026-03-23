import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null; timezone: string }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { bodyAnalyticsRouter } from "./body-analytics.ts";

const createCaller = createTestCallerFactory(bodyAnalyticsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("bodyAnalyticsRouter", () => {
  describe("smoothedWeight", () => {
    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.smoothedWeight({ days: 90 });
      expect(result).toEqual([]);
    });

    it("applies EWMA smoothing to weight data", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80 },
        { date: "2024-01-02", weight_kg: 81 },
        { date: "2024-01-03", weight_kg: 79 },
        { date: "2024-01-04", weight_kg: 80.5 },
        { date: "2024-01-05", weight_kg: 80 },
        { date: "2024-01-06", weight_kg: 80.2 },
        { date: "2024-01-07", weight_kg: 80.1 },
        { date: "2024-01-08", weight_kg: 79.8 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.smoothedWeight({ days: 90 });

      expect(result).toHaveLength(8);
      expect(result[0]?.rawWeight).toBe(80);
      expect(result[0]?.smoothedWeight).toBe(80);
      // Smoothed should differ from raw after first point
      expect(result[1]?.smoothedWeight).not.toBe(result[1]?.rawWeight);
      // Weekly change should be null for first 7 entries, defined for 8th
      expect(result[6]?.weeklyChange).toBeNull();
      expect(result[7]?.weeklyChange).toBeDefined();
      expect(result[7]?.weeklyChange).not.toBeNull();
    });
  });

  describe("recomposition", () => {
    it("returns empty array when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.recomposition({ days: 180 });
      expect(result).toEqual([]);
    });

    it("calculates fat and lean mass from weight and body fat", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80, body_fat_pct: 20 },
        { date: "2024-01-02", weight_kg: 80, body_fat_pct: 19.5 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.recomposition({ days: 180 });

      expect(result).toHaveLength(2);
      expect(result[0]?.fatMassKg).toBe(16);
      expect(result[0]?.leanMassKg).toBe(64);
      // Smoothed should equal raw for first entry
      expect(result[0]?.smoothedFatMass).toBe(16);
      expect(result[0]?.smoothedLeanMass).toBe(64);
    });
  });

  describe("weightTrend", () => {
    it("returns insufficient when less than 7 data points", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: 80 },
        { date: "2024-01-02", weight_kg: 80.5 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("insufficient");
      expect(result.currentWeekly).toBeNull();
      expect(result.current4Week).toBeNull();
    });

    it("calculates weight trend with sufficient data", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80 + i * 0.1,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).not.toBe("insufficient");
      expect(result.currentWeekly).not.toBeNull();
    });

    it("detects gaining trend", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80 + i * 2, // large gain
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("gaining");
    });

    it("detects stable trend", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, "0")}`,
        weight_kg: 80,
      }));
      const caller = makeCaller(rows);
      const result = await caller.weightTrend({});

      expect(result.trend).toBe("stable");
    });
  });
});
