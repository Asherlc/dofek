import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { dateWindowStartString } from "../lib/date-window.ts";
import { fetchHealthspanRawData } from "../routers/healthspan-query.ts";
import type { BodyDecisionContext } from "./body-decision-context.ts";
import {
  buildHealthStatusFromBaselineMetric,
  buildHealthStatusFromValues,
  buildWeightHealthStatus,
} from "./health-status.ts";
import { loadMobileRecoveryTab } from "./mobile-recovery-tab.ts";
import { metricRow, recoveryRow, runRecoveryTab } from "./test-helpers.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("../routers/healthspan-query.ts", () => ({
  fetchHealthspanRawData: vi.fn(async () => null),
}));

vi.mock("../repositories/resting-heart-rate-query.ts", () => ({
  fetchRestingHeartRateValuesCte: vi.fn(async () => sql`SELECT 1`),
}));

vi.mock("./health-status.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./health-status.ts")>();
  return {
    ...actual,
    buildHealthStatusFromBaselineMetric: vi.fn(actual.buildHealthStatusFromBaselineMetric),
    buildHealthStatusFromValues: vi.fn(actual.buildHealthStatusFromValues),
    buildWeightHealthStatus: vi.fn(actual.buildWeightHealthStatus),
  };
});

describe("loadMobileRecoveryTab", () => {
  it("returns body-fat history for the selected range", async () => {
    const getRecomposition = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getRecomposition",
      )
      .mockResolvedValue([
        {
          date: "2026-03-10",
          weightKg: 80,
          bodyFatPct: 21.4,
          fatMassKg: 17.12,
          leanMassKg: 62.88,
          smoothedFatMass: 17.12,
          smoothedLeanMass: 62.88,
        },
        {
          date: "2026-03-20",
          weightKg: 79,
          bodyFatPct: 20.9,
          fatMassKg: 16.511,
          leanMassKg: 62.489,
          smoothedFatMass: 16.511,
          smoothedLeanMass: 62.489,
        },
      ]);

    const result = await runRecoveryTab(loadMobileRecoveryTab, []);

    expect(result.bodyFat).toEqual([
      { date: "2026-03-10", bodyFatPct: 21.4 },
      { date: "2026-03-20", bodyFatPct: 20.9 },
    ]);
    expect(getRecomposition).toHaveBeenCalledWith(30, "2026-03-28");

    getRecomposition.mockRestore();
  });

  it("returns server-authored body decision context alongside recovery data", async () => {
    const decisionContext: BodyDecisionContext = {
      latestMeasurement: {
        date: "2026-03-28",
        recordedAt: "2026-03-28T08:00:00.000Z",
        recordedAtLocal: "2026-03-28 08:00:00",
        weightKg: 80,
        providerId: "withings",
        sourceName: "Body+",
      },
      trendWeight: {
        smoothing: "ewma",
        alpha: 0.1,
        gapHandling: "linear_interpolation",
        invalidWeightHandling: "exclude_non_positive",
        outlierHandling: "retain",
      },
      variation: {
        status: "insufficient_data",
        observations: 1,
        minimumObservations: 8,
        maximumObservations: 30,
        method: "tukey_inner_fence",
        lowerResidualKg: null,
        upperResidualKg: null,
        outliersIncluded: true,
      },
    };

    const result = await runRecoveryTab(loadMobileRecoveryTab, [], { decisionContext });

    expect(result.decisionContext).toEqual(decisionContext);
  });

  it("keeps recovery data when body decision context fails", async () => {
    const error = new Error("body decision context unavailable");

    const result = await runRecoveryTab(loadMobileRecoveryTab, [recoveryRow()], {
      decisionContextError: error,
    });

    expect(result.decisionContext).toBeNull();
    expect(result.readinessScore).toHaveLength(1);
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("uses one daily_recovery query for readiness and stress", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_recovery")) {
        return [recoveryRow()];
      }
      return [];
    });

    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    const metricsRepoList = vi
      .spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "list",
      )
      .mockResolvedValue([]);
    const metricsRepoBaseline = vi
      .spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "getHrvBaseline",
      )
      .mockResolvedValue([]);
    const bodyRepoWeight = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getSmoothedWeight",
      )
      .mockResolvedValue([]);
    const bodyRepoPrediction = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      )
      .mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    const recoveryQueries = query.mock.calls.filter((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );
    expect(recoveryQueries).toHaveLength(1);
    expect(String(recoveryQueries[0]?.[1])).toContain("recovery.is_deleted = 0");
    expect(result.readinessScore).toHaveLength(1);
    expect(result.stress.daily).toHaveLength(1);

    metricsRepoList.mockRestore();
    metricsRepoBaseline.mockRestore();
    bodyRepoWeight.mockRestore();
    bodyRepoPrediction.mockRestore();
  });

  it("passes limited access windows to recovery queries", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [recoveryRow()];
      }
      return [];
    });
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited" as const,
        paid: false as const,
        reason: "free_signup_week" as const,
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-20",
      },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );
    expect(String(recoveryQuery?.[1])).toContain(
      "recovery.date >= toDate({accessStartDate:String})",
    );
    expect(String(recoveryQuery?.[1])).toContain(
      "recovery.date < toDate({accessEndDateExclusive:String})",
    );
    expect(recoveryQuery?.[2]).toMatchObject({
      accessStartDate: "2026-03-10",
      accessEndDateExclusive: "2026-03-20",
    });
  });

  it("passes dashboard priority to recovery dashboard read-model queries", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [recoveryRow()];
      }
      return [];
    });
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );
    expect(recoveryQuery?.[3]).toEqual({ priority: "dashboard" });
  });

  it("computes resting heart rate deviation and rounded sleep efficiency in stress", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [
          recoveryRow({
            date: "2026-03-28",
            resting_hr_z_score: -2,
            efficiency_pct: 92.34,
          }),
        ];
      }
      return [];
    });
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.stress.daily[0]?.restingHrDeviation).toBe(-2);
    expect(result.stress.daily[0]?.sleepEfficiency).toBe(92.3);
  });

  it("computes HRV variability after seven consecutive HRV days", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [];
      }
      return [];
    });
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };
    const hrvDays = Array.from({ length: 7 }, (_, index) =>
      metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 50 + index),
    );

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue(hrvDays);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.hrvVariability).toHaveLength(1);
    expect(result.hrvVariability[0]?.date).toBe("2026-03-28");
    expect(result.hrvVariability[0]?.hrv).toBe(56);
    expect(result.hrvVariability[0]?.rollingMean).toBe(53);
    expect(result.hrvVariability[0]?.rollingCoefficientOfVariation).toBeGreaterThan(0);
  });

  it("derives latest SpO2 and skin temperature trends from daily metrics", async () => {
    const query = vi.fn(async () => []);
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([
      metricRow("2026-03-27", 50, { spo2_avg: 97.5, skin_temp_c: 33.1 }),
      metricRow("2026-03-28", 52, { spo2_avg: 98.2, skin_temp_c: 33.4 }),
    ]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    const predictionSpy = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      )
      .mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue({ value: "75.5" });

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.trends).toEqual({
      latest_spo2: 98.2,
      latest_skin_temp: 33.4,
    });
    expect(predictionSpy).toHaveBeenCalledWith(90, "2026-03-28", 75.5);
  });

  describe("mutation killers", () => {
    it("passes each recovery metric's non-null history to its server-side classifier", async () => {
      vi.mocked(buildHealthStatusFromBaselineMetric).mockClear();
      vi.mocked(buildHealthStatusFromValues).mockClear();
      vi.mocked(buildWeightHealthStatus).mockClear();

      await runRecoveryTab(loadMobileRecoveryTab, [recoveryRow()], {
        weight: [
          {
            date: "2026-03-27",
            rawWeight: 80,
            smoothedWeight: 80,
            weeklyChange: null,
            interpolated: false,
          },
          {
            date: "2026-03-28",
            rawWeight: 79,
            smoothedWeight: 79,
            weeklyChange: -1,
            interpolated: false,
          },
        ],
        metrics: [
          metricRow("2026-03-26", 50, {
            spo2_avg: 97,
            steps: null,
            skin_temp_c: 33.1,
          }),
          metricRow("2026-03-27", 51, {
            spo2_avg: null,
            steps: 8_000,
            skin_temp_c: null,
          }),
          metricRow("2026-03-28", 52, {
            spo2_avg: 99,
            steps: 10_000,
            skin_temp_c: 33.5,
          }),
        ],
        goalWeight: "75",
      });

      expect(vi.mocked(buildHealthStatusFromBaselineMetric)).toHaveBeenCalledTimes(4);
      expect(vi.mocked(buildHealthStatusFromValues).mock.calls.map(([input]) => input)).toEqual([
        {
          metric: "spo2",
          label: "Blood Oxygen Saturation (SpO2)",
          values: [97, 99],
          intent: "neutral",
          observations: [
            { date: "2026-03-26", value: 97, sourceProviders: ["apple_health"] },
            { date: "2026-03-27", value: null, sourceProviders: ["apple_health"] },
            { date: "2026-03-28", value: 99, sourceProviders: ["apple_health"] },
          ],
          windowDays: 35,
          processingStatus: null,
        },
        {
          metric: "steps",
          label: "Steps",
          values: [8_000, 10_000],
          intent: "neutral",
          observations: [
            { date: "2026-03-26", value: null, sourceProviders: ["apple_health"] },
            { date: "2026-03-27", value: 8_000, sourceProviders: ["apple_health"] },
            { date: "2026-03-28", value: 10_000, sourceProviders: ["apple_health"] },
          ],
          windowDays: 35,
          processingStatus: null,
        },
        {
          metric: "skin_temperature",
          label: "Skin Temperature",
          values: [33.1, 33.5],
          intent: "neutral",
          observations: [
            { date: "2026-03-26", value: 33.1, sourceProviders: ["apple_health"] },
            { date: "2026-03-27", value: null, sourceProviders: ["apple_health"] },
            { date: "2026-03-28", value: 33.5, sourceProviders: ["apple_health"] },
          ],
          windowDays: 35,
          processingStatus: null,
        },
      ]);
      expect(buildWeightHealthStatus).toHaveBeenCalledWith([80, 79], 75, null);
    });

    it("rounds HRV deviation to 2 decimal places", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ hrv_z_score: -2.142_857 }),
      ]);
      expect(result.stress.daily[0]?.hrvDeviation).toBe(-2.14);
    });

    it("returns null HRV deviation when its canonical z-score is unavailable", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ hrv_z_score: null }),
      ]);
      expect(result.stress.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null resting HR deviation when its canonical z-score is unavailable", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ resting_hr_z_score: null }),
      ]);
      expect(result.stress.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null sleep efficiency when efficiency_pct is null", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ efficiency_pct: null }),
      ]);
      expect(result.stress.daily[0]?.sleepEfficiency).toBeNull();
    });

    it("returns latest stress score from the last daily entry", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ date: "2026-03-27", hrv_z_score: -2 }),
        recoveryRow({ date: "2026-03-28", hrv_z_score: -0.5 }),
      ]);
      expect(result.stress.latestScore).toBe(result.stress.daily.at(-1)?.stressScore ?? null);
      expect(result.stress.latestScore).not.toBeNull();
    });

    it("returns null latest stress score when no daily rows exist", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, []);
      expect(result.stress.latestScore).toBeNull();
    });

    it("computes readiness components from recovery metrics", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          hrv: 60,
          resting_hr: 50,
          respiratory_rate: 13,
          efficiency_pct: 88,
        }),
      ]);
      expect(result.readinessScore[0]?.components.hrvScore).toBeGreaterThan(62);
      expect(result.readinessScore[0]?.components.restingHrScore).toBeGreaterThan(62);
      expect(result.readinessScore[0]?.components.sleepScore).toBe(88);
      expect(result.readinessScore[0]?.components.respiratoryRateScore).toBeGreaterThan(62);
    });

    it("rounds HRV variability values to expected precision", async () => {
      const metrics = Array.from({ length: 7 }, (_, index) =>
        metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 52.67 + index * 0.1),
      );
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], { metrics });
      const latest = result.hrvVariability.at(-1);
      expect(latest?.hrv).toBe(53.3);
      expect(latest?.rollingMean).toBeCloseTo(53, 1);
      expect(latest?.rollingCoefficientOfVariation).not.toBeNull();
    });

    it("returns null trends when daily metrics are empty", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, []);
      expect(result.trends).toBeNull();
    });

    it("ignores invalid goal weight values", async () => {
      const predictionSpy = vi
        .spyOn(
          (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
            .prototype,
          "getWeightPrediction",
        )
        .mockResolvedValue({
          ratePerWeek: null,
          rateConfidence: null,
          impliedDailyCalories: null,
          periodDeltas: { days7: null, days14: null, days30: null },
          goal: null,
          projectionLine: [],
        });
      const query = vi.fn(async () => []);
      const ctx = {
        db: { execute: vi.fn(async () => []), transaction: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
        sensorStore: { query },
      };

      vi.spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "list",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "getHrvBaseline",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getSmoothedWeight",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
        "get",
      ).mockResolvedValue({ value: "not-a-number" });

      await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

      expect(predictionSpy).toHaveBeenCalledWith(90, "2026-03-28", null);
      predictionSpy.mockRestore();
    });

    it("returns null HRV deviation when hrv is null", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ hrv: null, hrv_z_score: null }),
      ]);
      expect(result.stress.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null resting HR deviation when resting_hr is null", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ resting_hr: null, resting_hr_z_score: null }),
      ]);
      expect(result.stress.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("low HRV produces a lower readiness HRV score", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          hrv: 30,
          hrv_z_score: -2,
        }),
      ]);
      expect(result.readinessScore[0]?.components.hrvScore).toBeLessThan(50);
    });

    it("high resting heart rate produces a lower readiness RHR score", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          resting_hr: 70,
          resting_hr_z_score: 2,
        }),
      ]);
      expect(result.readinessScore[0]?.components.restingHrScore).toBeLessThan(50);
    });

    it("maps sleep efficiency directly to readiness sleep score", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          hrv: null,
          hrv_z_score: null,
          resting_hr: null,
          resting_hr_z_score: null,
          respiratory_rate: null,
          respiratory_rate_z_score: null,
          efficiency_pct: 85,
        }),
      ]);
      expect(result.readinessScore[0]?.components.sleepScore).toBe(85);
    });

    it("excludes readiness rows after the end date", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ date: "2026-03-28" }),
        recoveryRow({ date: "2026-03-29" }),
      ]);
      expect(result.readinessScore.map((row) => row.date)).toEqual(["2026-03-28"]);
    });

    it("requests daily metrics with an extended lookback window", async () => {
      const query = vi.fn(async () => []);
      const listSpy = vi
        .spyOn(
          (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
            .prototype,
          "list",
        )
        .mockResolvedValue([]);
      const ctx = {
        db: { execute: vi.fn(async () => []), transaction: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
        sensorStore: { query },
      };

      vi.spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "getHrvBaseline",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getSmoothedWeight",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      ).mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
      vi.spyOn(
        (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
        "get",
      ).mockResolvedValue(null);

      await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

      expect(listSpy).toHaveBeenCalledWith(90, "2026-03-28");
      listSpy.mockRestore();
    });

    it("aggregates weekly stress from daily stress rows", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ date: "2026-03-27", hrv_z_score: -2 }),
        recoveryRow({ date: "2026-03-28", hrv_z_score: -0.5 }),
      ]);
      expect(result.stress.weekly.length).toBeGreaterThan(0);
    });

    it("uses sleep efficiency when computing daily stress", async () => {
      const lowEfficiency = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ efficiency_pct: 60 }),
      ]);
      const highEfficiency = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ efficiency_pct: 95 }),
      ]);
      expect(lowEfficiency.stress.daily[0]?.stressScore).toBeGreaterThan(
        highEfficiency.stress.daily[0]?.stressScore ?? 0,
      );
    });

    it("requires seven HRV days before emitting variability rows", async () => {
      const metrics = Array.from({ length: 6 }, (_, index) =>
        metricRow(`2026-03-${String(23 + index).padStart(2, "0")}`, 50 + index),
      );
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], { metrics });
      expect(result.hrvVariability).toHaveLength(0);
    });

    it("high respiratory rate produces a lower readiness respiratory score", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          respiratory_rate: 17,
          respiratory_rate_z_score: 2,
        }),
      ]);
      expect(result.readinessScore[0]?.components.respiratoryRateScore).toBeLessThan(50);
    });

    it("computes respiratory rate score from recovery metrics", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          respiratory_rate: 13,
          respiratory_rate_z_score: -2,
        }),
      ]);
      expect(result.readinessScore[0]?.components.respiratoryRateScore).toBeGreaterThan(80);
    });

    it("returns default respiratory rate score when its canonical z-score is missing", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          respiratory_rate: 13,
          respiratory_rate_z_score: null,
        }),
      ]);
      expect(result.readinessScore[0]?.components.respiratoryRateScore).toBe(62);
    });

    it("excludes recovery rows outside the stress window", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({
          date: "2026-02-20",
          hrv_z_score: -2,
        }),
        recoveryRow({
          date: "2026-03-28",
          hrv_z_score: -0.5,
        }),
      ]);
      expect(result.stress.daily).toHaveLength(1);
      expect(result.stress.daily[0]?.date).toBe("2026-03-28");
    });

    it("excludes readiness rows on or before the cutoff date", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ date: "2026-02-26" }),
        recoveryRow({ date: "2026-02-27" }),
      ]);
      expect(result.readinessScore.map((row) => row.date)).toEqual(["2026-02-27"]);
    });

    it("changes stress score when HRV deviation inputs change", async () => {
      const lowHrv = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ hrv_z_score: -2 }),
      ]);
      const highHrv = await runRecoveryTab(loadMobileRecoveryTab, [
        recoveryRow({ hrv_z_score: 1 }),
      ]);
      expect(lowHrv.stress.daily[0]?.stressScore).not.toBe(highHrv.stress.daily[0]?.stressScore);
    });

    it("skips rows without HRV when computing variability", async () => {
      const metrics = [
        ...Array.from({ length: 6 }, (_, index) =>
          metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 50 + index),
        ),
        metricRow("2026-03-28", null),
      ];
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], { metrics });
      expect(result.hrvVariability).toHaveLength(0);
    });

    it("filters HRV variability rows to the requested window", async () => {
      const metrics = Array.from({ length: 7 }, (_, index) =>
        metricRow(`2026-02-${String(20 + index).padStart(2, "0")}`, 50 + index),
      );
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], {
        metrics,
        days: 30,
        endDate: "2026-03-28",
      });
      expect(result.hrvVariability.every((row) => row.date > "2026-02-26")).toBe(true);
    });

    it("computes an exact rolling coefficient of variation", async () => {
      const metrics = Array.from({ length: 7 }, (_, index) =>
        metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 50 + index),
      );
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], { metrics });
      expect(result.hrvVariability[0]?.rollingCoefficientOfVariation).toBe(3.77);
    });

    it("uses the latest non-null SpO2 and skin temperature values", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], {
        metrics: [
          metricRow("2026-03-27", 50, { spo2_avg: 97.5, skin_temp_c: 33.1 }),
          metricRow("2026-03-28", 52, { spo2_avg: null, skin_temp_c: null }),
        ],
      });
      expect(result.trends).toEqual({
        latest_spo2: 97.5,
        latest_skin_temp: 33.1,
      });
    });

    it("filters daily metrics to the requested window", async () => {
      const result = await runRecoveryTab(loadMobileRecoveryTab, [], {
        metrics: [metricRow("2026-02-20", 50), metricRow("2026-03-28", 52)],
      });
      expect(result.dailyMetrics.map((row) => row.date)).toEqual(["2026-03-28"]);
    });

    it("queries canonical recovery baselines for the exact requested window", async () => {
      const query = vi.fn(async (_schema: unknown, sqlText: unknown, _params?: unknown) => {
        if (String(sqlText).includes("analytics.daily_recovery")) {
          return [recoveryRow()];
        }
        return [];
      });
      const ctx = {
        db: { execute: vi.fn(async () => []), transaction: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
        sensorStore: { query },
      };

      vi.spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "list",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "getHrvBaseline",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getSmoothedWeight",
      ).mockResolvedValue([]);
      vi.spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      ).mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
      vi.spyOn(
        (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
        "get",
      ).mockResolvedValue(null);

      await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

      const recoveryQuery = query.mock.calls.find((call) =>
        String(call[1]).includes("analytics.daily_recovery"),
      );
      expect(recoveryQuery?.[2]).toMatchObject({
        startDate: dateWindowStartString("2026-03-28", 29),
        endDate: "2026-03-28",
      });
    });

    it("requests at least four weeks of healthspan data", async () => {
      await runRecoveryTab(loadMobileRecoveryTab, [recoveryRow()], {
        days: 21,
        endDate: "2026-03-28",
      });
      expect(vi.mocked(fetchHealthspanRawData)).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          timezone: "UTC",
          accessWindow: { kind: "full", paid: true, reason: "paid_grant" },
        }),
        "2026-03-28",
        28,
      );
    });
  });
});

describe("loadMobileRecoveryTab dependent query context", () => {
  it("passes healthspan context through to the healthspan query", async () => {
    const query = vi.fn(async () => []);
    const accessWindow = {
      kind: "full" as const,
      paid: true as const,
      reason: "paid_grant" as const,
    };
    const sensorStore = { query };
    const ctx = {
      db: { execute: vi.fn(async () => []), transaction: vi.fn() },
      userId: "user-abc",
      timezone: "Europe/London",
      accessWindow,
      sensorStore,
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    vi.mocked(fetchHealthspanRawData).mockClear();
    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(vi.mocked(fetchHealthspanRawData)).toHaveBeenCalledWith(
      {
        userId: "user-abc",
        timezone: "Europe/London",
        accessWindow,
        sensorStore,
      },
      "2026-03-28",
      35,
    );
  });

  it("passes parsed goal weight to weight prediction", async () => {
    const predictionSpy = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      )
      .mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
    const query = vi.fn(async () => []);
    const ctx = {
      db: { execute: vi.fn(async () => []), transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue({ value: "72.4" });

    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(predictionSpy).toHaveBeenCalledWith(90, "2026-03-28", 72.4);
    predictionSpy.mockRestore();
  });
});
