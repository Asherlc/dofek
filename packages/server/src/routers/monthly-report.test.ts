import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
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

import { monthlyReportRouter } from "./monthly-report.ts";

const createCaller = createTestCallerFactory(monthlyReportRouter);

describe("monthlyReportRouter", () => {
  describe("report", () => {
    it("returns empty result when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current).toBeNull();
      expect(result.history).toEqual([]);
    });

    it("returns monthly summaries from SQL results", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 40.5,
          activity_count: 20,
          avg_daily_strain: 12.3,
          avg_sleep_minutes: 420,
          avg_resting_hr: 55,
          avg_hrv: 48,
        },
        {
          month_start: "2026-02-01",
          training_hours: 38.2,
          activity_count: 18,
          avg_daily_strain: 11.8,
          avg_sleep_minutes: 435,
          avg_resting_hr: 53,
          avg_hrv: 50,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.history).toHaveLength(1);
      expect(result.current).not.toBeNull();
      expect(result.current?.monthStart).toBe("2026-02-01");
      expect(result.current?.trainingHours).toBe(38.2);
      expect(result.current?.activityCount).toBe(18);
      expect(result.current?.avgSleepMinutes).toBe(435);
    });

    it("computes month-over-month trends", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 30,
          activity_count: 15,
          avg_daily_strain: 10,
          avg_sleep_minutes: 400,
          avg_resting_hr: 60,
          avg_hrv: 45,
        },
        {
          month_start: "2026-02-01",
          training_hours: 40,
          activity_count: 20,
          avg_daily_strain: 12,
          avg_sleep_minutes: 420,
          avg_resting_hr: 55,
          avg_hrv: 50,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current).not.toBeNull();
      // Training hours went up: 30 → 40 = +33.3%
      expect(result.current?.trainingHoursTrend).toBeCloseTo(33.3, 0);
      // Sleep went up: 400 → 420 = +5%
      expect(result.current?.avgSleepTrend).toBeCloseTo(5, 0);
    });

    it("uses default months of 6", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      await caller.report({});
      expect(executeMock).toHaveBeenCalled();
    });

    // ── Additional tests for mutation coverage ──

    it("first month has null trends (no previous month to compare)", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 30,
          activity_count: 15,
          avg_daily_strain: 10,
          avg_sleep_minutes: 400,
          avg_resting_hr: 60,
          avg_hrv: 45,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current).not.toBeNull();
      expect(result.current?.trainingHoursTrend).toBeNull();
      expect(result.current?.avgSleepTrend).toBeNull();
    });

    it("handles null avg_resting_hr and avg_hrv", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 10,
          activity_count: 5,
          avg_daily_strain: 5,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current).not.toBeNull();
      expect(result.current?.avgRestingHr).toBeNull();
      expect(result.current?.avgHrv).toBeNull();
    });

    it("handles non-null avg_resting_hr and avg_hrv with rounding", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 10,
          activity_count: 5,
          avg_daily_strain: 5.678,
          avg_sleep_minutes: 432.7,
          avg_resting_hr: 55.55,
          avg_hrv: 48.78,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current).not.toBeNull();
      // avgDailyStrain rounds to 1 decimal: 5.678 -> 5.7
      expect(result.current?.avgDailyStrain).toBe(5.7);
      // avgSleepMinutes rounds to integer: 432.7 -> 433
      expect(result.current?.avgSleepMinutes).toBe(433);
      // avgRestingHr rounds to 1 decimal: 55.55 -> 55.6
      expect(result.current?.avgRestingHr).toBeCloseTo(55.6, 1);
      // avgHrv rounds to 1 decimal: 48.78 -> 48.8
      expect(result.current?.avgHrv).toBeCloseTo(48.8, 1);
    });

    it("trainingHours rounds to 1 decimal place", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 25.678,
          activity_count: 10,
          avg_daily_strain: 8,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      // 25.678 -> rounded to 1 decimal -> 25.7
      expect(result.current?.trainingHours).toBe(25.7);
    });

    it("trend is null when previous training hours is 0 (avoid division by zero)", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 0,
          activity_count: 0,
          avg_daily_strain: 0,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
        {
          month_start: "2026-02-01",
          training_hours: 10,
          activity_count: 5,
          avg_daily_strain: 5,
          avg_sleep_minutes: 420,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      // prev training hours = 0 -> trend is null (no division by zero)
      expect(result.current?.trainingHoursTrend).toBeNull();
    });

    it("sleep trend is null when previous avg sleep is 0", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 10,
          activity_count: 5,
          avg_daily_strain: 5,
          avg_sleep_minutes: 0,
          avg_resting_hr: null,
          avg_hrv: null,
        },
        {
          month_start: "2026-02-01",
          training_hours: 12,
          activity_count: 6,
          avg_daily_strain: 6,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current?.avgSleepTrend).toBeNull();
    });

    it("negative trends computed correctly (decrease)", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 40,
          activity_count: 20,
          avg_daily_strain: 12,
          avg_sleep_minutes: 450,
          avg_resting_hr: null,
          avg_hrv: null,
        },
        {
          month_start: "2026-02-01",
          training_hours: 30,
          activity_count: 15,
          avg_daily_strain: 10,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      // Training hours: (30 - 40) / 40 = -25%
      expect(result.current?.trainingHoursTrend).toBeCloseTo(-25, 0);
      // Sleep: (400 - 450) / 450 ≈ -11.1%
      expect(result.current?.avgSleepTrend).toBeCloseTo(-11.1, 0);
    });

    it("current is last element and history excludes it", async () => {
      const rows = [
        {
          month_start: "2025-11-01",
          training_hours: 20,
          activity_count: 10,
          avg_daily_strain: 8,
          avg_sleep_minutes: 400,
          avg_resting_hr: 60,
          avg_hrv: 45,
        },
        {
          month_start: "2025-12-01",
          training_hours: 25,
          activity_count: 12,
          avg_daily_strain: 9,
          avg_sleep_minutes: 410,
          avg_resting_hr: 58,
          avg_hrv: 47,
        },
        {
          month_start: "2026-01-01",
          training_hours: 30,
          activity_count: 15,
          avg_daily_strain: 10,
          avg_sleep_minutes: 420,
          avg_resting_hr: 55,
          avg_hrv: 50,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current?.monthStart).toBe("2026-01-01");
      expect(result.history).toHaveLength(2);
      expect(result.history[0]?.monthStart).toBe("2025-11-01");
      expect(result.history[1]?.monthStart).toBe("2025-12-01");
    });

    it("second month in history also computes trends from first month", async () => {
      const rows = [
        {
          month_start: "2025-11-01",
          training_hours: 20,
          activity_count: 10,
          avg_daily_strain: 8,
          avg_sleep_minutes: 400,
          avg_resting_hr: 60,
          avg_hrv: 45,
        },
        {
          month_start: "2025-12-01",
          training_hours: 30,
          activity_count: 15,
          avg_daily_strain: 9,
          avg_sleep_minutes: 440,
          avg_resting_hr: 58,
          avg_hrv: 47,
        },
        {
          month_start: "2026-01-01",
          training_hours: 40,
          activity_count: 20,
          avg_daily_strain: 10,
          avg_sleep_minutes: 420,
          avg_resting_hr: 55,
          avg_hrv: 50,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      // First in history has null trends
      expect(result.history[0]?.trainingHoursTrend).toBeNull();
      // Second in history: (30 - 20) / 20 = 50%
      expect(result.history[1]?.trainingHoursTrend).toBeCloseTo(50, 0);
      // Current: (40 - 30) / 30 ≈ 33.3%
      expect(result.current?.trainingHoursTrend).toBeCloseTo(33.3, 0);
    });

    it("activityCount is converted to number", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 10,
          activity_count: "7", // string from DB
          avg_daily_strain: 5,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      expect(result.current?.activityCount).toBe(7);
      expect(typeof result.current?.activityCount).toBe("number");
    });

    it("trend rounding: rounds to 1 decimal (e.g., 33.33... -> 33.3)", async () => {
      const rows = [
        {
          month_start: "2026-01-01",
          training_hours: 30,
          activity_count: 10,
          avg_daily_strain: 8,
          avg_sleep_minutes: 400,
          avg_resting_hr: null,
          avg_hrv: null,
        },
        {
          month_start: "2026-02-01",
          training_hours: 40,
          activity_count: 12,
          avg_daily_strain: 9,
          avg_sleep_minutes: 450,
          avg_resting_hr: null,
          avg_hrv: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.report({ months: 6 });

      // (40 - 30) / 30 * 1000 / 10 = 33.333... -> Math.round(333.33)/10 = 33.3
      expect(result.current?.trainingHoursTrend).toBe(33.3);
      // (450 - 400) / 400 * 1000 / 10 = 12.5
      expect(result.current?.avgSleepTrend).toBe(12.5);
    });
  });
});
