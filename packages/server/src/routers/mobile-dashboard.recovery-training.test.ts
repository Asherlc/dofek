import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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

import { logger } from "../logger.ts";
import * as mobileRecoveryTab from "../services/mobile-recovery-tab.ts";
import * as mobileTrainingTab from "../services/mobile-training-tab.ts";
import { mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

const fullAccessWindow = {
  kind: "full" as const,
  paid: true as const,
  reason: "paid_grant" as const,
};

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
      decisionContext: null,
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
      },
      30,
      "2026-03-28",
    );
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
      decisionContext: null,
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
  });
});

describe("mobileDashboard.training", () => {
  it("uses a versioned cache key for its progressive-overload contract", () => {
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 600_000,
      keyVersion: "training-progressive-overload-v1",
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
  });
});
