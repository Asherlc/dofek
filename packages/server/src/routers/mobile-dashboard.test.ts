import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestCallerFactory,
  dateDaysBefore,
  metricRow,
  sleepBaselineRow,
} from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../services/dashboard-overview.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/dashboard-overview.ts")>();
  return {
    ...original,
    loadDashboardOverview: vi.fn(original.loadDashboardOverview),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

type SleepTestRow = {
  date: string;
  duration_minutes: number | null;
  hrv?: number | null;
  deep_minutes?: number | null;
  rem_minutes?: number | null;
  light_minutes?: number | null;
  awake_minutes?: number | null;
  efficiency_pct?: number | null;
  staging_available?: boolean;
};

type RecoverySummaryTestRow = {
  date: string;
  hrv?: number | null;
  hrv_score?: number | null;
  resting_hr_score?: number | null;
  sleep_score?: number | null;
  respiratory_rate_score?: number | null;
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
    staging_available: row.staging_available ?? true,
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
  _lastNightSleepRows: SleepTestRow[] = baselineSleepRows,
  recoveryRows: RecoverySummaryTestRow[] = [],
): SensorStore {
  const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
    const querySql = String(queryText);
    if (querySql.includes("analytics.daily_strain") && querySql.includes("coalesce")) {
      return [{ load: yesterdayLoad }];
    }
    if (querySql.includes("analytics.daily_strain")) return dailyLoads;
    if (querySql.includes("analytics.daily_recovery")) return recoveryRows;
    if (querySql.includes("analytics.daily_sleep")) {
      return sleepRowsForClickHouse(baselineSleepRows);
    }
    return [];
  });
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
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
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

import { loadPersonalizedParams } from "dofek/personalization/storage";
import { logger } from "../logger.ts";
import { computeReadinessScore } from "../repositories/training-recommendation.ts";
import { isRecent, loadDashboardOverview } from "../services/dashboard-overview.ts";
import { mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

describe("mobileDashboard.dashboardV2", () => {
  it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.dashboardV2({ endDate: "2026-03-28" })).rejects.toThrow(
      "mobileDashboard.dashboardV2 requires the ClickHouse activity analytics store",
    );
  });

  it("returns only the unavailable sleep-need variant when the prior night is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    const result = await caller.dashboardV2({ endDate: "2026-03-28" });

    expect(result.sleepNeed).toEqual({
      availability: "missing_previous_night",
      message: "Sync last night's sleep data to see tonight's sleep need.",
    });
    expect(result.sleepNeed).not.toHaveProperty("totalNeedMinutes");
    expect(result.sleepNeed).not.toHaveProperty("recentNights");
  });

  it("uses full access when the context has no access window", async () => {
    vi.mocked(loadDashboardOverview).mockClear();
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    await caller.dashboardV2({ endDate: "2026-03-28" });

    expect(loadDashboardOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        accessWindow: { kind: "full" },
      }),
    );
  });

  it("logs the elapsed dashboardV2 time", async () => {
    vi.mocked(logger.info).mockClear();
    const performanceNow = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1246);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    try {
      await caller.dashboardV2({ endDate: "2026-03-28" });

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "[mobile-dashboard] dashboardV2 timings userId=user-1 endDate=2026-03-28 total=246ms",
      );
    } finally {
      performanceNow.mockRestore();
    }
  });

  it("returns the available projection with server-computed debt recovery", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 0, [
        {
          date: "2026-03-27",
          duration_minutes: 420,
        },
      ]),
    });

    const result = await caller.dashboardV2({ endDate: "2026-03-28" });

    expect(result.sleepNeed).toMatchObject({
      availability: "available",
      accumulatedDebtMinutes: 60,
      debtRecoveryMinutes: 15,
      totalNeedMinutes: 495,
    });
  });
});

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

  it("passes precomputed readiness component scores into readiness scoring", async () => {
    const execute = vi.fn();
    const recoveryRows = [
      {
        date: "2026-03-28",
        hrv: 64,
        hrv_score: 72,
        resting_hr_score: 68,
        sleep_score: 80,
        respiratory_rate_score: 74,
      },
    ];

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 0, [], [], recoveryRows),
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(computeReadinessScore).toHaveBeenCalledWith(
      {
        hrvScore: 72,
        restingHrScore: 68,
        sleepScore: 80,
        respiratoryRateScore: 74,
      },
      expect.any(Object),
      true,
    );
    expect(result.readiness).toEqual(
      expect.objectContaining({
        score: 62,
        date: "2026-03-28",
        components: {
          hrvScore: 72,
          restingHrScore: 68,
          sleepScore: 80,
          respiratoryRateScore: 74,
        },
      }),
    );
  });

  it("loads personalized readiness parameters for dashboard scoring", async () => {
    vi.mocked(loadPersonalizedParams).mockClear();
    const db = { execute: vi.fn() };
    const caller = createCaller({
      db,
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(
        [],
        0,
        [],
        [],
        [
          {
            date: "2026-03-28",
            hrv: 64,
            hrv_score: 72,
            resting_hr_score: 68,
            sleep_score: 80,
            respiratory_rate_score: 74,
          },
        ],
      ),
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    expect(loadPersonalizedParams).toHaveBeenCalledWith(db, "user-1");
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

    const sensorStore = makeSensorStore([{ metric_date: "2026-03-28", daily_load: 0 }]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBe(0);
    const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    expect(queryText).toContain("analytics.daily_strain AS strain FINAL");
    expect(queryText).not.toContain("analytics.activity_summary");
  });

  it("passes limited access windows to dashboard strain queries", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);

    const sensorStore = makeSensorStore([{ metric_date: "2026-03-28", daily_load: 50 }], 50);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        startDate: "2026-03-20",
        endDateExclusive: "2026-03-29",
      },
      sensorStore,
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    const strainQueryCalls = vi
      .mocked(sensorStore.query)
      .mock.calls.filter((call) => String(call[1]).includes("analytics.daily_strain"));
    expect(strainQueryCalls).toHaveLength(2);
    for (const queryCall of strainQueryCalls) {
      expect(String(queryCall[1])).toContain("strain.date >= toDate({accessStartDate:String})");
      expect(String(queryCall[1])).toContain(
        "strain.date < toDate({accessEndDateExclusive:String})",
      );
      expect(queryCall[2]).toMatchObject({
        accessStartDate: "2026-03-20",
        accessEndDateExclusive: "2026-03-29",
      });
    }
  });

  it("prioritizes dashboard read-model queries for latency-sensitive overview loading", async () => {
    const execute = vi.fn();
    const sensorStore = makeSensorStore(
      [{ metric_date: "2026-03-28", daily_load: 50 }],
      0,
      [sleepBaselineRow("2026-03-28", 480, 80)],
      [],
      [metricRow({ date: "2026-03-28" })],
    );
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    const dashboardQueryCalls = vi
      .mocked(sensorStore.query)
      .mock.calls.filter((call) =>
        ["analytics.daily_recovery", "analytics.daily_sleep", "analytics.daily_strain"].some(
          (readModelName) => String(call[1]).includes(readModelName),
        ),
      );
    expect(dashboardQueryCalls.length).toBeGreaterThan(0);
    for (const queryCall of dashboardQueryCalls) {
      expect(queryCall[3]).toEqual({ priority: "dashboard" });
    }
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
    const recoveryRows = hrvRowsAfterSleep(baselineSleepRows).filter(
      (row) => row.date <= "2026-03-28",
    );

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 50, baselineSleepRows, lastNightSleepRows, recoveryRows),
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.sleep?.lastNight).toEqual({
      date: "2026-03-28",
      durationMinutes: 480,
      deepPct: 25,
      remPct: 20,
      lightPct: 50,
      awakePct: 5,
      stagingAvailable: true,
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
      providerId: null,
      sourceName: null,
      sourceProviders: [],
    });
    expect(result.sleepNeed?.recentNights[6]).toEqual({
      date: "2026-03-27",
      actualMinutes: 420,
      neededMinutes: 525,
      debtMinutes: 105,
      providerId: null,
      sourceName: null,
      sourceProviders: [],
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
    const recoveryRows = hrvRowsAfterSleep(sleepRows).filter((row) => row.date <= "2026-03-28");

    const sensorStore = makeSensorStore([], 50, sleepRows, sleepRows, recoveryRows);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    const result = await caller.dashboard({ endDate: "2026-03-28" });

    const sleepQueryCallCount = vi
      .mocked(sensorStore.query)
      .mock.calls.filter((call) => String(call[1]).includes("analytics.daily_sleep")).length;
    expect(sleepQueryCallCount).toBe(1);
    expect(result.sleep?.lastNight?.date).toBe("2026-03-28");
    expect(result.sleepNeed?.canRecommend).toBe(true);
  });

  it("reads sleep circle data from the daily sleep summary instead of the live sleep view", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);

    const sensorStore = makeSensorStore([], 0, [sleepBaselineRow("2026-03-28", 480, 80)]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    const queryTexts = vi.mocked(sensorStore.query).mock.calls.map((call) => String(call[1]));
    expect(queryTexts.some((queryText) => queryText.includes("analytics.daily_sleep"))).toBe(true);
    expect(queryTexts.some((queryText) => queryText.includes("analytics.v_sleep"))).toBe(false);
  });

  it("qualifies serving model date filters so ClickHouse does not compare string aliases to dates", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);

    const sensorStore = makeSensorStore(
      [],
      0,
      [sleepBaselineRow("2026-03-28", 480, 80)],
      [],
      [metricRow({ date: "2026-03-28" })],
    );
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore,
    });

    await caller.dashboard({ endDate: "2026-03-28" });

    const recoveryQueryText = String(
      vi
        .mocked(sensorStore.query)
        .mock.calls.find((call) => String(call[1]).includes("analytics.daily_recovery"))?.[1],
    );
    const sleepQueryText = String(
      vi
        .mocked(sensorStore.query)
        .mock.calls.find((call) => String(call[1]).includes("analytics.daily_sleep"))?.[1],
    );
    expect(recoveryQueryText).toContain("recovery.date > toDate({endDate:String})");
    expect(recoveryQueryText).toContain("recovery.date <= toDate({endDate:String})");
    expect(sleepQueryText).toContain("sleep.date > toDate({endDate:String})");
    expect(sleepQueryText).toContain("sleep.date <= toDate({endDate:String})");
  });

  it("logs dashboard timing breakdowns for performance diagnosis", async () => {
    vi.mocked(logger.info).mockClear();
    const performanceNow = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1246);
    const execute = vi.fn();
    execute.mockResolvedValueOnce([metricRow({ date: "2026-03-28" })]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    try {
      await caller.dashboard({ endDate: "2026-03-28" });

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
        "[mobile-dashboard] dashboard timings userId=user-1 endDate=2026-03-28 total=246ms",
      );
    } finally {
      performanceNow.mockRestore();
    }
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
    const recoveryRows = hrvRowsAfterSleep(baselineSleepRows).filter(
      (row) => row.date <= "2026-03-28",
    );

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore([], 0, baselineSleepRows, baselineSleepRows, recoveryRows),
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
