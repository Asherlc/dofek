import { describe, expect, it, vi } from "vitest";
import { MonthRow, MonthlyReportRepository } from "./monthly-report-repository.ts";

// ---------------------------------------------------------------------------
// MonthRow domain model
// ---------------------------------------------------------------------------

describe("MonthRow", () => {
  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return new MonthRow({
      month_start: "2025-01-01",
      training_hours: 20.456,
      activity_count: 15,
      avg_daily_strain: 42.789,
      avg_sleep_minutes: 437.4,
      avg_resting_hr: 52.34,
      avg_hrv: 68.77,
      ...overrides,
    });
  }

  it("rounds trainingHours to one decimal", () => {
    expect(makeRow({ training_hours: 20.456 }).trainingHours).toBe(20.5);
  });

  it("rounds avgDailyStrain to one decimal", () => {
    expect(makeRow({ avg_daily_strain: 42.789 }).avgDailyStrain).toBe(42.8);
  });

  it("rounds avgSleepMinutes to integer", () => {
    expect(makeRow({ avg_sleep_minutes: 437.4 }).avgSleepMinutes).toBe(437);
  });

  it("rounds avgRestingHr to one decimal", () => {
    expect(makeRow({ avg_resting_hr: 52.34 }).avgRestingHr).toBe(52.3);
  });

  it("rounds avgHrv to one decimal", () => {
    expect(makeRow({ avg_hrv: 68.77 }).avgHrv).toBe(68.8);
  });

  it("returns null for avgRestingHr when null", () => {
    expect(makeRow({ avg_resting_hr: null }).avgRestingHr).toBeNull();
  });

  it("returns null for avgHrv when null", () => {
    expect(makeRow({ avg_hrv: null }).avgHrv).toBeNull();
  });

  it("toSummary without prev returns null trends", () => {
    const summary = makeRow().toSummary();
    expect(summary.trainingHoursTrend).toBeNull();
    expect(summary.avgSleepTrend).toBeNull();
  });

  it("toSummary with prev computes training hours trend", () => {
    const prev = makeRow({ training_hours: 10 });
    const current = makeRow({ training_hours: 12 });
    const summary = current.toSummary(prev);
    // (12 - 10) / 10 = 0.2 = 20%
    expect(summary.trainingHoursTrend).toBe(20);
  });

  it("toSummary with prev computes avg sleep trend", () => {
    const prev = makeRow({ avg_sleep_minutes: 400 });
    const current = makeRow({ avg_sleep_minutes: 420 });
    const summary = current.toSummary(prev);
    // (420 - 400) / 400 = 0.05 = 5%
    expect(summary.avgSleepTrend).toBe(5);
  });

  it("toSummary returns null training trend when prev training is zero", () => {
    const prev = makeRow({ training_hours: 0 });
    const current = makeRow({ training_hours: 10 });
    const summary = current.toSummary(prev);
    expect(summary.trainingHoursTrend).toBeNull();
  });

  it("toSummary returns null sleep trend when prev sleep is zero", () => {
    const prev = makeRow({ avg_sleep_minutes: 0 });
    const current = makeRow({ avg_sleep_minutes: 420 });
    const summary = current.toSummary(prev);
    expect(summary.avgSleepTrend).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MonthlyReportRepository
// ---------------------------------------------------------------------------

describe("MonthlyReportRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new MonthlyReportRepository({ execute }, "user-1");
    return { repo, execute };
  }

  function makeDbRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      month_start: "2025-01-01",
      training_hours: 20,
      activity_count: 15,
      avg_daily_strain: 42,
      avg_sleep_minutes: 437,
      avg_resting_hr: 52,
      avg_hrv: 68,
      ...overrides,
    };
  }

  it("returns null current and empty history for empty rows", async () => {
    const { repo } = makeRepository([]);
    const result = await repo.getReport(6);
    expect(result).toEqual({ current: null, history: [] });
  });

  it("returns single month as current with empty history", async () => {
    const { repo } = makeRepository([makeDbRow({ month_start: "2025-03-01" })]);
    const result = await repo.getReport(6);
    expect(result.current).not.toBeNull();
    expect(result.current?.monthStart).toBe("2025-03-01");
    expect(result.current?.trainingHoursTrend).toBeNull();
    expect(result.current?.avgSleepTrend).toBeNull();
    expect(result.history).toEqual([]);
  });

  it("returns multiple months with trends computed correctly", async () => {
    const { repo } = makeRepository([
      makeDbRow({ month_start: "2025-01-01", training_hours: 10, avg_sleep_minutes: 400 }),
      makeDbRow({ month_start: "2025-02-01", training_hours: 12, avg_sleep_minutes: 420 }),
      makeDbRow({ month_start: "2025-03-01", training_hours: 15, avg_sleep_minutes: 400 }),
    ]);
    const result = await repo.getReport(6);

    expect(result.history).toHaveLength(2);
    expect(result.current?.monthStart).toBe("2025-03-01");

    // First history month has no trend (no predecessor)
    expect(result.history[0]?.trainingHoursTrend).toBeNull();
    expect(result.history[0]?.avgSleepTrend).toBeNull();

    // Second history month: (12 - 10) / 10 = 20%
    expect(result.history[1]?.trainingHoursTrend).toBe(20);
    // (420 - 400) / 400 = 5%
    expect(result.history[1]?.avgSleepTrend).toBe(5);

    // Current: (15 - 12) / 12 = 25%
    expect(result.current?.trainingHoursTrend).toBe(25);
    // (400 - 420) / 420 = -4.8%
    expect(result.current?.avgSleepTrend).toBeCloseTo(-4.8, 1);
  });

  it("preserves null HR and HRV values", async () => {
    const { repo } = makeRepository([
      makeDbRow({ avg_resting_hr: null, avg_hrv: null }),
    ]);
    const result = await repo.getReport(6);
    expect(result.current?.avgRestingHr).toBeNull();
    expect(result.current?.avgHrv).toBeNull();
  });

  it("returns null trend when previous training hours is zero", async () => {
    const { repo } = makeRepository([
      makeDbRow({ month_start: "2025-01-01", training_hours: 0, avg_sleep_minutes: 0 }),
      makeDbRow({ month_start: "2025-02-01", training_hours: 10, avg_sleep_minutes: 420 }),
    ]);
    const result = await repo.getReport(6);
    expect(result.current?.trainingHoursTrend).toBeNull();
    expect(result.current?.avgSleepTrend).toBeNull();
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.getReport(6);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
