import {
  type ReadinessComponents,
  ReadinessScore,
  type ReadinessWeights,
} from "@dofek/recovery/readiness";
import {
  aggregateWeeklyStress,
  computeDailyStress,
  computeStressTrend,
} from "@dofek/recovery/stress";
import { baselineReadinessComponents } from "@dofek/scoring/scoring";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { BaselineRelativeMetric } from "../contracts/baseline-relative-metrics.ts";
import {
  HEALTH_METRIC_EVIDENCE_WINDOW_DAYS,
  type MobileRecoveryTabResult,
  mobileRecoveryTabOutputSchema,
} from "../contracts/mobile-dashboard-contracts.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import {
  DailyMetricsRepository,
  type DailyMetricsViewRow,
} from "../repositories/daily-metrics-repository.ts";
import {
  type DailyRecoveryBaseline,
  latestRecoveryBaselineMetrics,
  RecoveryBaselineRepository,
} from "../repositories/recovery-baseline-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import type { StressResult } from "../repositories/stress-repository.ts";
import { buildHealthspanResult } from "../routers/healthspan.ts";
import { fetchHealthspanRawData } from "../routers/healthspan-query.ts";
import type { HrvVariabilityRow, ReadinessRow } from "../routers/recovery.ts";
import type { BaselineProcessingStatus } from "./baseline-progress.ts";
import {
  buildHealthMetricEvidence,
  buildHealthStatusFromBaselineMetric,
  buildHealthStatusFromValues,
  buildWeightHealthStatus,
} from "./health-status.ts";

export { type MobileRecoveryTabResult, mobileRecoveryTabOutputSchema };

export type MobileRecoveryTrends = NonNullable<MobileRecoveryTabResult["trends"]>;

interface MobileRecoveryTabContext {
  db: Pick<Database, "execute" | "transaction">;
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  sensorStore: ActivitySensorStore;
  processingStatus?: BaselineProcessingStatus;
}

function findRecoveryMetric(row: DailyRecoveryBaseline, metric: BaselineRelativeMetric["metric"]) {
  return row.metrics.find((candidate) => candidate.metric === metric);
}

function computeReadinessRows(
  rows: DailyRecoveryBaseline[],
  weights: ReadinessWeights,
): ReadinessRow[] {
  const results: ReadinessRow[] = [];
  for (const row of rows) {
    const hrv = findRecoveryMetric(row, "hrv");
    const restingHeartRate = findRecoveryMetric(row, "resting_heart_rate");
    const respiratoryRate = findRecoveryMetric(row, "respiratory_rate");
    const sleepEfficiency = findRecoveryMetric(row, "sleep_efficiency");

    const components: ReadinessComponents = baselineReadinessComponents({
      hrvZScore: hrv?.baseline.zScore ?? null,
      restingHeartRateZScore: restingHeartRate?.baseline.zScore ?? null,
      respiratoryRateZScore: respiratoryRate?.baseline.zScore ?? null,
      sleepEfficiency: sleepEfficiency?.value ?? null,
    });
    const readiness = new ReadinessScore(components, weights);
    results.push({
      date: row.date,
      readinessScore: readiness.score,
      components: readiness.components,
      weights,
    });
  }
  return results;
}

function computeStressFromRows(
  rows: DailyRecoveryBaseline[],
  stressThresholds: ReturnType<typeof getEffectiveParams>["stressThresholds"],
): StressResult {
  const daily = rows.map((row) => {
    const hrvDeviation = findRecoveryMetric(row, "hrv")?.baseline.zScore ?? null;
    const restingHrDeviation =
      findRecoveryMetric(row, "resting_heart_rate")?.baseline.zScore ?? null;
    const sleepEfficiency = findRecoveryMetric(row, "sleep_efficiency")?.value ?? null;
    const { stressScore } = computeDailyStress(
      { hrvDeviation, restingHrDeviation, sleepEfficiency },
      stressThresholds,
    );
    return {
      date: row.date,
      stressScore,
      hrvDeviation: hrvDeviation != null ? Math.round(hrvDeviation * 100) / 100 : null,
      restingHrDeviation:
        restingHrDeviation != null ? Math.round(restingHrDeviation * 100) / 100 : null,
      sleepEfficiency: sleepEfficiency != null ? Math.round(sleepEfficiency * 10) / 10 : null,
    };
  });

  return {
    daily,
    weekly: aggregateWeeklyStress(daily),
    latestScore: daily.length > 0 ? (daily[daily.length - 1]?.stressScore ?? null) : null,
    trend: computeStressTrend(daily),
  };
}

function computeHrvVariability(
  rows: DailyMetricsViewRow[],
  days: number,
  endDate: string,
): HrvVariabilityRow[] {
  const hrvRows = rows.flatMap((row) =>
    row.hrv != null ? [{ date: row.date, hrv: row.hrv }] : [],
  );
  const computed: HrvVariabilityRow[] = [];

  for (let index = 0; index < hrvRows.length; index++) {
    const window = hrvRows.slice(Math.max(0, index - 6), index + 1);
    if (window.length < 7) continue;
    const values = window.map((row) => row.hrv);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const rollingCv = mean > 0 ? (Math.sqrt(variance) / mean) * 100 : null;
    const current = hrvRows[index];
    if (!current) continue;
    computed.push({
      date: current.date,
      hrv: Math.round(current.hrv * 10) / 10,
      rollingMean: Math.round(mean * 10) / 10,
      rollingCoefficientOfVariation: rollingCv != null ? Math.round(rollingCv * 100) / 100 : null,
    });
  }

  const cutoffStr = dateWindowStartString(endDate, days);
  return computed.filter((row) => row.date > cutoffStr);
}

function deriveTrends(rows: DailyMetricsViewRow[]): MobileRecoveryTrends | null {
  if (rows.length === 0) return null;
  const latestSpo2 = [...rows].reverse().find((row) => row.spo2_avg != null)?.spo2_avg ?? null;
  const latestSkinTemp =
    [...rows].reverse().find((row) => row.skin_temp_c != null)?.skin_temp_c ?? null;
  return {
    latest_spo2: latestSpo2,
    latest_skin_temp: latestSkinTemp,
  };
}

function filterDailyMetrics(rows: DailyMetricsViewRow[], days: number, endDate: string) {
  const cutoffStr = dateWindowStartString(endDate, days);
  return rows.filter((row) => row.date > cutoffStr);
}

export async function loadMobileRecoveryTab(
  ctx: MobileRecoveryTabContext,
  days: number,
  endDate: string,
): Promise<MobileRecoveryTabResult> {
  const metricsRepo = new DailyMetricsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.accessWindow,
  );
  const bodyRepo = new BodyAnalyticsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.accessWindow,
    ctx.sensorStore,
  );
  const settingsRepo = new SettingsRepository(ctx.db, ctx.userId);
  const recoveryRepo = new RecoveryBaselineRepository(
    ctx.userId,
    ctx.sensorStore,
    ctx.accessWindow,
  );

  const metricsQueryDays = days + 60;
  const weightDays = Math.max(days, 90);
  const healthspanWeeks = Math.max(Math.ceil(days / 7), 4);
  const recoveryStartDate = dateWindowStartString(endDate, Math.max(0, days - 1));

  const [storedParams, recoveryRows, dailyMetricsRows, restingHeartRateCte, goalSetting] =
    await Promise.all([
      loadPersonalizedParams(ctx.db, ctx.userId),
      recoveryRepo.listRange(recoveryStartDate, endDate, {
        priority: "dashboard",
      }),
      metricsRepo.list(metricsQueryDays, endDate),
      fetchRestingHeartRateValuesCte({
        sensorStore: ctx.sensorStore,
        userId: ctx.userId,
        timezone: ctx.timezone,
        endDate,
        days: metricsQueryDays,
      }),
      settingsRepo.get("goalWeight"),
    ]);

  const effective = getEffectiveParams(storedParams);
  const recoveryRowsInWindow = recoveryRows.filter(
    (row) => row.date >= recoveryStartDate && row.date <= endDate,
  );
  const readinessScore = computeReadinessRows(recoveryRowsInWindow, effective.readinessWeights);
  const stress = computeStressFromRows(recoveryRowsInWindow, effective.stressThresholds);
  const dailyMetrics = filterDailyMetrics(dailyMetricsRows, days, endDate);
  const metricEvidenceRows = filterDailyMetrics(
    dailyMetricsRows,
    Math.max(days, HEALTH_METRIC_EVIDENCE_WINDOW_DAYS),
    endDate,
  );
  const evidenceWindowDays = Math.max(days, HEALTH_METRIC_EVIDENCE_WINDOW_DAYS);
  const baselineRelative = latestRecoveryBaselineMetrics(recoveryRowsInWindow);
  const processingStatus = ctx.processingStatus ?? null;

  const metricObservations = (metric: "hrv" | "spo2" | "steps" | "skin_temperature") =>
    metricEvidenceRows.map((row) => ({
      date: row.date,
      value:
        metric === "hrv"
          ? row.hrv
          : metric === "spo2"
            ? row.spo2_avg
            : metric === "steps"
              ? row.steps
              : row.skin_temp_c,
      sourceProviders: row.source_providers,
    }));
  const hrvEvidence = buildHealthMetricEvidence(metricObservations("hrv"), evidenceWindowDays);

  const parsedGoalWeightKg = goalSetting?.value != null ? Number(goalSetting.value) : null;
  const goalWeightKg =
    parsedGoalWeightKg != null && Number.isFinite(parsedGoalWeightKg) ? parsedGoalWeightKg : null;

  const [hrvBaseline, weight, bodyFat, weightPrediction, healthspanRaw, decisionContext] =
    await Promise.all([
      metricsRepo.getHrvBaseline(days, endDate, restingHeartRateCte),
      bodyRepo.getSmoothedWeight(weightDays, endDate),
      bodyRepo.getRecomposition(days, endDate),
      bodyRepo.getWeightPrediction(weightDays, endDate, goalWeightKg),
      fetchHealthspanRawData(
        {
          userId: ctx.userId,
          timezone: ctx.timezone,
          accessWindow: ctx.accessWindow,
          sensorStore: ctx.sensorStore,
        },
        endDate,
        healthspanWeeks * 7,
      ),
      bodyRepo.getBodyDecisionContext(endDate).catch((error: unknown) => {
        captureException(error);
        return null;
      }),
    ]);

  const restingHeartRateBaseline = baselineRelative.find(
    (metric) => metric.metric === "resting_heart_rate",
  );
  const restingHeartRateStatus = restingHeartRateBaseline
    ? buildHealthStatusFromBaselineMetric(restingHeartRateBaseline, processingStatus)
    : buildHealthStatusFromValues({
        metric: "resting_heart_rate",
        label: "Resting Heart Rate",
        values: hrvBaseline.flatMap((row) => (row.resting_hr == null ? [] : [row.resting_hr])),
        intent: "lower",
        processingStatus,
      });

  const healthStatus = [
    ...baselineRelative
      .filter((metric) => metric.metric !== "resting_heart_rate")
      .map((metric) =>
        buildHealthStatusFromBaselineMetric(
          metric,
          processingStatus,
          metric.metric === "hrv" ? hrvEvidence.provenance : null,
        ),
      ),
    restingHeartRateStatus,
    buildHealthStatusFromValues({
      metric: "spo2",
      label: "Blood Oxygen Saturation (SpO2)",
      values: dailyMetrics.flatMap((row) => (row.spo2_avg == null ? [] : [row.spo2_avg])),
      intent: "neutral",
      observations: metricObservations("spo2"),
      windowDays: evidenceWindowDays,
      processingStatus,
    }),
    buildHealthStatusFromValues({
      metric: "steps",
      label: "Steps",
      values: dailyMetrics.flatMap((row) => (row.steps == null ? [] : [row.steps])),
      intent: "neutral",
      observations: metricObservations("steps"),
      windowDays: evidenceWindowDays,
      processingStatus,
    }),
    buildHealthStatusFromValues({
      metric: "skin_temperature",
      label: "Skin Temperature",
      values: dailyMetrics.flatMap((row) => (row.skin_temp_c == null ? [] : [row.skin_temp_c])),
      intent: "neutral",
      observations: metricObservations("skin_temperature"),
      windowDays: evidenceWindowDays,
      processingStatus,
    }),
    buildWeightHealthStatus(
      weight.map((row) => row.smoothedWeight),
      goalWeightKg,
      processingStatus,
    ),
  ];

  return {
    hrvVariability: computeHrvVariability(dailyMetricsRows, days, endDate),
    hrvBaseline,
    readinessScore,
    stress,
    trends: deriveTrends(dailyMetrics),
    dailyMetrics,
    weight,
    bodyFat: bodyFat.map(({ date, bodyFatPct }) => ({ date, bodyFatPct })),
    decisionContext,
    weightPrediction,
    baselineRelative,
    healthStatus,
    healthspan: buildHealthspanResult(healthspanRaw),
  };
}
