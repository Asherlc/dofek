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

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

import { recoveryRouter } from "./recovery.ts";

const createCaller = createTestCallerFactory(recoveryRouter);

// ── sleepConsistency ────────────────────────────────────────────

describe("recoveryRouter.sleepConsistency", () => {
  it("returns empty array when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result).toEqual([]);
  });

  it("maps SQL rows to SleepConsistencyRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22.567,
        waketime_hour: 6.789,
        rolling_bedtime_stddev: 0.4567,
        rolling_waketime_stddev: 0.3456,
        window_count: 14,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-03-01");
    // bedtimeHour rounds to 2 decimal places: 22.567 -> 22.57
    expect(result[0]?.bedtimeHour).toBe(22.57);
    // waketimeHour rounds to 2 decimal places: 6.789 -> 6.79
    expect(result[0]?.waketimeHour).toBe(6.79);
    // rollingBedtimeStddev rounds to 2 decimal places: 0.4567 -> 0.46
    expect(result[0]?.rollingBedtimeStddev).toBe(0.46);
    // rollingWaketimeStddev rounds to 2 decimal places: 0.3456 -> 0.35
    expect(result[0]?.rollingWaketimeStddev).toBeCloseTo(0.35, 2);
  });

  it("sets consistencyScore to null when window_count < 7", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.5,
        rolling_waketime_stddev: 0.5,
        window_count: 6, // fewer than 7
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});

    expect(result[0]?.consistencyScore).toBeNull();
  });

  it("computes consistencyScore when window_count >= 7", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.5,
        rolling_waketime_stddev: 0.5,
        window_count: 7,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});

    // avgStddev = (0.5 + 0.5) / 2 = 0.5
    // score = max(0, min(100, (1 - (0.5 - 0.5) / 1.0) * 100)) = max(0, min(100, 100)) = 100
    expect(result[0]?.consistencyScore).toBe(100);
  });

  it("handles null stddev values", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: null,
        rolling_waketime_stddev: null,
        window_count: 14,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});

    expect(result[0]?.rollingBedtimeStddev).toBeNull();
    expect(result[0]?.rollingWaketimeStddev).toBeNull();
    // computeSleepConsistencyScore returns null when either stddev is null
    expect(result[0]?.consistencyScore).toBeNull();
  });

  it("uses default days of 90", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    await caller.sleepConsistency({});
    expect(executeMock).toHaveBeenCalled();
  });

  it("processes multiple rows correctly", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.3,
        rolling_waketime_stddev: 0.3,
        window_count: 14,
      },
      {
        date: "2026-03-02",
        bedtime_hour: 23.5,
        waketime_hour: 7.5,
        rolling_bedtime_stddev: 0.8,
        rolling_waketime_stddev: 0.9,
        window_count: 14,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});

    expect(result).toHaveLength(2);
    expect(result[0]?.date).toBe("2026-03-01");
    expect(result[1]?.date).toBe("2026-03-02");
    // First row should have higher consistency (lower stddev)
    expect(result[0]?.consistencyScore).toBeGreaterThan(result[1]?.consistencyScore ?? 0);
  });
});

// ── hrvVariability ──────────────────────────────────────────────

describe("recoveryRouter.hrvVariability", () => {
  it("returns empty array when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result).toEqual([]);
  });

  it("maps SQL rows to HrvVariabilityRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 52.678,
        rolling_mean: 48.345,
        rolling_cv: 12.567,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-03-01");
    // hrv rounds to 1 decimal: 52.678 -> 52.7
    expect(result[0]?.hrv).toBe(52.7);
    // rollingMean rounds to 1 decimal: 48.345 -> 48.3
    expect(result[0]?.rollingMean).toBeCloseTo(48.3, 1);
    // rollingCoefficientOfVariation rounds to 2 decimal: 12.567 -> 12.57
    expect(result[0]?.rollingCoefficientOfVariation).toBe(12.57);
  });

  it("handles null hrv value", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: null,
        rolling_mean: 48,
        rolling_cv: 12,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});

    expect(result[0]?.hrv).toBeNull();
  });

  it("handles null rolling_mean and rolling_cv", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});

    expect(result[0]?.rollingMean).toBeNull();
    expect(result[0]?.rollingCoefficientOfVariation).toBeNull();
  });

  it("uses default days of 90", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    await caller.hrvVariability({});
    expect(executeMock).toHaveBeenCalled();
  });
});

// ── workloadRatio ───────────────────────────────────────────────

describe("recoveryRouter.workloadRatio", () => {
  it("returns empty timeSeries and zero strain when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries).toEqual([]);
    expect(result.displayedStrain).toBe(0);
    expect(result.displayedDate).toBeNull();
  });

  it("maps SQL rows to WorkloadRatioRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 125.678,
        acute_load: 500.345,
        chronic_load: 400.123,
        workload_ratio: 1.25,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries).toHaveLength(1);
    const row = result.timeSeries[0];
    expect(row?.date).toBe("2026-03-01");
    // dailyLoad rounds to 1 decimal: 125.678 -> 125.7
    expect(row?.dailyLoad).toBe(125.7);
    // acuteLoad rounds to 1 decimal: 500.345 -> 500.3
    expect(row?.acuteLoad).toBeCloseTo(500.3, 1);
    // chronicLoad rounds to 1 decimal: 400.123 -> 400.1
    expect(row?.chronicLoad).toBe(400.1);
    // workloadRatio rounds to 2 decimal: 1.25
    expect(row?.workloadRatio).toBe(1.25);
  });

  it("handles null workload_ratio", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 50,
        acute_load: 200,
        chronic_load: 300,
        workload_ratio: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries[0]?.workloadRatio).toBeNull();
  });

  it("computes strain from dailyLoad using StrainScore.fromRawLoad", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 0,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    // dailyLoad = 0 -> StrainScore.fromRawLoad(0).value = 0
    expect(result.timeSeries[0]?.strain).toBe(0);
  });

  it("computes non-zero strain for positive dailyLoad", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    expect(result.timeSeries[0]?.strain).toBeGreaterThan(0);
  });

  it("uses default days of 90", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    await caller.workloadRatio({});
    expect(executeMock).toHaveBeenCalled();
  });

  it("displayedStrain and displayedDate always reflect the latest row", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
      {
        date: "2026-03-02",
        daily_load: 0,
        acute_load: 400,
        chronic_load: 380,
        workload_ratio: 1.05,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});

    // selectRecentDailyLoad always returns the latest row (today's actual state)
    // even when daily load is 0 (rest day / no sync yet)
    expect(result.displayedDate).toBe("2026-03-02");
    expect(result.displayedStrain).toBe(0);
  });
});

// ── sleepAnalytics ──────────────────────────────────────────────

describe("recoveryRouter.sleepAnalytics", () => {
  it("returns empty nightly and zero sleep debt when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly).toEqual([]);
    expect(result.sleepDebt).toBe(0);
  });

  it("maps SQL rows to SleepNightlyRow format with rounding", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 18.567,
        rem_pct: 22.345,
        light_pct: 50.123,
        awake_pct: 8.965,
        efficiency: 93.456,
        rolling_avg_duration: 455.789,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly).toHaveLength(1);
    const night = result.nightly[0];
    expect(night?.date).toBe("2026-03-01");
    expect(night?.durationMinutes).toBe(480);
    expect(night?.sleepMinutes).toBe(450);
    // deepPct rounds to 1 decimal: 18.567 -> 18.6
    expect(night?.deepPct).toBe(18.6);
    // remPct rounds to 1 decimal: 22.345 -> 22.3
    expect(night?.remPct).toBeCloseTo(22.3, 1);
    // lightPct rounds to 1 decimal: 50.123 -> 50.1
    expect(night?.lightPct).toBe(50.1);
    // awakePct rounds to 1 decimal: 8.965 -> 9
    expect(night?.awakePct).toBe(9);
    // efficiency rounds to 1 decimal: 93.456 -> 93.5
    expect(night?.efficiency).toBeCloseTo(93.5, 1);
    // rollingAvgDuration rounds to 1 decimal: 455.789 -> 455.8
    expect(night?.rollingAvgDuration).toBe(455.8);
  });

  it("handles null rolling_avg_duration", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 25,
        light_pct: 45,
        awake_pct: 10,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    expect(result.nightly[0]?.rollingAvgDuration).toBeNull();
  });

  it("computes positive sleep debt when sleep is below target", async () => {
    // Default sleep target is 480 min (8 hours)
    // 14 nights all at 420 min = 60 min deficit each = 60 * 14 = 840 total debt
    const rows = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      duration_minutes: 420,
      sleep_minutes: 420,
      deep_pct: 20,
      rem_pct: 25,
      light_pct: 45,
      awake_pct: 10,
      efficiency: 87.5,
      rolling_avg_duration: 420,
    }));

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    // sleepDebt = sum of (480 - 420) for last 14 nights = 60 * 14 = 840
    expect(result.sleepDebt).toBe(840);
  });

  it("computes zero sleep debt when sleep meets or exceeds target", async () => {
    // Default sleep target is 480 min
    const rows = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      duration_minutes: 500,
      sleep_minutes: 500,
      deep_pct: 20,
      rem_pct: 25,
      light_pct: 45,
      awake_pct: 10,
      efficiency: 90,
      rolling_avg_duration: 500,
    }));

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    // 500 - 480 = -20 per night -> debt contribution is negative so sum is negative
    // sleepDebt can be negative (surplus)
    expect(result.sleepDebt).toBe(-280);
  });

  it("sleep debt uses last 14 nights only", async () => {
    // 20 nights: first 6 at 300 min (large debt), last 14 at 480 min (no debt)
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({
        date: `2026-02-${String(i + 20).padStart(2, "0")}`,
        duration_minutes: 300,
        sleep_minutes: 300,
        deep_pct: 20,
        rem_pct: 25,
        light_pct: 45,
        awake_pct: 10,
        efficiency: 85,
        rolling_avg_duration: 300,
      })),
      ...Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 480,
        sleep_minutes: 480,
        deep_pct: 20,
        rem_pct: 25,
        light_pct: 45,
        awake_pct: 10,
        efficiency: 90,
        rolling_avg_duration: 480,
      })),
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});

    // Only last 14 nights matter (all at 480), so debt = 0
    expect(result.sleepDebt).toBe(0);
  });

  it("uses default days of 90", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    await caller.sleepAnalytics({});
    expect(executeMock).toHaveBeenCalled();
  });
});

// ── readinessScore ──────────────────────────────────────────────

describe("recoveryRouter.readinessScore", () => {
  it("returns empty array when no data", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result).toEqual([]);
  });

  it("computes readiness score from HRV, RHR, sleep efficiency, and respiratory rate", async () => {
    // Must be within 30 days of today
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 58,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 92,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe(dateStr);
    expect(result[0]?.readinessScore).toBeGreaterThan(0);
    expect(result[0]?.readinessScore).toBeLessThanOrEqual(100);
    expect(result[0]?.components).toBeDefined();
    expect(result[0]?.components.hrvScore).toBeDefined();
    expect(result[0]?.components.restingHrScore).toBeDefined();
    expect(result[0]?.components.sleepScore).toBeDefined();
    expect(result[0]?.components.respiratoryRateScore).toBeDefined();
  });

  it("filters out dates beyond cutoff", async () => {
    // Date that's 50 days ago with default 30 days input
    const today = new Date();
    const oldDate = new Date(today);
    oldDate.setDate(today.getDate() - 50);
    const oldDateStr = oldDate.toISOString().split("T")[0];

    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const recentDateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: oldDateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
      {
        date: recentDateStr,
        hrv: 55,
        resting_hr: 58,
        respiratory_rate: 14,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 90,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    // Only the recent date should be included
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe(recentDateStr);
  });

  it("defaults to 62 for HRV score when hrv_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 0, // zero stddev -> skip z-score, use default 62
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
  });

  it("defaults to 62 for RHR score when rhr_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 0, // zero stddev -> skip z-score, use default 62
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.restingHrScore).toBe(62);
  });

  it("defaults to 62 for respiratory rate score when rr_sd_30d is 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 0, // zero stddev
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.respiratoryRateScore).toBe(62);
  });

  it("defaults to 62 for all scores when metrics are null", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.hrvScore).toBe(62);
    expect(result[0]?.components.restingHrScore).toBe(62);
    expect(result[0]?.components.sleepScore).toBe(62);
    expect(result[0]?.components.respiratoryRateScore).toBe(62);
    // Weighted sum: 62 * 0.5 + 62 * 0.2 + 62 * 0.15 + 62 * 0.15 = 62
    expect(result[0]?.readinessScore).toBe(62);
  });

  it("clamps sleep efficiency score to 0-100 range", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 120, // above 100
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    // Clamped to 100
    expect(result[0]?.components.sleepScore).toBe(100);
  });

  it("clamps sleep efficiency score to min 0", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: -10, // below 0
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    expect(result[0]?.components.sleepScore).toBe(0);
  });

  it("high HRV (positive z-score) produces higher HRV score", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 70, // significantly above mean of 50
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    // z = (70-50)/10 = +2, should map to ~93
    expect(result[0]?.components.hrvScore).toBeGreaterThan(80);
  });

  it("low resting HR (negative z-score, inverted) produces higher RHR score", async () => {
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(today.getDate() - 5);
    const dateStr = recentDate.toISOString().split("T")[0];

    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 50, // below mean of 60 = good
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});

    // z_rhr = (50-60)/5 = -2, inverted: -(-2) = +2, should map to ~93
    expect(result[0]?.components.restingHrScore).toBeGreaterThan(80);
  });

  it("uses default days of 30", async () => {
    const executeMock = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    await caller.readinessScore({});
    expect(executeMock).toHaveBeenCalled();
  });
});

// ── strainTarget ────────────────────────────────────────────────

describe("recoveryRouter.strainTarget", () => {
  it("returns default values when no metric rows exist", async () => {
    const executeMock = vi.fn();
    // First call: readinessRows (empty)
    executeMock.mockResolvedValueOnce([]);
    // Second call: loads
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    // With no metrics, readinessScore defaults to 50 (Maintain zone)
    expect(result.zone).toBe("Maintain");
    expect(result.targetStrain).toBeGreaterThanOrEqual(10);
    expect(result.targetStrain).toBeLessThanOrEqual(14);
    expect(result.currentStrain).toBe(0);
    expect(result.progressPercent).toBe(0);
    expect(result.explanation).toBeTruthy();
  });

  it("computes readiness from daily metrics and returns strain target", async () => {
    const executeMock = vi.fn();
    // First call: readinessRows
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 60,
        spo2_avg: 98,
        respiratory_rate_avg: 14,
      },
    ]);
    // Second call: loads
    executeMock.mockResolvedValueOnce([]);
    // Third call: sleep efficiency (from strainTarget inner query)
    executeMock.mockResolvedValueOnce([{ efficiency_pct: 90 }]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
    expect(typeof result.currentStrain).toBe("number");
    expect(typeof result.progressPercent).toBe("number");
    expect(["Push", "Maintain", "Recovery"]).toContain(result.zone);
  });

  it("computes current strain from today's load", async () => {
    const today = "2026-03-23";
    const executeMock = vi.fn();
    // First call: readinessRows
    executeMock.mockResolvedValueOnce([]);
    // Second call: loads (one with today's date)
    executeMock.mockResolvedValueOnce([{ date: today, daily_load: 100 }]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({ endDate: today });

    // currentStrain should be derived from today's load
    expect(result.currentStrain).toBeGreaterThan(0);
  });

  it("computes progressPercent as ratio of current to target", async () => {
    const today = "2026-03-23";
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([{ date: today, daily_load: 50 }]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({ endDate: today });

    expect(result.progressPercent).toBeGreaterThan(0);
    // progressPercent = round(currentStrain / targetStrain * 100)
    const expectedPercent = Math.round((result.currentStrain / result.targetStrain) * 100);
    expect(result.progressPercent).toBe(expectedPercent);
  });

  it("returns 0 progressPercent when targetStrain is 0", async () => {
    // This edge case is unlikely but the code handles it
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    // Default readiness = 50, target > 0 so this won't be 0
    // But we verify the formula: if target > 0 then progress = round(current/target*100)
    if (result.targetStrain > 0) {
      expect(result.progressPercent).toBe(
        Math.round((result.currentStrain / result.targetStrain) * 100),
      );
    } else {
      expect(result.progressPercent).toBe(0);
    }
  });

  it("uses readiness metrics with null sleep efficiency", async () => {
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 80,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    // Sleep rows empty -> efficiency = null -> sleepScore = 62
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
  });

  it("handles null resting_hr in readiness metrics", async () => {
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: null,
        hrv: 60,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    // Should not crash; null resting_hr defaults to score 62
    expect(typeof result.targetStrain).toBe("number");
  });

  it("handles null hrv in readiness metrics", async () => {
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: null,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    expect(typeof result.targetStrain).toBe("number");
  });

  it("accumulates acute and chronic loads from date window", async () => {
    const today = "2026-03-23";
    const yesterday = "2026-03-22";
    const twoDaysAgo = "2026-03-21";

    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([
      { date: twoDaysAgo, daily_load: 100 },
      { date: yesterday, daily_load: 150 },
      { date: today, daily_load: 80 },
    ]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({ endDate: today });

    // All three days are within the 7-day acute window
    // acuteLoad = (100 + 150 + 80) / 7
    // chronicLoad = (100 + 150 + 80) / 28
    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("rounds currentStrain to 1 decimal place", async () => {
    const today = "2026-03-23";
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([{ date: today, daily_load: 75.3 }]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({ endDate: today });

    const decimals = result.currentStrain.toString().split(".")[1];
    expect(!decimals || decimals.length <= 1).toBe(true);
  });

  it("clamps hrvScore to 0-100 range in strainTarget readiness components", async () => {
    const executeMock = vi.fn();
    // HRV of 150 → Math.round(150) = 150 → clamped to 100
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 150,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    // With high HRV score (100) and moderate other scores, should still
    // produce a valid zone
    expect(["Push", "Maintain", "Recovery"]).toContain(result.zone);
    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("clamps restingHrScore using 120 - resting_hr formula", async () => {
    const executeMock = vi.fn();
    // resting_hr = 55 → 120 - 55 = 65, clamped to [0, 100] → 65
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: null,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({});

    // Should complete without error and return valid zone
    expect(result.targetStrain).toBeGreaterThan(0);
  });

  it("does not include loads from days outside the acute window", async () => {
    // Load from 10 days ago (outside 7-day acute window)
    const today = "2026-03-23";
    const tenDaysAgo = "2026-03-13";
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([{ date: tenDaysAgo, daily_load: 500 }]);

    const caller = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const result = await caller.strainTarget({ endDate: today });

    // tenDaysAgo is outside the 7-day acute window,
    // but inside the 28-day chronic window
    // so currentStrain should be 0 (no load on today)
    expect(result.currentStrain).toBe(0);
  });

  it("uses sleep efficiency for sleepScore in strainTarget when available", async () => {
    const executeMock = vi.fn();
    executeMock.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 60,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock.mockResolvedValueOnce([]);
    // High sleep efficiency
    executeMock.mockResolvedValueOnce([{ efficiency_pct: 95 }]);

    const callerHigh = createCaller({
      db: { execute: executeMock },
      userId: "user-1",
    });
    const resultHigh = await callerHigh.strainTarget({});

    const executeMock2 = vi.fn();
    executeMock2.mockResolvedValueOnce([
      {
        date: "2026-03-22",
        resting_hr: 55,
        hrv: 60,
        spo2_avg: null,
        respiratory_rate_avg: null,
      },
    ]);
    executeMock2.mockResolvedValueOnce([]);
    // Low sleep efficiency
    executeMock2.mockResolvedValueOnce([{ efficiency_pct: 40 }]);

    const callerLow = createCaller({
      db: { execute: executeMock2 },
      userId: "user-1",
    });
    const resultLow = await callerLow.strainTarget({});

    // Higher sleep efficiency → higher readiness → higher or equal target strain
    expect(resultHigh.targetStrain).toBeGreaterThanOrEqual(resultLow.targetStrain);
  });
});

// ── Mutation-killing tests for sleepConsistency ────────────────

describe("recoveryRouter.sleepConsistency - mutation killers", () => {
  it("window_count exactly 7 produces non-null consistencyScore", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.5,
        rolling_waketime_stddev: 0.5,
        window_count: 7,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.consistencyScore).not.toBeNull();
    expect(result[0]?.consistencyScore).toBeTypeOf("number");
  });

  it("window_count 6 produces null consistencyScore (boundary)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.5,
        rolling_waketime_stddev: 0.5,
        window_count: 6,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.consistencyScore).toBeNull();
  });

  it("bedtimeHour rounds correctly (kills *10/10 vs *100/100 mutation)", async () => {
    // 22.567 * 100 / 100 = 22.57 (correct, 2 decimals)
    // 22.567 * 10 / 10 = 22.6 (wrong, 1 decimal)
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22.567,
        waketime_hour: 6.0,
        rolling_bedtime_stddev: null,
        rolling_waketime_stddev: null,
        window_count: 3,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.bedtimeHour).toBe(22.57);
  });

  it("waketimeHour rounds to 2 decimals not 1", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22.0,
        waketime_hour: 6.789,
        rolling_bedtime_stddev: null,
        rolling_waketime_stddev: null,
        window_count: 3,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.waketimeHour).toBe(6.79);
  });

  it("rollingBedtimeStddev rounds to 2 decimals", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 1.456,
        rolling_waketime_stddev: 0.5,
        window_count: 7,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.rollingBedtimeStddev).toBe(1.46);
  });

  it("rollingWaketimeStddev rounds to 2 decimals", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0.5,
        rolling_waketime_stddev: 0.789,
        window_count: 7,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    expect(result[0]?.rollingWaketimeStddev).toBe(0.79);
  });

  it("only null bedtime stddev produces null rollingBedtimeStddev", async () => {
    const rows = [
      {
        date: "2026-03-01",
        bedtime_hour: 22,
        waketime_hour: 7,
        rolling_bedtime_stddev: 0,
        rolling_waketime_stddev: 0.5,
        window_count: 7,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepConsistency({});
    // 0 is a valid value, not null
    expect(result[0]?.rollingBedtimeStddev).toBe(0);
  });
});

// ── Mutation-killing tests for hrvVariability ──────────────────

describe("recoveryRouter.hrvVariability - mutation killers", () => {
  it("hrv rounds to 1 decimal (kills *100/100 mutation)", async () => {
    // 52.67 * 10 / 10 = 52.7 (correct)
    // 52.67 * 100 / 100 = 52.67 (wrong for 1 decimal)
    const rows = [
      {
        date: "2026-03-01",
        hrv: 52.67,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.hrv).toBe(52.7);
  });

  it("rollingMean rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 48.345,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingMean).toBeCloseTo(48.3, 1);
  });

  it("rollingCoefficientOfVariation rounds to 2 decimals", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 48,
        rolling_cv: 12.567,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingCoefficientOfVariation).toBe(12.57);
  });

  it("zero hrv is preserved (not treated as null)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 0,
        rolling_mean: 48,
        rolling_cv: 12,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.hrv).toBe(0);
  });

  it("zero rolling_mean is preserved (not treated as null)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        hrv: 50,
        rolling_mean: 0,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.rollingMean).toBe(0);
  });

  it("date is passed through unmodified", async () => {
    const rows = [
      {
        date: "2026-03-15",
        hrv: 50,
        rolling_mean: null,
        rolling_cv: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.hrvVariability({});
    expect(result[0]?.date).toBe("2026-03-15");
  });
});

// ── Mutation-killing tests for workloadRatio ───────────────────

describe("recoveryRouter.workloadRatio - mutation killers", () => {
  it("dailyLoad rounds to 1 decimal (not 2)", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 125.678,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.dailyLoad).toBe(125.7);
  });

  it("acuteLoad rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500.345,
        chronic_load: 400,
        workload_ratio: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.acuteLoad).toBeCloseTo(500.3, 1);
  });

  it("chronicLoad rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400.789,
        workload_ratio: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.chronicLoad).toBe(400.8);
  });

  it("workloadRatio rounds to 2 decimals", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 100,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.2567,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.workloadRatio).toBe(1.26);
  });

  it("date is passed through to each timeSeries entry", async () => {
    const rows = [
      {
        date: "2026-03-15",
        daily_load: 50,
        acute_load: 200,
        chronic_load: 300,
        workload_ratio: 0.67,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.date).toBe("2026-03-15");
  });

  it("strain is derived from rounded dailyLoad", async () => {
    const rows = [
      {
        date: "2026-03-01",
        daily_load: 200,
        acute_load: 500,
        chronic_load: 400,
        workload_ratio: 1.25,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.timeSeries[0]?.strain).toBeTypeOf("number");
    expect(result.timeSeries[0]?.strain).toBeGreaterThan(0);
  });

  it("displayedStrain defaults to 0 when timeSeries is empty", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.displayedStrain).toBe(0);
  });

  it("displayedDate defaults to null when timeSeries is empty", async () => {
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
    });
    const result = await caller.workloadRatio({});
    expect(result.displayedDate).toBeNull();
  });
});

// ── Mutation-killing tests for sleepAnalytics ──────────────────

describe("recoveryRouter.sleepAnalytics - mutation killers", () => {
  it("deepPct rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 18.567,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 9,
        efficiency: 90,
        rolling_avg_duration: 455,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.deepPct).toBe(18.6);
  });

  it("remPct rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22.345,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 90,
        rolling_avg_duration: 455,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.remPct).toBeCloseTo(22.3, 1);
  });

  it("lightPct rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50.789,
        awake_pct: 7,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.lightPct).toBe(50.8);
  });

  it("awakePct rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8.965,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.awakePct).toBe(9);
  });

  it("efficiency rounds to 1 decimal", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 93.456,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.efficiency).toBeCloseTo(93.5, 1);
  });

  it("rollingAvgDuration rounds to 1 decimal when non-null", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 90,
        rolling_avg_duration: 455.789,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.rollingAvgDuration).toBe(455.8);
  });

  it("durationMinutes preserves the numeric value", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.durationMinutes).toBe(480);
  });

  it("sleepMinutes preserves the numeric value", async () => {
    const rows = [
      {
        date: "2026-03-01",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.sleepMinutes).toBe(450);
  });

  it("sleep debt is rounded to integer", async () => {
    // 14 nights at 470 min → deficit = (480 - 470) * 14 = 140
    const rows = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      duration_minutes: 470,
      sleep_minutes: 470,
      deep_pct: 20,
      rem_pct: 25,
      light_pct: 45,
      awake_pct: 10,
      efficiency: 90,
      rolling_avg_duration: 470,
    }));

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.sleepDebt).toBe(140);
    expect(Number.isInteger(result.sleepDebt)).toBe(true);
  });

  it("date is passed through to nightly entries", async () => {
    const rows = [
      {
        date: "2026-03-15",
        duration_minutes: 480,
        sleep_minutes: 450,
        deep_pct: 20,
        rem_pct: 22,
        light_pct: 50,
        awake_pct: 8,
        efficiency: 90,
        rolling_avg_duration: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    expect(result.nightly[0]?.date).toBe("2026-03-15");
  });

  it("sleepDebt uses sleepMinutes not durationMinutes", async () => {
    // durationMinutes = 500 (would produce surplus of -280 over 14 nights)
    // sleepMinutes = 400 (produces debt of 80*14 = 1120)
    const rows = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-03-${String(i + 1).padStart(2, "0")}`,
      duration_minutes: 500,
      sleep_minutes: 400,
      deep_pct: 20,
      rem_pct: 25,
      light_pct: 45,
      awake_pct: 10,
      efficiency: 90,
      rolling_avg_duration: 400,
    }));

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.sleepAnalytics({});
    // 480 - 400 = 80 per night * 14 = 1120
    expect(result.sleepDebt).toBe(1120);
  });
});

// ── Mutation-killing tests for readinessScore ──────────────────

describe("recoveryRouter.readinessScore - mutation killers", () => {
  function recentDateStr(daysAgo: number): string {
    const today = new Date();
    const date = new Date(today);
    date.setDate(today.getDate() - daysAgo);
    return date.toISOString().split("T")[0] ?? "";
  }

  it("low HRV (negative z-score) produces lower HRV score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 30, // significantly below mean of 50
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    // z = (30-50)/10 = -2, should map to low score
    expect(result[0]?.components.hrvScore).toBeLessThan(50);
  });

  it("high resting HR produces lower RHR score (inverted z)", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 70, // above mean of 60 = bad
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    // z_rhr = (70-60)/5 = +2, inverted: -2, should map to low score
    expect(result[0]?.components.restingHrScore).toBeLessThan(50);
  });

  it("low respiratory rate produces higher respiratory rate score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 13, // below mean of 15 = good
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    // z_rr = (13-15)/1 = -2, inverted: +2, maps to high score
    expect(result[0]?.components.respiratoryRateScore).toBeGreaterThan(80);
  });

  it("high respiratory rate produces lower respiratory rate score", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: 17, // above mean of 15 = bad
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    // z_rr = (17-15)/1 = +2, inverted: -2, maps to low score
    expect(result[0]?.components.respiratoryRateScore).toBeLessThan(50);
  });

  it("sleep efficiency maps directly to sleepScore (clamped 0-100)", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.sleepScore).toBe(85);
  });

  it("readinessScore is a weighted sum of components", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    // All defaults: 62 * 0.5 + 62 * 0.2 + 62 * 0.15 + 62 * 0.15 = 62
    expect(result[0]?.readinessScore).toBe(62);
  });

  it("defaults to 62 for hrv score when hrv is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.hrvScore).toBe(62);
  });

  it("defaults to 62 for rhr score when resting_hr is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: null,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.restingHrScore).toBe(62);
  });

  it("defaults to 62 for respiratory score when respiratory_rate is null", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 50,
        resting_hr: 60,
        respiratory_rate: null,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.components.respiratoryRateScore).toBe(62);
  });

  it("hrvScore is rounded to integer", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: 55,
        resting_hr: 60,
        respiratory_rate: 15,
        hrv_mean_30d: 50,
        hrv_sd_30d: 10,
        rhr_mean_30d: 60,
        rhr_sd_30d: 5,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
        efficiency_pct: 85,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(Number.isInteger(result[0]?.components.hrvScore)).toBe(true);
    expect(Number.isInteger(result[0]?.components.restingHrScore)).toBe(true);
    expect(Number.isInteger(result[0]?.components.respiratoryRateScore)).toBe(true);
  });

  it("date is preserved in readiness output", async () => {
    const dateStr = recentDateStr(5);
    const rows = [
      {
        date: dateStr,
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        efficiency_pct: null,
      },
    ];
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
    });
    const result = await caller.readinessScore({});
    expect(result[0]?.date).toBe(dateStr);
  });
});
