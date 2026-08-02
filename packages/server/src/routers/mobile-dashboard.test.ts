import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestCallerFactory,
  dateDaysBefore,
  metricRow,
  sleepBaselineRow,
} from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);
type ProcessingStatusQuery = { datasets?: readonly ["recovery"] };
type ProcessingStatus = "ready" | "active" | "failed";
type ProcessingStatusResult = {
  overallStatus: ProcessingStatus;
  datasets: readonly [{ key: "recovery"; status: ProcessingStatus }];
};
const processingStatusMock = vi.hoisted(() =>
  vi.fn(
    async (_input: ProcessingStatusQuery): Promise<ProcessingStatusResult> => ({
      overallStatus: "ready" as const,
      datasets: [{ key: "recovery" as const, status: "ready" as const }],
    }),
  ),
);

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
    if (querySql.includes("analytics.daily_strain") && querySql.includes(" AS load")) {
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

vi.mock("../repositories/processing-repository.ts", () => ({
  ProcessingRepository: class {
    status(input: ProcessingStatusQuery) {
      return processingStatusMock(input);
    }
  },
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
import * as mobileRecoveryTab from "../services/mobile-recovery-tab.ts";
import * as mobileTrainingTab from "../services/mobile-training-tab.ts";
import { mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

const fullAccessWindow = {
  kind: "full" as const,
  paid: true as const,
  reason: "paid_grant" as const,
};

function emptyRecoveryTabResult(): import("../services/mobile-recovery-tab.ts").MobileRecoveryTabResult {
  return {
    hrvVariability: [],
    hrvBaseline: [],
    readinessScore: [],
    stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
    trends: null,
    dailyMetrics: [],
    baselineRelative: [],
    weight: [],
    weightPrediction: {
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    },
    healthStatus: [],
    healthspan: {
      healthspanScore: null,
      yearsDelta: null,
      availability: {
        status: "insufficient_data",
        availableMetricCount: 0,
        requiredMetricCount: 3,
        missingMetricLabels: [],
        summary: "0 of 3 required Healthspan metrics are available.",
        nextCondition:
          "The score becomes available after 3 more supported metrics sync successfully.",
      },
      metrics: [],
      history: [],
      trend: null,
    },
  };
}

describe("mobileDashboard.dashboardV2", () => {
  it("versions the changed dashboard and recovery response contracts", () => {
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 120_000,
      keyVersion: "mobile-dashboard-contract-v1",
    });
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 120_000,
      keyVersion: "mobile-dashboard-contract-v2",
    });
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 600_000,
      keyVersion: "health-status-evidence-v4",
    });
  });

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
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      message: "Sync last night's sleep data to see tonight's sleep need.",
    });
    expect(result.sleepNeed).not.toHaveProperty("totalNeedMinutes");
    expect(result.sleepNeed).not.toHaveProperty("recentNights");
  });

  it("returns the server-authored effective date and timezone", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "America/Los_Angeles",
      sensorStore: makeSensorStore(),
    });

    const result = await caller.dashboardV2({ endDate: "2026-08-02" });

    expect(result.summaryDateContext).toEqual({
      effectiveDate: "2026-08-02",
      timezone: "America/Los_Angeles",
    });
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

  it("returns the insufficient-data projection when baseline history is short", async () => {
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

    expect(result.sleepNeed).toEqual({
      availability: "insufficient_data",
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      reason: "insufficient_baseline_history",
      message: "Sync at least 7 qualifying nights to estimate sleep need.",
      nextAction: "Sync more sleep and recovery data.",
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

  it("returns the server-authored effective date and timezone", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "America/Los_Angeles",
      sensorStore: makeSensorStore(),
    });

    const result = await caller.dashboard({ endDate: "2026-08-02" });

    expect(result.summaryDateContext).toEqual({
      effectiveDate: "2026-08-02",
      timezone: "America/Los_Angeles",
    });
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

  it("returns a non-recommending legacy sleep shape when no sleep rows exist", async () => {
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

function parseTimingTotalMs(logMessage: unknown): number {
  const match = String(logMessage).match(/total=(\d+)ms/);
  return Number(match?.[1]);
}

describe("mobileDashboard.recovery", () => {
  it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.recovery({ endDate: "2026-03-28" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining(
        "mobileDashboard.recovery requires the ClickHouse activity analytics store",
      ),
    });
  });

  it("requests processing status for the recovery dataset", async () => {
    processingStatusMock.mockClear();

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]), transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.recovery({ days: 30, endDate: "2026-03-28" });

    expect(processingStatusMock).toHaveBeenCalledWith({ datasets: ["recovery"] });
  });

  it.each([
    { rawStatus: "active" as const, normalizedStatus: "syncing" as const },
    { rawStatus: "failed" as const, normalizedStatus: "sync_error" as const },
  ])("passes the normalized $normalizedStatus status to the recovery tab loader", async ({
    rawStatus,
    normalizedStatus,
  }) => {
    processingStatusMock.mockResolvedValueOnce({
      overallStatus: rawStatus,
      datasets: [{ key: "recovery", status: rawStatus }],
    });
    const loadSpy = vi
      .spyOn(mobileRecoveryTab, "loadMobileRecoveryTab")
      .mockResolvedValue(emptyRecoveryTabResult());

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]), transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.recovery({ days: 30, endDate: "2026-03-28" });

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: normalizedStatus }),
      30,
      "2026-03-28",
    );
  });

  it("returns consolidated recovery tab data", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-03-28",
            hrv: 55,
            resting_hr: 52,
            respiratory_rate: 14,
            hrv_mean_30d: 50,
            hrv_sd_30d: 5,
            rhr_mean_30d: 54,
            rhr_sd_30d: 2,
            rr_mean_30d: 14,
            rr_sd_30d: 1,
            hrv_z_score: 1,
            hrv_baseline_sample_count: 30,
            hrv_baseline_coverage: 1,
            hrv_mean_7d: 55,
            hrv_mean_previous_28d: 50,
            resting_hr_z_score: -1,
            rhr_baseline_sample_count: 30,
            rhr_baseline_coverage: 1,
            rhr_mean_7d: 52,
            rhr_mean_previous_28d: 54,
            respiratory_rate_z_score: 0,
            rr_baseline_sample_count: 30,
            rr_baseline_coverage: 1,
            rr_mean_7d: 14,
            rr_mean_previous_28d: 14,
            efficiency_pct: 90,
            efficiency_mean_30d: 85,
            efficiency_sd_30d: 5,
            efficiency_z_score: 1,
            efficiency_baseline_sample_count: 30,
            efficiency_baseline_coverage: 1,
            efficiency_mean_7d: 90,
            efficiency_mean_previous_28d: 85,
          },
        ];
      }
      return [];
    });
    const execute = vi.fn(async () => []);

    const caller = createCaller({
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: fullAccessWindow,
      sensorStore: {
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
      },
    });

    const result = await caller.recovery({ days: 30, endDate: "2026-03-28" });

    expect(result.readinessScore).toHaveLength(1);
    expect(result.stress.daily).toHaveLength(1);
    const timingCall = vi
      .mocked(logger.info)
      .mock.calls.find((call) => String(call[0]).includes("[mobile-dashboard] recovery timings"));
    expect(timingCall?.[0]).toEqual(expect.stringContaining("[mobile-dashboard] recovery timings"));
    expect(parseTimingTotalMs(timingCall?.[0])).toBeLessThan(60_000);
  });

  it("defaults timezone when omitted", async () => {
    const loadSpy = vi.spyOn(mobileRecoveryTab, "loadMobileRecoveryTab").mockResolvedValue({
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      baselineRelative: [],
      weight: [],
      weightPrediction: {
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      },
      healthStatus: [],
      healthspan: {
        healthspanScore: null,
        yearsDelta: null,
        availability: {
          status: "insufficient_data",
          availableMetricCount: 0,
          requiredMetricCount: 3,
          missingMetricLabels: [],
          summary: "0 of 3 required Healthspan metrics are available.",
          nextCondition:
            "The score becomes available after 3 more supported metrics sync successfully.",
        },
        metrics: [],
        history: [],
        trend: null,
      },
    });

    const caller = createCaller({
      db: { execute: vi.fn(), transaction: vi.fn() },
      userId: "user-1",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.recovery({ days: 30, endDate: "2026-03-28" });

    expect(loadSpy).toHaveBeenCalledWith(
      {
        db: expect.anything(),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: fullAccessWindow,
        sensorStore: expect.anything(),
        processingStatus: null,
      },
      30,
      "2026-03-28",
    );

    loadSpy.mockRestore();
  });

  it("fails when entitlement access window is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn(), transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    await expect(caller.recovery({ days: 30, endDate: "2026-03-28" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("requires resolved entitlement access window"),
    });
  });

  it("preserves an explicit timezone when provided", async () => {
    const loadSpy = vi.spyOn(mobileRecoveryTab, "loadMobileRecoveryTab").mockResolvedValue({
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      baselineRelative: [],
      weight: [],
      weightPrediction: {
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      },
      healthStatus: [],
      healthspan: {
        healthspanScore: null,
        yearsDelta: null,
        availability: {
          status: "insufficient_data",
          availableMetricCount: 0,
          requiredMetricCount: 3,
          missingMetricLabels: [],
          summary: "0 of 3 required Healthspan metrics are available.",
          nextCondition:
            "The score becomes available after 3 more supported metrics sync successfully.",
        },
        metrics: [],
        history: [],
        trend: null,
      },
    });

    const caller = createCaller({
      db: { execute: vi.fn(), transaction: vi.fn() },
      userId: "user-1",
      timezone: "America/New_York",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.recovery({ days: 30, endDate: "2026-03-28" });

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/New_York" }),
      30,
      "2026-03-28",
    );

    loadSpy.mockRestore();
  });
});

describe("mobileDashboard.training", () => {
  it("uses a versioned cache key for its activity-state contract", () => {
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 600_000,
      keyVersion: "training-activity-states-v2",
    });
  });

  it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.training({ endDate: "2026-03-28" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining(
        "mobileDashboard.training requires the ClickHouse activity analytics store",
      ),
    });
  });

  it("returns consolidated training tab data", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_strain")) {
        return [
          {
            date: "2026-03-28",
            daily_load: 50,
            acute_load: 350,
            chronic_load: 300,
            workload_ratio: 1.17,
          },
        ];
      }
      if (sql.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-03-28",
            hrv_score: 72,
            resting_hr_score: 68,
            sleep_score: 80,
            respiratory_rate_score: 74,
          },
        ];
      }
      if (sql.includes("raw_activity_count")) {
        return [{ raw_activity_count: 0 }];
      }
      return [];
    });
    const execute = vi.fn(async () => []);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: fullAccessWindow,
      sensorStore: {
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
      },
    });

    const result = await caller.training({ days: 30, endDate: "2026-03-28" });

    expect(result.workloadRatio.timeSeries).toHaveLength(1);
    expect(result.strainTarget.dailyLoad).toBe(50);
    expect(result.activities).toEqual([]);
    expect(result.weeklyVolume).toEqual([]);
    expect(result.climbing).toEqual({
      gradeProgression: [],
      volumeByGrade: [],
      sessionSummary: [],
    });
    const timingCall = vi
      .mocked(logger.info)
      .mock.calls.find((call) => String(call[0]).includes("[mobile-dashboard] training timings"));
    expect(timingCall?.[0]).toEqual(expect.stringContaining("[mobile-dashboard] training timings"));
    expect(parseTimingTotalMs(timingCall?.[0])).toBeLessThan(60_000);
  });

  it("defaults timezone when omitted", async () => {
    const loadSpy = vi.spyOn(mobileTrainingTab, "loadMobileTrainingTab").mockResolvedValue({
      workloadRatio: {
        timeSeries: [],
        context: {
          label: "Recent-to-baseline workload ratio",
          description:
            "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
          recentDays: 7,
          baselineDays: 28,
        },
        displayedStrain: 0,
        displayedDate: null,
      },
      strainTarget: {
        targetStrain: 0,
        currentStrain: 0,
        currentStrainSource: "none",
        currentPhysiologyLoad: 0,
        progressPercent: 0,
        zone: "Recovery",
        explanation: "",
        dailyLoad: 0,
        acuteLoad: 0,
        chronicLoad: 0,
        workloadRatio: null,
        readinessScore: 50,
      },
      activities: [],
      weeklyVolume: [],
      progressiveOverload: [],
      verticalAscent: [],
      chartAvailability: {
        strainTrend: {
          status: "insufficient_data",
          sourceLabel: "Daily strain model",
          observedCount: 0,
          minimumCount: 2,
          message: "No daily strain trend is available from the daily strain model.",
        },
        verticalAscent: {
          status: "insufficient_data",
          sourceLabel: "Cycling activity altitude sensor summaries",
          observedCount: 0,
          minimumCount: 1,
          message:
            "No vertical ascent data is available from cycling activity altitude sensor summaries.",
        },
      },
      climbing: {
        gradeProgression: [],
        volumeByGrade: [],
        sessionSummary: [],
      },
    });

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.training({ days: 30, endDate: "2026-03-28" });

    expect(loadSpy).toHaveBeenCalledWith(
      {
        db: expect.anything(),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: fullAccessWindow,
        sensorStore: expect.anything(),
      },
      30,
      "2026-03-28",
    );

    loadSpy.mockRestore();
  });

  it("fails when entitlement access window is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeSensorStore(),
    });

    await expect(caller.training({ days: 30, endDate: "2026-03-28" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("requires resolved entitlement access window"),
    });
  });

  it("preserves an explicit timezone when provided", async () => {
    const loadSpy = vi.spyOn(mobileTrainingTab, "loadMobileTrainingTab").mockResolvedValue({
      workloadRatio: {
        timeSeries: [],
        context: {
          label: "Recent-to-baseline workload ratio",
          description:
            "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
          recentDays: 7,
          baselineDays: 28,
        },
        displayedStrain: 0,
        displayedDate: null,
      },
      strainTarget: {
        targetStrain: 0,
        currentStrain: 0,
        currentStrainSource: "none",
        currentPhysiologyLoad: 0,
        progressPercent: 0,
        zone: "Recovery",
        explanation: "",
        dailyLoad: 0,
        acuteLoad: 0,
        chronicLoad: 0,
        workloadRatio: null,
        readinessScore: 50,
      },
      activities: [],
      weeklyVolume: [],
      progressiveOverload: [],
      verticalAscent: [],
      chartAvailability: {
        strainTrend: {
          status: "insufficient_data",
          sourceLabel: "Daily strain model",
          observedCount: 0,
          minimumCount: 2,
          message: "No daily strain trend is available from the daily strain model.",
        },
        verticalAscent: {
          status: "insufficient_data",
          sourceLabel: "Cycling activity altitude sensor summaries",
          observedCount: 0,
          minimumCount: 1,
          message:
            "No vertical ascent data is available from cycling activity altitude sensor summaries.",
        },
      },
      climbing: {
        gradeProgression: [],
        volumeByGrade: [],
        sessionSummary: [],
      },
    });

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "America/Chicago",
      accessWindow: fullAccessWindow,
      sensorStore: makeSensorStore(),
    });

    await caller.training({ days: 30, endDate: "2026-03-28" });

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Chicago" }),
      30,
      "2026-03-28",
    );

    loadSpy.mockRestore();
  });
});
