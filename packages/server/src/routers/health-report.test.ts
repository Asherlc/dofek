import { afterEach, describe, expect, it, vi } from "vitest";
import { createReportEmptyState } from "../contracts/report-empty-state.ts";
import { HealthReportRepository, SharedReport } from "../repositories/health-report-repository.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    publicProcedure: trpc.procedure,
    protectedProcedure: trpc.procedure,
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

import { healthReportRouter } from "./health-report.ts";

const createCaller = createTestCallerFactory(healthReportRouter);

describe("healthReportRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("generate", () => {
    it("generates a weekly snapshot from canonical server data", async () => {
      const canonicalWeek = {
        week_start: "2026-03-22",
        total_hours: 5.55,
        activity_count: 4,
        avg_daily_load: 3.14,
        avg_sleep_min: 480,
        avg_resting_hr: 58.67,
        avg_hrv: 45.33,
        prev_3wk_avg_sleep: 400,
      };
      const generate = vi.spyOn(HealthReportRepository.prototype, "generate").mockResolvedValue(
        new SharedReport({
          id: "report-1",
          shareToken: "abc123",
          reportType: "weekly",
          reportData: {},
          expiresAt: null,
          createdAt: "2026-03-22T00:00:00Z",
        }),
      );
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "America/Los_Angeles",
        sensorStore: makeMockSensorStore([canonicalWeek]),
      });
      const result = await caller.generate({
        reportType: "weekly",
        weeks: 1,
        endDate: "2026-03-24",
      });

      expect(generate).toHaveBeenCalledWith(
        "weekly",
        expect.objectContaining({
          current: {
            weekStart: "2026-03-22",
            trainingHours: 5.6,
            activityCount: 4,
            avgDailyLoad: 3.1,
            avgSleepMinutes: 480,
            sleepPerformancePct: 120,
            avgReadiness: 0,
            avgRestingHr: 58.7,
            avgHrv: 45.3,
          },
          history: [],
          decisionSupport: expect.objectContaining({
            whatChanged: [
              "This is the first observed week, so week-over-week changes are not available yet.",
            ],
            whatToTryNext: [
              "Repeat or deliberately adjust one part of the routine next week, then compare it with this baseline.",
            ],
          }),
          emptyState: createReportEmptyState("weekly"),
        }),
        null,
      );
      expect(result.shareToken).toBe("abc123");
    });

    it("generates a monthly snapshot from canonical server data", async () => {
      const canonicalMonth = {
        month_start: "2026-03-01",
        training_hours: 40.5,
        activity_count: 20,
        avg_daily_strain: 12.3,
        avg_sleep_minutes: 420,
        avg_resting_hr: 55,
        avg_hrv: 48,
      };
      const generate = vi.spyOn(HealthReportRepository.prototype, "generate").mockResolvedValue(
        new SharedReport({
          id: "report-2",
          shareToken: "monthly-token",
          reportType: "monthly",
          reportData: {},
          expiresAt: null,
          createdAt: "2026-03-22T00:00:00Z",
        }),
      );
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "America/Los_Angeles",
        sensorStore: makeMockSensorStore([canonicalMonth]),
      });

      await caller.generate({
        reportType: "monthly",
        months: 6,
        endDate: "2026-03-24",
        expiresInDays: 30,
      });

      expect(generate).toHaveBeenCalledWith(
        "monthly",
        expect.objectContaining({
          current: {
            monthStart: "2026-03-01",
            trainingHours: 40.5,
            activityCount: 20,
            avgDailyStrain: 12.3,
            avgSleepMinutes: 420,
            avgRestingHr: 55,
            avgHrv: 48,
            trainingHoursTrend: null,
            avgSleepTrend: null,
          },
          history: [],
          decisionSupport: expect.objectContaining({
            whatChanged: [
              "This is the first observed month, so month-over-month changes are not available yet.",
            ],
            whatToTryNext: [
              "Repeat or deliberately adjust one part of the routine next month, then compare it with this baseline.",
            ],
          }),
          emptyState: createReportEmptyState("monthly"),
        }),
        30,
      );
    });

    it("rejects arbitrary client-provided report data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const forgedInput = {
        reportType: "weekly" as const,
        weeks: 1,
        endDate: "2026-03-24",
        reportData: { forgedScore: 100 },
      };

      await expect(caller.generate(forgedInput)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("fails clearly when the requested report has no data to share", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });

      await expect(
        caller.generate({
          reportType: "monthly",
          months: 6,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "No monthly report data is available to share.",
      });
    });
  });

  describe("getShared", () => {
    it("returns null when token not found", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.getShared({ token: "nonexistent" });

      expect(result).toBeNull();
    });

    it("returns shared report data for valid token", async () => {
      const row = {
        id: "report-1",
        share_token: "abc123",
        report_type: "weekly",
        report_data: { summary: "test data" },
        expires_at: null,
        created_at: "2026-03-22T00:00:00Z",
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([row]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.getShared({ token: "abc123" });

      expect(result).not.toBeNull();
      expect(result?.reportType).toBe("weekly");
      expect(result?.reportData).toEqual({ summary: "test data" });
    });
  });

  describe("myReports", () => {
    it("returns empty list when no reports", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.myReports();

      expect(result).toEqual([]);
    });

    it("returns list of user reports", async () => {
      const rows = [
        {
          id: "r1",
          share_token: "token1",
          report_type: "weekly",
          expires_at: null,
          created_at: "2026-03-20T00:00:00Z",
        },
        {
          id: "r2",
          share_token: "token2",
          report_type: "healthspan",
          expires_at: null,
          created_at: "2026-03-21T00:00:00Z",
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });
      const result = await caller.myReports();

      expect(result).toHaveLength(2);
      expect(result[0]?.reportType).toBe("weekly");
    });
  });
});
