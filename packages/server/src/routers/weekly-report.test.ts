import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/node", () => ({ captureException: sentry.captureException }));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
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

import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";
import { weeklyReportRouter } from "./weekly-report.ts";

describe("weeklyReportRouter", () => {
  const createCaller = createTestCallerFactory(weeklyReportRouter);

  beforeEach(() => {
    sentry.captureException.mockClear();
  });

  describe("report", () => {
    it("returns empty report when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.report({ weeks: 4, endDate: "2026-03-24" });
      expect(result.current).toBeNull();
      expect(result.history).toEqual([]);
      expect(result.recovery).toEqual({
        range: { startDate: "2026-03-01", endDate: "2026-03-24" },
        emptyMessage:
          "No activity, sleep, or recovery data was found from 2026-03-01 through 2026-03-24. Sync your providers, then retry or review processing alerts.",
      });
    });

    it("reports failures and names the affected weekly range", async () => {
      const failure = new Error("ClickHouse query failed");
      const sensorStore = makeMockSensorStore([]);
      vi.mocked(sensorStore.query).mockRejectedValue(failure);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await expect(caller.report({ weeks: 4, endDate: "2026-03-24" })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        cause: failure,
        message:
          "The weekly report for 2026-03-01 through 2026-03-24 could not be refreshed. Retry now or review processing alerts if the problem continues.",
      });
      expect(sentry.captureException).toHaveBeenCalledWith(failure, {
        tags: { reportType: "weekly" },
        extra: { startDate: "2026-03-01", endDate: "2026-03-24" },
      });
    });

    it("preserves an authored TRPCError unchanged", async () => {
      const failure = new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Weekly report prerequisite missing",
      });
      const sensorStore = makeMockSensorStore([]);
      vi.mocked(sensorStore.query).mockRejectedValue(failure);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await expect(caller.report({ weeks: 4, endDate: "2026-03-24" })).rejects.toBe(failure);
      expect(sentry.captureException).not.toHaveBeenCalled();
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
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: 0,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.avgRestingHr).toBeNull();
      expect(result.current?.avgHrv).toBeNull();
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
          prev_3wk_avg_sleep: 435,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: 437,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
          prev_3wk_avg_sleep: 435,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
      });
      const result = await caller.report({ weeks: 3, endDate: "2026-03-24" });

      // With slice(0, -1): 2 history items. With slice(0, +1): only 1.
      expect(result.history).toHaveLength(2);
      expect(result.history[0]?.weekStart).toBe("2026-03-03");
      expect(result.history[1]?.weekStart).toBe("2026-03-10");
      expect(result.current?.weekStart).toBe("2026-03-17");
    });

    it("uses the current Sunday-start week on Tuesday instead of falling back to last week", async () => {
      const rows = [
        {
          week_start: "2026-05-17",
          total_hours: 4,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 420,
          avg_resting_hr: 60,
          avg_hrv: 45,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-05-24",
          total_hours: 2,
          activity_count: 3,
          avg_daily_load: 0.5,
          avg_sleep_min: 390,
          avg_resting_hr: 62,
          avg_hrv: 40,
          prev_3wk_avg_sleep: 420,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
      });

      const result = await caller.report({ weeks: 2, endDate: "2026-05-26" });

      expect(result.current?.weekStart).toBe("2026-05-24");
      expect(result.current?.activityCount).toBe(3);
      expect(result.history).toHaveLength(1);
      expect(result.history[0]?.weekStart).toBe("2026-05-17");
    });

    it("groups weekly rows by Sunday-start weeks", async () => {
      const rows = [
        {
          week_start: "2026-03-15",
          total_hours: 4,
          activity_count: 2,
          avg_daily_load: 1,
          avg_sleep_min: 420,
          avg_resting_hr: 60,
          avg_hrv: 45,
          prev_3wk_avg_sleep: 420,
        },
        {
          week_start: "2026-03-22",
          total_hours: 1,
          activity_count: 1,
          avg_daily_load: 0.5,
          avg_sleep_min: 390,
          avg_resting_hr: 62,
          avg_hrv: 40,
          prev_3wk_avg_sleep: 420,
        },
      ];
      const sensorStore = makeMockSensorStore(rows);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      const result = await caller.report({ weeks: 2, endDate: "2026-03-22" });

      expect(result.current?.weekStart).toBe("2026-03-22");
      expect(result.history[0]?.weekStart).toBe("2026-03-15");
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).toContain("toStartOfWeek(d.date, 0)");
      expect(queryText).not.toContain("toMonday(d.date)");
    });

    it("counts all ended activities while training load only uses rows with average heart rate", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.report({ weeks: 1, endDate: "2026-05-26" });

      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).not.toContain("AND avg_hr IS NOT NULL");
      expect(queryText).toContain("* asum.avg_hr / nullIf(toFloat64(asum.max_hr), 0)");
      expect(queryText).toContain("toInt32(count()) AS count");
      expect(queryText).toContain("sumIf(load, load IS NOT NULL) AS load");
    });

    it("ignores ClickHouse join-default zeros when averaging weekly sleep and vitals", async () => {
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.report({ weeks: 1, endDate: "2026-05-26" });

      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1] ?? "";
      expect(queryText).toContain("avg(nullIf(sl.duration_minutes, 0)) AS avg_sleep_min");
      expect(queryText).toContain("avg(nullIf(m.resting_hr, 0)) AS avg_resting_hr");
      expect(queryText).toContain("avg(nullIf(m.hrv, 0)) AS avg_hrv");
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
          prev_3wk_avg_sleep: 450,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
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
      expect(currentWeek?.activityCount).toBe(5);
    });

    it("uses default weeks (12) when not specified", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      // Should not throw — default weeks (12) is applied
      const result = await caller.report({ endDate: "2026-03-24" });
      expect(result.current).toBeNull();
      expect(result.history).toEqual([]);
    });

    it("rejects weeks below 1", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      await expect(caller.report({ weeks: 0, endDate: "2026-03-24" })).rejects.toThrow();
    });

    it("rejects weeks above 52", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      await expect(caller.report({ weeks: 53, endDate: "2026-03-24" })).rejects.toThrow();
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
          prev_3wk_avg_sleep: null,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      // With || 0: avgDailyLoad = 2.5. With && 0: avgDailyLoad = 0.
      expect(result.current?.avgDailyLoad).toBe(2.5);
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
          prev_3wk_avg_sleep: 400,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore(rows),
      });
      const result = await caller.report({ weeks: 1, endDate: "2026-03-24" });
      expect(result.current?.sleepPerformancePct).toBe(90);
    });
  });
});
