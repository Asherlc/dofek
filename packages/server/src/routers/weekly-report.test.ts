import { describe, expect, it, vi } from "vitest";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
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

import { createTestCallerFactory } from "./test-helpers.ts";
import { classifyStrainZone, weeklyReportRouter } from "./weekly-report.ts";

describe("classifyStrainZone", () => {
  it("returns 'optimal' when chronicAvgLoad is 0", () => {
    expect(classifyStrainZone(50, 0)).toBe("optimal");
  });

  it("returns 'optimal' when chronicAvgLoad is negative", () => {
    expect(classifyStrainZone(50, -10)).toBe("optimal");
  });

  it("returns 'restoring' when ratio is below 0.8", () => {
    // ratio = 30 / 100 = 0.3
    expect(classifyStrainZone(30, 100)).toBe("restoring");
  });

  it("returns 'overreaching' when ratio is above 1.3", () => {
    // ratio = 140 / 100 = 1.4
    expect(classifyStrainZone(140, 100)).toBe("overreaching");
  });

  it("returns 'optimal' when ratio is between 0.8 and 1.3", () => {
    // ratio = 100 / 100 = 1.0
    expect(classifyStrainZone(100, 100)).toBe("optimal");
  });

  it("returns 'optimal' when ratio is exactly 0.8 (boundary)", () => {
    // ratio = 80 / 100 = 0.8 → not < 0.8, so falls through to optimal
    expect(classifyStrainZone(80, 100)).toBe("optimal");
  });

  it("returns 'optimal' when ratio is exactly 1.3 (boundary)", () => {
    // ratio = 130 / 100 = 1.3 → not > 1.3, so falls through to optimal
    expect(classifyStrainZone(130, 100)).toBe("optimal");
  });

  it("returns 'restoring' when ratio is just below 0.8", () => {
    // ratio = 79 / 100 = 0.79
    expect(classifyStrainZone(79, 100)).toBe("restoring");
  });

  it("returns 'overreaching' when ratio is just above 1.3", () => {
    // ratio = 131 / 100 = 1.31
    expect(classifyStrainZone(131, 100)).toBe("overreaching");
  });

  it("returns 'optimal' when weekAvgLoad is 0 and chronicAvgLoad > 0", () => {
    // ratio = 0 / 100 = 0 → < 0.8 → restoring
    expect(classifyStrainZone(0, 100)).toBe("restoring");
  });

  it("returns 'optimal' when both loads are 0", () => {
    // chronicAvgLoad <= 0 → short-circuits to optimal
    expect(classifyStrainZone(0, 0)).toBe("optimal");
  });

  it("handles very small chronicAvgLoad", () => {
    // ratio = 50 / 0.001 = 50000 → overreaching
    expect(classifyStrainZone(50, 0.001)).toBe("overreaching");
  });

  it("handles negative weekAvgLoad with positive chronicAvgLoad", () => {
    // ratio = -10 / 100 = -0.1 → < 0.8 → restoring
    expect(classifyStrainZone(-10, 100)).toBe("restoring");
  });
});

describe("weeklyReportRouter", () => {
  const createCaller = createTestCallerFactory(weeklyReportRouter);

  describe("report", () => {
    it("returns empty report when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 4, endDate: "2026-03-24" });
      expect(result.current).toBeNull();
      expect(result.history).toEqual([]);
    });

    it("asserts correct trainingHours rounding", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 5.55,
          activity_count: 4,
          avg_daily_load: 3.14,
          avg_sleep_min: 480,
          avg_resting_hr: 58.67,
          avg_hrv: 45.33,
          chronic_avg_load: 3.0,
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });

      expect(result.current).not.toBeNull();
      // Kills * 10 / 10 → * 10 * 10 and / 10 → * 10 arithmetic mutations
      expect(result.current?.trainingHours).toBe(5.6);
      expect(result.current?.avgDailyLoad).toBe(3.1);
      expect(result.current?.activityCount).toBe(4);
      expect(result.current?.weekStart).toBe("2026-03-17");
    });

    it("computes sleepPerformancePct from prev3wkSleep", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 480,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });

      // 480 / 400 * 100 = 120 (kills prev3wkSleep null check and > 0 mutations)
      expect(result.current?.sleepPerformancePct).toBe(120);
      expect(result.current?.avgSleepMinutes).toBe(480);
    });

    it("defaults sleepPerformancePct to 100 when prev3wkSleep is null", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 480,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.sleepPerformancePct).toBe(100);
    });

    it("defaults sleepPerformancePct to 100 when prev3wkSleep is 0", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 480,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      // prev3wkSleep > 0 is false (it's 0), so defaults to 100
      expect(result.current?.sleepPerformancePct).toBe(100);
    });

    it("rounds avgRestingHr and avgHrv", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: null,
          avg_resting_hr: 58.67,
          avg_hrv: 45.33,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.avgRestingHr).toBe(58.7);
      expect(result.current?.avgHrv).toBe(45.3);
    });

    it("returns null for avgRestingHr and avgHrv when db returns null", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: null,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.avgRestingHr).toBeNull();
      expect(result.current?.avgHrv).toBeNull();
    });

    it("classifies strainZone correctly from load values", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 10,
          activity_count: 5,
          avg_daily_load: 8,
          avg_sleep_min: 420,
          avg_resting_hr: 55,
          avg_hrv: 50,
          chronic_avg_load: 5,
          prev_3wk_avg_sleep: 420,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      // 8 / 5 = 1.6 > 1.3 → overreaching
      expect(result.current?.strainZone).toBe("overreaching");
    });

    it("splits current and history correctly", async () => {
      const rows = [
        {
          week_start: "2026-03-03",
          total_hours: 3,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 420,
          avg_resting_hr: 60,
          avg_hrv: 45,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-10",
          total_hours: 5,
          activity_count: 4,
          avg_daily_load: 2,
          avg_sleep_min: 450,
          avg_resting_hr: 58,
          avg_hrv: 48,
          chronic_avg_load: 1.5,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-17",
          total_hours: 7,
          activity_count: 5,
          avg_daily_load: 3,
          avg_sleep_min: 480,
          avg_resting_hr: 56,
          avg_hrv: 50,
          chronic_avg_load: 2,
          prev_3wk_avg_sleep: 435,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 3, endDate: "2026-03-24" });
      expect(result.current?.weekStart).toBe("2026-03-17");
      expect(result.history).toHaveLength(2);
      expect(result.history[0]?.weekStart).toBe("2026-03-03");
      expect(result.history[1]?.weekStart).toBe("2026-03-10");
    });

    it("handles avgSleepMin of 0 when avg_sleep_min is null", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: null,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      // null avg_sleep_min → avgSleepMin = 0
      expect(result.current?.avgSleepMinutes).toBe(0);
    });

    it("slices parsed to requested weeks (kills slice removal mutant)", async () => {
      // Return 5 weeks of data but request only 2 — proves slice(-input.weeks) works
      const rows = [
        {
          week_start: "2026-02-17",
          total_hours: 1,
          activity_count: 1,
          avg_daily_load: 0.5,
          avg_sleep_min: 400,
          avg_resting_hr: 62,
          avg_hrv: 40,
          chronic_avg_load: 0.5,
          prev_3wk_avg_sleep: 400,
        },
        {
          week_start: "2026-02-24",
          total_hours: 2,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 420,
          avg_resting_hr: 60,
          avg_hrv: 42,
          chronic_avg_load: 0.8,
          prev_3wk_avg_sleep: 400,
        },
        {
          week_start: "2026-03-03",
          total_hours: 3,
          activity_count: 3,
          avg_daily_load: 1.5,
          avg_sleep_min: 440,
          avg_resting_hr: 58,
          avg_hrv: 44,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 410,
        },
        {
          week_start: "2026-03-10",
          total_hours: 4,
          activity_count: 4,
          avg_daily_load: 2,
          avg_sleep_min: 450,
          avg_resting_hr: 57,
          avg_hrv: 46,
          chronic_avg_load: 1.3,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-17",
          total_hours: 5,
          activity_count: 5,
          avg_daily_load: 2.5,
          avg_sleep_min: 460,
          avg_resting_hr: 55,
          avg_hrv: 48,
          chronic_avg_load: 1.5,
          prev_3wk_avg_sleep: 437,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 2, endDate: "2026-03-24" });

      // Only 2 weeks returned (last 2 of 5)
      expect(result.current?.weekStart).toBe("2026-03-17");
      expect(result.history).toHaveLength(1);
      expect(result.history[0]?.weekStart).toBe("2026-03-10");
    });

    it("history uses slice(0,-1) not slice(0,+1) (kills unary mutant)", async () => {
      // 3 rows, weeks=3 → current = last, history = first 2
      const rows = [
        {
          week_start: "2026-03-03",
          total_hours: 3,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 420,
          avg_resting_hr: 60,
          avg_hrv: 45,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-10",
          total_hours: 5,
          activity_count: 4,
          avg_daily_load: 2,
          avg_sleep_min: 450,
          avg_resting_hr: 58,
          avg_hrv: 48,
          chronic_avg_load: 1.5,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-17",
          total_hours: 7,
          activity_count: 5,
          avg_daily_load: 3,
          avg_sleep_min: 480,
          avg_resting_hr: 56,
          avg_hrv: 50,
          chronic_avg_load: 2,
          prev_3wk_avg_sleep: 435,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 3, endDate: "2026-03-24" });

      // With slice(0, -1): 2 history items. With slice(0, +1): only 1.
      expect(result.history).toHaveLength(2);
      expect(result.history[0]?.weekStart).toBe("2026-03-03");
      expect(result.history[1]?.weekStart).toBe("2026-03-10");
      expect(result.current?.weekStart).toBe("2026-03-17");
    });

    it("verifies full computed values for a single week (kills || 0, rounding, null-check mutants)", async () => {
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 7.777,
          activity_count: 5,
          avg_daily_load: 4.56,
          avg_sleep_min: 465,
          avg_resting_hr: 57.89,
          avg_hrv: 52.14,
          chronic_avg_load: 3.78,
          prev_3wk_avg_sleep: 450,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      const currentWeek = result.current;
      expect(currentWeek).not.toBeNull();

      // trainingHours: Math.round(7.777 * 10) / 10 = Math.round(77.77) / 10 = 78 / 10 = 7.8
      expect(currentWeek?.trainingHours).toBe(7.8);
      // avgDailyLoad: Math.round(4.56 * 10) / 10 = Math.round(45.6) / 10 = 46 / 10 = 4.6
      expect(currentWeek?.avgDailyLoad).toBe(4.6);
      // avgSleepMinutes: Math.round(465) = 465
      expect(currentWeek?.avgSleepMinutes).toBe(465);
      // sleepPerformancePct: Math.round((465 / 450) * 100) = Math.round(103.33) = 103
      expect(currentWeek?.sleepPerformancePct).toBe(103);
      // avgRestingHr: Math.round(57.89 * 10) / 10 = Math.round(578.9) / 10 = 579 / 10 = 57.9
      expect(currentWeek?.avgRestingHr).toBe(57.9);
      // avgHrv: Math.round(52.14 * 10) / 10 = Math.round(521.4) / 10 = 521 / 10 = 52.1
      expect(currentWeek?.avgHrv).toBe(52.1);
      // strainZone: 4.56 / 3.78 = 1.206 → between 0.8 and 1.3 → optimal
      expect(currentWeek?.strainZone).toBe("optimal");
      expect(currentWeek?.activityCount).toBe(5);
    });

    it("uses avgDailyLoad || 0 correctly when avg_daily_load is non-zero (kills && mutant)", async () => {
      // With `Number(row.avg_daily_load) && 0`, a non-zero value becomes 0
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 5,
          activity_count: 3,
          avg_daily_load: 2.5,
          avg_sleep_min: 420,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 2.5,
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      // With || 0: avgDailyLoad = 2.5. With && 0: avgDailyLoad = 0.
      expect(result.current?.avgDailyLoad).toBe(2.5);
      // strainZone depends on avgDailyLoad: 2.5 / 2.5 = 1.0 → optimal
      // With && 0: 0 / 0 → chronicAvgLoad <= 0 → optimal (same). So test strainZone + load.
      expect(result.current?.strainZone).toBe("optimal");
    });

    it("computes sleepPerformancePct using division not multiplication (kills / → * mutant)", async () => {
      // sleepPerformancePct = Math.round((avgSleepMin / prev3wkSleep) * 100)
      // With /: (360 / 400) * 100 = 90
      // With *: (360 * 400) * 100 = 14400000
      const rows = [
        {
          week_start: "2026-03-17",
          total_hours: 3,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 360,
          avg_resting_hr: null,
          avg_hrv: null,
          chronic_avg_load: 1,
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.sleepPerformancePct).toBe(90);
    });
  });
});
