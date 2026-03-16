import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

// Import scoring functions directly by testing the exported router behavior
// But first, let's test the utility functions by importing them
// The healthspan.ts file exports scoring functions indirectly through the router.
// We test them via the router behavior.

vi.mock("../../trpc.ts", async () => {
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

vi.mock("../../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(async (db: { execute: () => Promise<unknown[]> }) => db.execute()),
}));

import { healthspanRouter } from "../healthspan.ts";

const createCaller = createTestCallerFactory(healthspanRouter);

describe("healthspanRouter", () => {
  describe("score", () => {
    it("returns default score when no data", async () => {
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.score({ weeks: 12 });

      expect(result.healthspanScore).toBe(50);
      expect(result.biologicalAge).toBeNull();
      expect(result.chronologicalAge).toBeNull();
      expect(result.paceOfAging).toBeNull();
      expect(result.metrics).toEqual([]);
      expect(result.history).toEqual([]);
    });

    it("computes healthspan score from metrics", async () => {
      const rows = [
        {
          birth_date: "1990-01-01",
          avg_sleep_min: 480,
          bedtime_stddev_min: 20,
          avg_resting_hr: 55,
          avg_steps: 10000,
          latest_vo2max: 50,
          weekly_aerobic_min: 200,
          weekly_high_intensity_min: 80,
          sessions_per_week: 3,
          weight_kg: 75,
          body_fat_pct: 15,
          weekly_history: [
            { week_start: "2024-01-01", avg_rhr: 55, avg_steps: 10000, avg_vo2max: 50 },
            { week_start: "2024-01-08", avg_rhr: 54, avg_steps: 10500, avg_vo2max: 50 },
            { week_start: "2024-01-15", avg_rhr: 53, avg_steps: 11000, avg_vo2max: 51 },
            { week_start: "2024-01-22", avg_rhr: 52, avg_steps: 11500, avg_vo2max: 51 },
          ],
        },
      ];
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.score({ weeks: 12 });

      // All metrics are excellent, so score should be high
      expect(result.healthspanScore).toBeGreaterThan(70);
      expect(result.metrics).toHaveLength(9);
      expect(result.biologicalAge).not.toBeNull();
      expect(result.chronologicalAge).not.toBeNull();
      expect(result.history).toHaveLength(4);
      expect(result.paceOfAging).not.toBeNull();
    });

    it("handles null metrics gracefully", async () => {
      const rows = [
        {
          birth_date: null,
          avg_sleep_min: null,
          bedtime_stddev_min: null,
          avg_resting_hr: null,
          avg_steps: null,
          latest_vo2max: null,
          weekly_aerobic_min: null,
          weekly_high_intensity_min: null,
          sessions_per_week: null,
          weight_kg: null,
          body_fat_pct: null,
          weekly_history: null,
        },
      ];
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.score({ weeks: 12 });

      // All null metrics default to score 50
      expect(result.healthspanScore).toBe(50);
      expect(result.biologicalAge).toBeNull();
      expect(result.paceOfAging).toBeNull();
    });

    it("computes biological age adjustment", async () => {
      const rows = [
        {
          birth_date: "1990-01-01",
          avg_sleep_min: 480,
          bedtime_stddev_min: 10,
          avg_resting_hr: 48,
          avg_steps: 12000,
          latest_vo2max: 55,
          weekly_aerobic_min: 350,
          weekly_high_intensity_min: 160,
          sessions_per_week: 4,
          weight_kg: 70,
          body_fat_pct: 12,
          weekly_history: null,
        },
      ];
      const caller = createCaller({
        // @ts-expect-error mock DB
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.score({ weeks: 12 });

      // Very healthy metrics => biological age should be younger than chronological
      // @ts-expect-error mock type assertion
      expect(result.biologicalAge).toBeLessThan(result.chronologicalAge);
    });
  });
});
