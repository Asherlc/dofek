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

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(
    async (
      db: { execute: (query: unknown) => Promise<unknown[]> },
      _schema: unknown,
      query: unknown,
    ) => db.execute(query),
  ),
}));

import { strengthRouter } from "./strength.ts";
import { stressRouter } from "./stress.ts";

// ── Strength Router ──

describe("strengthRouter", () => {
  const createCaller = createTestCallerFactory(strengthRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
  }

  describe("volumeOverTime", () => {
    it("returns weekly volume", async () => {
      const rows = [{ week: "2024-01-15", total_volume_kg: 5000, set_count: 50, workout_count: 3 }];
      const caller = makeCaller(rows);
      const result = await caller.volumeOverTime({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.totalVolumeKg).toBe(5000);
      expect(result[0]?.workoutCount).toBe(3);
    });
  });

  describe("estimatedOneRepMax", () => {
    it("groups entries by exercise", async () => {
      const rows = [
        {
          exercise_name: "Bench Press",
          workout_date: "2024-01-15",
          estimated_max: 100,
          actual_weight: 80,
          actual_reps: 8,
        },
        {
          exercise_name: "Bench Press",
          workout_date: "2024-01-22",
          estimated_max: 105,
          actual_weight: 85,
          actual_reps: 7,
        },
        {
          exercise_name: "Squat",
          workout_date: "2024-01-15",
          estimated_max: 140,
          actual_weight: 120,
          actual_reps: 5,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.estimatedOneRepMax({ days: 90 });

      expect(result).toHaveLength(2);
      const bench = result.find((r) => r.exerciseName === "Bench Press");
      expect(bench?.history).toHaveLength(2);
    });

    it("returns empty for no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.estimatedOneRepMax({ days: 90 });
      expect(result).toEqual([]);
    });
  });

  describe("muscleGroupVolume", () => {
    it("groups by muscle group", async () => {
      const rows = [
        { muscle_group: "chest", week: "2024-01-15", sets: 12 },
        { muscle_group: "chest", week: "2024-01-22", sets: 14 },
        { muscle_group: "back", week: "2024-01-15", sets: 15 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.muscleGroupVolume({ days: 90 });

      expect(result).toHaveLength(2);
      const chest = result.find((r) => r.muscleGroup === "chest");
      expect(chest?.weeklyData).toHaveLength(2);
    });
  });

  describe("progressiveOverload", () => {
    it("computes regression slope for exercises", async () => {
      const rows = [
        { exercise_name: "Squat", week: "2024-01-08", weekly_volume: 3000 },
        { exercise_name: "Squat", week: "2024-01-15", weekly_volume: 3200 },
        { exercise_name: "Squat", week: "2024-01-22", weekly_volume: 3400 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.progressiveOverload({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.isProgressing).toBe(true);
      expect(result[0]?.slopeKgPerWeek).toBeGreaterThan(0);
    });

    it("filters exercises with fewer than 2 weeks", async () => {
      const rows = [{ exercise_name: "Curl", week: "2024-01-15", weekly_volume: 500 }];
      const caller = makeCaller(rows);
      const result = await caller.progressiveOverload({ days: 90 });
      expect(result).toEqual([]);
    });
  });

  describe("workoutSummary", () => {
    it("returns workout summaries", async () => {
      const rows = [
        {
          date: "2024-01-15",
          name: "Push Day",
          exercise_count: 5,
          total_sets: 20,
          total_volume_kg: 4000,
          duration_minutes: 65,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.workoutSummary({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Push Day");
      expect(result[0]?.durationMinutes).toBe(65);
    });
  });
});

// ── Stress Router ──

describe("stressRouter", () => {
  const createCaller = createTestCallerFactory(stressRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
  }

  describe("scores", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.scores({ days: 90 });

      expect(result.daily).toEqual([]);
      expect(result.weekly).toEqual([]);
      expect(result.latestScore).toBeNull();
      expect(result.trend).toBe("stable");
    });

    it("computes stress from elevated HR and depressed HRV", async () => {
      const rows = [
        {
          date: "2024-01-15",
          hrv: 40,
          resting_hr: 65,
          hrv_mean_60d: 60,
          hrv_sd_60d: 8,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 75,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.scores({ days: 90 });

      expect(result.daily).toHaveLength(1);
      // HRV well below baseline + HR above baseline + poor sleep => high stress
      expect(result.daily[0]?.stressScore).toBeGreaterThan(0);
      expect(result.daily[0]?.hrvDeviation).toBeLessThan(0);
      expect(result.daily[0]?.restingHrDeviation).toBeGreaterThan(0);
    });

    it("computes zero stress for optimal metrics", async () => {
      const rows = [
        {
          date: "2024-01-15",
          hrv: 65,
          resting_hr: 52,
          hrv_mean_60d: 60,
          hrv_sd_60d: 8,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 95,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.scores({ days: 90 });

      // HRV above baseline, HR below baseline, great sleep => low/no stress
      expect(result.daily[0]?.stressScore).toBeLessThanOrEqual(0.3);
    });

    it("computes weekly aggregation", async () => {
      // Create 7 days in same week
      const rows = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date("2024-01-15"); // Monday
        d.setDate(d.getDate() + i);
        rows.push({
          date: d.toISOString().slice(0, 10),
          hrv: 50 - i * 3,
          resting_hr: 58 + i,
          hrv_mean_60d: 60,
          hrv_sd_60d: 8,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 85,
        });
      }
      const caller = makeCaller(rows);
      const result = await caller.scores({ days: 90 });

      expect(result.weekly.length).toBeGreaterThan(0);
      expect(result.weekly[0]).toHaveProperty("cumulativeStress");
      expect(result.weekly[0]).toHaveProperty("avgDailyStress");
    });

    it("detects improving trend", async () => {
      const rows = [];
      // First 7 days: high stress
      for (let i = 0; i < 7; i++) {
        const d = new Date("2024-01-01");
        d.setDate(d.getDate() + i);
        rows.push({
          date: d.toISOString().slice(0, 10),
          hrv: 35,
          resting_hr: 68,
          hrv_mean_60d: 60,
          hrv_sd_60d: 8,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 70,
        });
      }
      // Next 7 days: no stress
      for (let i = 7; i < 14; i++) {
        const d = new Date("2024-01-01");
        d.setDate(d.getDate() + i);
        rows.push({
          date: d.toISOString().slice(0, 10),
          hrv: 70,
          resting_hr: 50,
          hrv_mean_60d: 60,
          hrv_sd_60d: 8,
          rhr_mean_60d: 55,
          rhr_sd_60d: 3,
          efficiency_pct: 95,
        });
      }
      const caller = makeCaller(rows);
      const result = await caller.scores({ days: 90 });

      expect(result.trend).toBe("improving");
    });
  });
});
