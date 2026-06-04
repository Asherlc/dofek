import { describe, expect, it, vi } from "vitest";
import {
  createTestCallerFactory,
  dateDaysBefore,
  metricRow,
  sleepBaselineRow,
} from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
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

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

type SleepTestRow = {
  date: string;
  duration_minutes: number;
  hrv?: number | null;
  deep_minutes?: number | null;
  rem_minutes?: number | null;
  light_minutes?: number | null;
  awake_minutes?: number | null;
  efficiency_pct?: number | null;
};

function sleepRowsForClickHouse(rows: SleepTestRow[]) {
  return rows.map((row) => ({
    date: row.date,
    started_at: `${row.date}T04:00:00Z`,
    ended_at: `${row.date}T12:00:00Z`,
    duration_minutes: row.duration_minutes,
    deep_minutes: row.deep_minutes ?? 0,
    rem_minutes: row.rem_minutes ?? 0,
    light_minutes: row.light_minutes ?? row.duration_minutes,
    awake_minutes: row.awake_minutes ?? 0,
    efficiency_pct: row.efficiency_pct ?? 90,
  }));
}

function hrvRowsAfterSleep(rows: SleepTestRow[]) {
  return rows
    .filter((row) => row.hrv !== undefined)
    .map((row) => ({
      date: dateDaysBefore(row.date, -1),
      hrv: row.hrv ?? null,
    }));
}

function makeSensorStore(
  dailyLoads: Array<{ metric_date: string; daily_load: number }> = [],
  yesterdayLoad = 0,
  baselineSleepRows: SleepTestRow[] = [],
  lastNightSleepRows: SleepTestRow[] = baselineSleepRows,
): SensorStore {
  const query = vi.fn();
  query.mockResolvedValueOnce(dailyLoads);
  query.mockResolvedValueOnce([{ load: yesterdayLoad }]);
  query.mockResolvedValueOnce([]);
  query.mockResolvedValueOnce(sleepRowsForClickHouse(baselineSleepRows));
  query.mockResolvedValueOnce(sleepRowsForClickHouse(lastNightSleepRows));
  query.mockResolvedValueOnce(sleepRowsForClickHouse(baselineSleepRows));
  query.mockResolvedValue([]);
  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

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

vi.mock("../repositories/training-recommendation.ts", () => ({
  computeComponentScores: vi.fn(() => ({
    hrvScore: 62,
    restingHrScore: 62,
    sleepScore: 62,
    respiratoryRateScore: 62,
  })),
  computeReadinessScore: vi.fn(() => 62),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../logger.ts";
import {
  computeComponentScores,
  computeReadinessScore,
} from "../repositories/training-recommendation.ts";
import { isRecent, mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

describe("mobileDashboard.dashboard", () => {
  it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.dashboard({ endDate: "2026-03-28" })).rejects.toThrow(
      "mobileDashboard.dashboard requires the ClickHouse activity analytics store",
    );
  });

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
      sensorStore: makeSensorStore(),
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

  it("does not compute daily strain from rolling acute load when today is a rest day", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([
      metricRow({ date: "2026-03-28" }),
      metricRow({ date: "2026-03-27" }),
    ]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([
        { metric_date: "2026-03-28", daily_load: 0 },
        { metric_date: "2026-03-27", daily_load: 350 },
      ]),
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBe(0);
    expect(result.strain.acuteLoad).toBe(350);
  });

  it("returns zero daily strain when today has no activity load", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([{ metric_date: "2026-03-28", daily_load: 0 }]),
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBe(0);
  });

  it("computes daily strain from today's raw activity load", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([{ metric_date: "2026-03-28", daily_load: 50 }]),
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBe(10.9);
    expect(result.strain.acuteLoad).toBe(50);
  });

  it("computes strain windows, rounded workload ratio, and latest metric date", async () => {
    const execute = vi.fn();
    const rows = Array.from({ length: 29 }, (_, index) =>
      metricRow({ date: dateDaysBefore("2026-03-28", index) }),
    );
    const dailyLoads = Array.from({ length: 29 }, (_, index) => ({
      metric_date: dateDaysBefore("2026-03-28", index),
      daily_load: index < 28 ? 10 : 1000,
    }));
    execute.mockResolvedValueOnce(rows);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(dailyLoads),
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
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    const lastNightSleepRows: SleepTestRow[] = [
      {
        date: "2026-03-28",
        duration_minutes: 480,
        deep_minutes: 120,
        rem_minutes: 96,
        light_minutes: 240,
        awake_minutes: 24,
      },
    ];
    const baselineSleepRows = [
      ...lastNightSleepRows,
      sleepBaselineRow("2026-03-27", 420, 80, 50),
      sleepBaselineRow("2026-03-26", 450, 80),
      sleepBaselineRow("2026-03-25", 480, 80),
      sleepBaselineRow("2026-03-24", 510, 80),
      sleepBaselineRow("2026-03-23", 540, 80),
      sleepBaselineRow("2026-03-22", 570, 80),
      sleepBaselineRow("2026-03-21", 600, 80),
      sleepBaselineRow("2026-03-20", 630, 80),
    ];
    execute.mockResolvedValueOnce(hrvRowsAfterSleep(baselineSleepRows));

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 50, baselineSleepRows, lastNightSleepRows),
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
    expect(result.sleep?.sleepDebt).toBe(285);
    expect(result.sleepNeed).toEqual(
      expect.objectContaining({
        baselineMinutes: 525,
        strainDebtMinutes: 10,
        accumulatedDebtMinutes: 285,
        totalNeedMinutes: 606,
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

  it("fetches dashboard sleep nights once and reuses them for readiness, last night, and sleep need", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    const sleepRows = [
      sleepBaselineRow("2026-03-28", 480, 80),
      sleepBaselineRow("2026-03-27", 420, 80, 50),
      sleepBaselineRow("2026-03-26", 450, 80),
      sleepBaselineRow("2026-03-25", 480, 80),
      sleepBaselineRow("2026-03-24", 510, 80),
      sleepBaselineRow("2026-03-23", 540, 80),
      sleepBaselineRow("2026-03-22", 570, 80),
      sleepBaselineRow("2026-03-21", 600, 80),
      sleepBaselineRow("2026-03-20", 630, 80),
    ];
    execute.mockResolvedValueOnce(hrvRowsAfterSleep(sleepRows));

    const sensorStore = makeSensorStore([], 50, sleepRows);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    const sleepQueryCallCount = vi
      .mocked(sensorStore.query)
      .mock.calls.filter((call) => String(call[1]).includes("analytics.v_sleep")).length;
    expect(sleepQueryCallCount).toBe(1);
    expect(result.sleep?.lastNight?.date).toBe("2026-03-28");
    expect(result.sleepNeed?.canRecommend).toBe(true);
  });

  it("logs dashboard timing breakdowns for performance diagnosis", async () => {
    vi.mocked(logger.info).mockClear();
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining("[mobile-dashboard] dashboard timings"),
    );
  });

  it("builds sleep need from exactly seven high-HRV nights", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    const baselineSleepRows = [
      sleepBaselineRow("2026-03-27", 420, 80, 0),
      sleepBaselineRow("2026-03-26", 450, 80),
      sleepBaselineRow("2026-03-25", 480, 80),
      sleepBaselineRow("2026-03-24", 510, 80),
      sleepBaselineRow("2026-03-23", 540, 80),
      sleepBaselineRow("2026-03-22", 570, 80),
      sleepBaselineRow("2026-03-21", 600, 80),
      sleepBaselineRow("2026-03-20", 0, 80),
      sleepBaselineRow("2026-03-19", 1000, null),
      sleepBaselineRow("2026-03-18", 1000, 10),
    ];
    execute.mockResolvedValueOnce(hrvRowsAfterSleep(baselineSleepRows));

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 0, baselineSleepRows),
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.sleepNeed).toEqual(
      expect.objectContaining({
        baselineMinutes: 510,
        strainDebtMinutes: 0,
        accumulatedDebtMinutes: 690,
        totalNeedMinutes: 683,
        canRecommend: true,
      }),
    );
  });

  it("does not return default sleep coach numbers when no sleep rows exist", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.readiness).toBeNull();
    expect(result.sleep?.lastNight).toBeNull();
    expect(result.sleepNeed).toBeNull();
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
