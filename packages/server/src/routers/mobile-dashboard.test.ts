import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
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
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("../repositories/training-repository.ts", () => ({
  computeComponentScores: vi.fn(() => ({
    hrvScore: 62,
    restingHrScore: 62,
    sleepScore: 62,
    respiratoryRateScore: 62,
  })),
  computeReadinessScore: vi.fn(() => 62),
  TrainingRepository: class {
    getNextWorkoutData() {
      return Promise.resolve(null);
    }

    getRecommendation() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../repositories/anomaly-detection-repository.ts", () => ({
  AnomalyDetectionRepository: class {
    check() {
      return Promise.resolve(null);
    }
  },
}));

import {
  computeComponentScores,
  computeReadinessScore,
} from "../repositories/training-repository.ts";
import { isRecent, mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

describe("mobileDashboard.dashboard", () => {
  it("identifies only today and yesterday as recent", () => {
    expect(isRecent("2026-03-28", "2026-03-28")).toBe(true);
    expect(isRecent("2026-03-27", "2026-03-28")).toBe(true);
    expect(isRecent("2026-03-26", "2026-03-28")).toBe(false);
    expect(isRecent("2026-03-29", "2026-03-28")).toBe(false);
  });

  it("passes derived resting heart rate into readiness scoring", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([
      metricRow({
        date: "2026-03-28",
        hrv: 64,
        resting_hr: 52,
        respiratory_rate: 14,
        hrv_mean_30d: 58,
        hrv_sd_30d: 5,
        rhr_mean_30d: 55,
        rhr_sd_30d: 4,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
      }),
    ]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(computeComponentScores).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-03-28",
        hrv: 64,
        resting_hr: 52,
        respiratory_rate: 14,
        hrv_mean_30d: 58,
        hrv_sd_30d: 5,
        rhr_mean_30d: 55,
        rhr_sd_30d: 4,
        rr_mean_30d: 15,
        rr_sd_30d: 1,
      }),
      null,
    );
    expect(computeReadinessScore).toHaveBeenCalled();
    expect(result.readiness).toEqual(
      expect.objectContaining({
        score: 62,
        date: "2026-03-28",
        components: {
          hrvScore: 62,
          restingHrScore: 62,
          sleepScore: 62,
          respiratoryRateScore: 62,
        },
      }),
    );
  });

  it("computes daily strain from rolling acute load when today is a rest day", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([
      metricRow({ date: "2026-03-28", daily_load: 0 }),
      metricRow({ date: "2026-03-27", daily_load: 350 }),
    ]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBeGreaterThan(0);
    expect(result.strain.acuteLoad).toBe(350);
  });

  it("computes strain windows, rounded workload ratio, and latest metric date", async () => {
    const execute = vi.fn();
    const rows = Array.from({ length: 29 }, (_, index) =>
      metricRow({
        date: dateDaysBefore("2026-03-28", index),
        daily_load: index < 28 ? 10 : 1000,
      }),
    );
    execute.mockResolvedValueOnce(rows);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.acuteLoad).toBe(70);
    expect(result.strain.chronicLoad).toBe(70);
    expect(result.strain.workloadRatio).toBe(1);
    expect(result.strain.date).toBe("2026-03-28");
    expect(result.latestDate).toBe("2026-03-28");
  });

  it("builds sleep need from high-HRV nights and recent sleep debt", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28", daily_load: 0 })]);
    execute.mockResolvedValueOnce([
      {
        date: "2026-03-28",
        duration_minutes: 480,
        deep_pct: 25,
        rem_pct: 20,
        light_pct: 50,
        awake_pct: 5,
      },
    ]);
    execute.mockResolvedValueOnce([
      sleepBaselineRow("2026-03-27", 420, 80, 50),
      sleepBaselineRow("2026-03-26", 450, 80),
      sleepBaselineRow("2026-03-25", 480, 80),
      sleepBaselineRow("2026-03-24", 510, 80),
      sleepBaselineRow("2026-03-23", 540, 80),
      sleepBaselineRow("2026-03-22", 570, 80),
      sleepBaselineRow("2026-03-21", 600, 80),
      sleepBaselineRow("2026-03-20", 630, 80),
    ]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.sleep?.lastNight).toEqual({
      date: "2026-03-28",
      durationMinutes: 480,
      deepPct: 25,
      remPct: 20,
      lightPct: 50,
      awakePct: 5,
    });
    expect(result.sleep?.sleepDebt).toBe(240);
    expect(result.sleepNeed).toEqual(
      expect.objectContaining({
        baselineMinutes: 525,
        strainDebtMinutes: 10,
        accumulatedDebtMinutes: 240,
        totalNeedMinutes: 595,
        canRecommend: true,
      }),
    );
    expect(result.sleepNeed?.recentNights).toHaveLength(7);
    expect(result.sleepNeed?.recentNights[0]).toEqual({
      date: "2026-03-21",
      actualMinutes: 600,
      neededMinutes: 525,
      debtMinutes: 0,
    });
    expect(result.sleepNeed?.recentNights[6]).toEqual({
      date: "2026-03-27",
      actualMinutes: 420,
      neededMinutes: 525,
      debtMinutes: 105,
    });
  });

  it("returns null dashboard sections when no metric or sleep rows exist", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.readiness).toBeNull();
    expect(result.sleep?.lastNight).toBeNull();
    expect(result.sleepNeed).toEqual(
      expect.objectContaining({
        baselineMinutes: 480,
        strainDebtMinutes: 0,
        accumulatedDebtMinutes: 0,
        totalNeedMinutes: 480,
        canRecommend: false,
      }),
    );
    expect(result.strain).toEqual({
      dailyStrain: 0,
      acuteLoad: 0,
      chronicLoad: 0,
      workloadRatio: null,
      date: null,
    });
    expect(result.latestDate).toBeNull();
  });
});

function metricRow(
  overrides: Partial<{
    date: string;
    hrv: number | null;
    resting_hr: number | null;
    respiratory_rate: number | null;
    efficiency_pct: number | null;
    hrv_mean_30d: number | null;
    hrv_sd_30d: number | null;
    rhr_mean_30d: number | null;
    rhr_sd_30d: number | null;
    rr_mean_30d: number | null;
    rr_sd_30d: number | null;
    daily_load: number;
  }> = {},
) {
  return {
    date: "2026-03-28",
    hrv: null,
    resting_hr: null,
    respiratory_rate: null,
    efficiency_pct: null,
    hrv_mean_30d: null,
    hrv_sd_30d: null,
    rhr_mean_30d: null,
    rhr_sd_30d: null,
    rr_mean_30d: null,
    rr_sd_30d: null,
    daily_load: 0,
    ...overrides,
  };
}

function sleepBaselineRow(date: string, durationMinutes: number, hrv: number | null, load = 0) {
  return {
    date,
    duration_minutes: durationMinutes,
    hrv,
    yesterday_load: load,
  };
}

function dateDaysBefore(dateString: string, daysBefore: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}
