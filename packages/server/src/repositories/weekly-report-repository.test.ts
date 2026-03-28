import { describe, expect, it, vi } from "vitest";
import {
  WeekRow,
  type WeekRowData,
  WeeklyReportRepository,
  classifyStrainZone,
} from "./weekly-report-repository.ts";

// ---------------------------------------------------------------------------
// classifyStrainZone
// ---------------------------------------------------------------------------

describe("classifyStrainZone", () => {
  it("returns 'restoring' when ratio is below 0.8", () => {
    expect(classifyStrainZone(70, 100)).toBe("restoring");
    expect(classifyStrainZone(79, 100)).toBe("restoring");
  });

  it("returns 'optimal' when ratio is between 0.8 and 1.3 (inclusive)", () => {
    expect(classifyStrainZone(80, 100)).toBe("optimal");
    expect(classifyStrainZone(100, 100)).toBe("optimal");
    expect(classifyStrainZone(130, 100)).toBe("optimal");
  });

  it("returns 'overreaching' when ratio is above 1.3", () => {
    expect(classifyStrainZone(131, 100)).toBe("overreaching");
    expect(classifyStrainZone(200, 100)).toBe("overreaching");
  });

  it("returns 'optimal' when chronic average load is zero", () => {
    expect(classifyStrainZone(50, 0)).toBe("optimal");
    expect(classifyStrainZone(0, 0)).toBe("optimal");
  });

  it("returns 'optimal' when chronic average load is negative", () => {
    expect(classifyStrainZone(50, -10)).toBe("optimal");
  });
});

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
      chronicAvgLoad: 90,
      prev3wkAvgSleep: 400,
      ...overrides,
    };
  }

  it("exposes weekStart", () => {
    const row = new WeekRow(makeRowData({ weekStart: "2026-03-16" }));
    expect(row.weekStart).toBe("2026-03-16");
  });

  it("exposes avgDailyLoad and chronicAvgLoad", () => {
    const row = new WeekRow(makeRowData({ avgDailyLoad: 100, chronicAvgLoad: 80 }));
    expect(row.avgDailyLoad).toBe(100);
    expect(row.chronicAvgLoad).toBe(80);
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

    it("classifies strain zone", () => {
      const restoring = new WeekRow(
        makeRowData({ avgDailyLoad: 50, chronicAvgLoad: 100 }),
      ).toSummary();
      expect(restoring.strainZone).toBe("restoring");

      const optimal = new WeekRow(
        makeRowData({ avgDailyLoad: 100, chronicAvgLoad: 100 }),
      ).toSummary();
      expect(optimal.strainZone).toBe("optimal");

      const overreaching = new WeekRow(
        makeRowData({ avgDailyLoad: 200, chronicAvgLoad: 100 }),
      ).toSummary();
      expect(overreaching.strainZone).toBe("overreaching");
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
      chronic_avg_load: 85,
      prev_3wk_avg_sleep: 400,
      ...overrides,
    };
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new WeeklyReportRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  it("returns null current and empty history for empty rows", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result).toEqual({ current: null, history: [] });
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
    const { repo } = makeRepository([
      makeDbRow({ avg_sleep_min: 450, prev_3wk_avg_sleep: 400 }),
    ]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current?.sleepPerformancePct).toBe(113);
  });

  it("defaults sleep performance to 100 when prev sleep is null", async () => {
    const { repo } = makeRepository([
      makeDbRow({ avg_sleep_min: 420, prev_3wk_avg_sleep: null }),
    ]);
    const result = await repo.getReport(4, "2026-03-28");
    expect(result.current?.sleepPerformancePct).toBe(100);
  });

  it("calls execute exactly once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getReport(4, "2026-03-28");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
