import { describe, expect, it, vi } from "vitest";
import { WeeklyReportRepository, WeekRow, type WeekRowData } from "./weekly-report-repository.ts";

// ---------------------------------------------------------------------------
// WeekRow
// ---------------------------------------------------------------------------

describe("WeekRow", () => {
  function makeRowData(overrides: Partial<WeekRowData> = {}): WeekRowData {
    return {
      weekStart: "2026-03-23",
      totalHours: 5.67,
      activityCount: 4,
      avgDailyLoad: 85,
      avgSleepMin: 420,
      avgRestingHr: 52.34,
      avgHrv: 65.78,
      prev3wkAvgSleep: 400,
      ...overrides,
    };
  }

  it("exposes weekStart", () => {
    const row = new WeekRow(makeRowData({ weekStart: "2026-03-16" }));
    expect(row.weekStart).toBe("2026-03-16");
  });

  it("exposes avgDailyLoad", () => {
    const row = new WeekRow(makeRowData({ avgDailyLoad: 100 }));
    expect(row.avgDailyLoad).toBe(100);
  });

  describe("toSummary", () => {
    it("rounds trainingHours to 1 decimal", () => {
      const summary = new WeekRow(makeRowData({ totalHours: 5.67 })).toSummary();
      expect(summary.trainingHours).toBe(5.7);
    });

    it("rounds avgDailyLoad to 1 decimal", () => {
      const summary = new WeekRow(makeRowData({ avgDailyLoad: 85.456 })).toSummary();
      expect(summary.avgDailyLoad).toBe(85.5);
    });

    it("computes sleep performance as percentage of prev 3-week average", () => {
      const summary = new WeekRow(
        makeRowData({ avgSleepMin: 420, prev3wkAvgSleep: 400 }),
      ).toSummary();
      expect(summary.sleepPerformancePct).toBe(105);
    });

    it("defaults sleep performance to 100 when prev sleep data is null", () => {
      const summary = new WeekRow(
        makeRowData({ avgSleepMin: 420, prev3wkAvgSleep: null }),
      ).toSummary();
      expect(summary.sleepPerformancePct).toBe(100);
    });

    it("defaults sleep performance to 100 when prev sleep data is zero", () => {
      const summary = new WeekRow(
        makeRowData({ avgSleepMin: 420, prev3wkAvgSleep: 0 }),
      ).toSummary();
      expect(summary.sleepPerformancePct).toBe(100);
    });

    it("handles null avgSleepMin", () => {
      const summary = new WeekRow(
        makeRowData({ avgSleepMin: null, prev3wkAvgSleep: 400 }),
      ).toSummary();
      expect(summary.avgSleepMinutes).toBe(0);
      expect(summary.sleepPerformancePct).toBe(0);
    });

    it("rounds avgRestingHr to 1 decimal", () => {
      const summary = new WeekRow(makeRowData({ avgRestingHr: 52.34 })).toSummary();
      expect(summary.avgRestingHr).toBe(52.3);
    });

    it("preserves null avgRestingHr", () => {
      const summary = new WeekRow(makeRowData({ avgRestingHr: null })).toSummary();
      expect(summary.avgRestingHr).toBeNull();
    });

    it("rounds avgHrv to 1 decimal", () => {
      const summary = new WeekRow(makeRowData({ avgHrv: 65.78 })).toSummary();
      expect(summary.avgHrv).toBe(65.8);
    });

    it("preserves null avgHrv", () => {
      const summary = new WeekRow(makeRowData({ avgHrv: null })).toSummary();
      expect(summary.avgHrv).toBeNull();
    });

    it("sets avgReadiness to 0", () => {
      const summary = new WeekRow(makeRowData()).toSummary();
      expect(summary.avgReadiness).toBe(0);
    });

    it("rounds trainingHours using *10/10 (not other multipliers)", () => {
      // 10.95 * 10 = 109.5, round = 110, / 10 = 11.0
      // 10.95 * 11 = 120.45, round = 120, / 11 = 10.909...
      const summary = new WeekRow(makeRowData({ totalHours: 10.95 })).toSummary();
      expect(summary.trainingHours).toBe(11);
    });

    it("computes sleep performance as exact percentage", () => {
      // 333 / 300 * 100 = 111.0 — verifies the * 100 multiplier
      const summary = new WeekRow(
        makeRowData({ avgSleepMin: 333, prev3wkAvgSleep: 300 }),
      ).toSummary();
      expect(summary.sleepPerformancePct).toBe(111);
    });

    it("returns avgSleepMinutes as rounded integer", () => {
      const summary = new WeekRow(makeRowData({ avgSleepMin: 412.7 })).toSummary();
      expect(summary.avgSleepMinutes).toBe(413);
    });
  });
});

// ---------------------------------------------------------------------------
// WeeklyReportRepository
// ---------------------------------------------------------------------------

describe("WeeklyReportRepository", () => {
  function makeDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      week_start: "2026-03-23",
      total_hours: 5.5,
      activity_count: 3,
      avg_daily_load: 90,
      avg_sleep_min: 420,
      avg_resting_hr: 55,
      avg_hrv: 60,
      prev_3wk_avg_sleep: 400,
      ...overrides,
    };
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const query = vi.fn().mockResolvedValue(rows);
    const sensorStore = {
      query,
      getActivitySummaries: vi.fn(),
      getStream: vi.fn(),
      getHeartRateZoneSeconds: vi.fn(),
      getPowerZoneSeconds: vi.fn(),
      getPowerCurveSamples: vi.fn(),
      getNormalizedPowerSamples: vi.fn(),
      getVo2MaxEstimates: vi.fn(),
      getHeartRateCurveRows: vi.fn(),
      getPaceCurveRows: vi.fn(),
    };
    const repo = new WeeklyReportRepository("user-1", sensorStore);
    return { repo, execute: query };
  }

  it("returns null current and empty history for empty rows", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current).toBeNull();
    expect(result.history).toEqual([]);
    expect(result.emptyState).toEqual(
      expect.objectContaining({
        reportKind: "weekly",
        minimumObservedDays: 1,
      }),
    );
    expect(result.decisionSupport).toBeNull();
  });

  it("returns single week as current with no history", async () => {
    const { repo } = makeRepository([makeDbRow({ week_start: "2026-03-23" })]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current).not.toBeNull();
    expect(result.current?.weekStart).toBe("2026-03-23");
    expect(result.history).toEqual([]);
  });

  it("splits multiple weeks into current (last) and history (rest)", async () => {
    const { repo } = makeRepository([
      makeDbRow({ week_start: "2026-03-09", avg_daily_load: 70 }),
      makeDbRow({ week_start: "2026-03-16", avg_daily_load: 80 }),
      makeDbRow({ week_start: "2026-03-23", avg_daily_load: 90 }),
    ]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current?.weekStart).toBe("2026-03-23");
    expect(result.history).toHaveLength(2);
    expect(result.history[0]?.weekStart).toBe("2026-03-09");
    expect(result.history[1]?.weekStart).toBe("2026-03-16");
    expect(result.decisionSupport?.whatChanged).toHaveLength(2);
  });

  it("trims to the requested number of weeks", async () => {
    const { repo } = makeRepository([
      makeDbRow({ week_start: "2026-03-02" }),
      makeDbRow({ week_start: "2026-03-09" }),
      makeDbRow({ week_start: "2026-03-16" }),
      makeDbRow({ week_start: "2026-03-23" }),
    ]);
    const result = await repo.getReport(2, "2026-03-28");
    expect(result.current?.weekStart).toBe("2026-03-23");
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.weekStart).toBe("2026-03-16");
  });

  it("computes sleep performance from row data", async () => {
    const { repo } = makeRepository([makeDbRow({ avg_sleep_min: 450, prev_3wk_avg_sleep: 400 })]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current?.sleepPerformancePct).toBe(113);
  });

  it("defaults sleep performance to 100 when prev sleep is null", async () => {
    const { repo } = makeRepository([makeDbRow({ avg_sleep_min: 420, prev_3wk_avg_sleep: null })]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current?.sleepPerformancePct).toBe(100);
  });

  it("calls execute exactly once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getReport(4, "2026-03-28");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("queries the requested weeks plus the rolling sleep comparison window", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getReport(2, "2026-03-28");

    expect(execute.mock.calls[0]?.[2]).toEqual({
      userId: "user-1",
      windowStart: "2026-02-14",
      endDate: "2026-03-28",
      totalDays: 42,
    });
  });

  it("ignores ClickHouse join-default zeros when averaging weekly sleep", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getReport(4, "2026-03-28");

    const queryText = execute.mock.calls[0]?.[1] ?? "";
    expect(queryText).toContain("avg(nullIf(sl.duration_minutes, 0)) AS avg_sleep_min");
  });
});
