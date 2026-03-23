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
  });
});
