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
import { zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  type MobileRecoveryTabResult,
  mobileRecoveryTabOutputSchema,
} from "../contracts/mobile-dashboard-contracts.ts";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import {
  DailyMetricsRepository,
  type DailyMetricsViewRow,
} from "../repositories/daily-metrics-repository.ts";
import { fetchRestingHeartRateValuesCte } from "../repositories/resting-heart-rate-query.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import type { StressResult } from "../repositories/stress-repository.ts";
import { buildHealthspanResult } from "../routers/healthspan.ts";
import { fetchHealthspanRawData } from "../routers/healthspan-query.ts";
import type { HrvVariabilityRow, ReadinessRow } from "../routers/recovery.ts";
import { buildHealthStatusFromValues, buildWeightHealthStatus } from "./health-status.ts";

export { type MobileRecoveryTabResult, mobileRecoveryTabOutputSchema };

const recoveryRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  respiratory_rate: z.coerce.number().nullable(),
  hrv_mean_30d: z.coerce.number().nullable(),
  hrv_sd_30d: z.coerce.number().nullable(),
  rhr_mean_30d: z.coerce.number().nullable(),
  rhr_sd_30d: z.coerce.number().nullable(),
  rr_mean_30d: z.coerce.number().nullable(),
  rr_sd_30d: z.coerce.number().nullable(),
  hrv_mean_60d: z.coerce.number().nullable(),
  hrv_sd_60d: z.coerce.number().nullable(),
  rhr_mean_60d: z.coerce.number().nullable(),
  rhr_sd_60d: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

type RecoveryRow = z.infer<typeof recoveryRowSchema>;

export type MobileRecoveryTrends = NonNullable<MobileRecoveryTabResult["trends"]>;

interface MobileRecoveryTabContext {
  db: Pick<Database, "execute" | "transaction">;
  userId: string;
  timezone: string;
  accessWindow: AccessWindow;
  sensorStore: ActivitySensorStore;
}

function recoveryAccessClause(accessWindow?: AccessWindow): string {
  return accessWindow?.kind === "limited"
    ? `AND recovery_inputs.date >= toDate({accessStartDate:String})
       AND recovery_inputs.date < toDate({accessEndDateExclusive:String})`
    : "";
}

function recoveryAccessParams(accessWindow?: AccessWindow): Record<string, string> {
  return accessWindow?.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

async function fetchRecoveryRows(
  ctx: MobileRecoveryTabContext,
  endDate: string,
  queryDays: number,
): Promise<RecoveryRow[]> {
  return ctx.sensorStore.query(
    recoveryRowSchema,
    `SELECT
      toString(recovery_inputs.date) AS date,
      hrv,
      resting_hr,
      respiratory_rate,
      hrv_mean_30d,
      hrv_sd_30d,
      rhr_mean_30d,
      rhr_sd_30d,
      rr_mean_30d,
      rr_sd_30d,
      hrv_mean_60d,
      hrv_sd_60d,
      rhr_mean_60d,
      rhr_sd_60d,
      efficiency_pct
    FROM analytics.daily_recovery AS recovery_inputs FINAL
    WHERE recovery_inputs.user_id = {userId:UUID}
      AND recovery_inputs.is_deleted = 0
      AND recovery_inputs.date > toDate({windowStart:String})
      AND recovery_inputs.date <= toDate({endDate:String})
      ${recoveryAccessClause(ctx.accessWindow)}
    ORDER BY recovery_inputs.date ASC`,
    {
      userId: ctx.userId,
      windowStart: dateWindowStartString(endDate, queryDays),
      endDate,
      ...recoveryAccessParams(ctx.accessWindow),
    },
    { priority: "dashboard" },
  );
}

function computeReadinessRows(
  rows: RecoveryRow[],
  days: number,
  endDate: string,
  weights: ReadinessWeights,
): ReadinessRow[] {
  const cutoffDate = new Date(`${endDate}T00:00:00Z`);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const results: ReadinessRow[] = [];
  for (const metrics of rows) {
    if (metrics.date <= cutoffStr || metrics.date > endDate) continue;

    let hrvScore = 62;
    if (
      metrics.hrv != null &&
      metrics.hrv_mean_30d != null &&
      metrics.hrv_sd_30d != null &&
      Number(metrics.hrv_sd_30d) > 0
    ) {
      const zHrv =
        (Number(metrics.hrv) - Number(metrics.hrv_mean_30d)) / Number(metrics.hrv_sd_30d);
      hrvScore = zScoreToRecoveryScore(zHrv);
    }

    let restingHrScore = 62;
    if (
      metrics.resting_hr != null &&
      metrics.rhr_mean_30d != null &&
      metrics.rhr_sd_30d != null &&
      Number(metrics.rhr_sd_30d) > 0
    ) {
      const zRhr =
        (Number(metrics.resting_hr) - Number(metrics.rhr_mean_30d)) / Number(metrics.rhr_sd_30d);
      restingHrScore = zScoreToRecoveryScore(-zRhr);
    }

    const efficiency = metrics.efficiency_pct != null ? Number(metrics.efficiency_pct) : null;
    const sleepScore = efficiency != null ? Math.max(0, Math.min(100, Math.round(efficiency))) : 62;

    let respiratoryRateScore = 62;
    if (
      metrics.respiratory_rate != null &&
      metrics.rr_mean_30d != null &&
      metrics.rr_sd_30d != null &&
      Number(metrics.rr_sd_30d) > 0
    ) {
      const zRr =
        (Number(metrics.respiratory_rate) - Number(metrics.rr_mean_30d)) /
        Number(metrics.rr_sd_30d);
      respiratoryRateScore = zScoreToRecoveryScore(-zRr);
    }

    const components: ReadinessComponents = {
      hrvScore: Math.round(hrvScore),
      restingHrScore: Math.round(restingHrScore),
      sleepScore,
      respiratoryRateScore: Math.round(respiratoryRateScore),
    };
    const readiness = new ReadinessScore(components, weights);
    results.push({
      date: metrics.date,
      readinessScore: readiness.score,
      components: readiness.components,
      weights,
    });
  }
  return results;
}

function computeStressFromRows(
  rows: RecoveryRow[],
  days: number,
  endDate: string,
  stressThresholds: ReturnType<typeof getEffectiveParams>["stressThresholds"],
): StressResult {
  const cutoffStr = dateWindowStartString(endDate, days);
  const filtered = rows.filter((row) => row.date > cutoffStr && row.date <= endDate);

  const daily = filtered.map((row) => {
    const hrvDeviation =
      row.hrv != null &&
      row.hrv_mean_60d != null &&
      row.hrv_sd_60d != null &&
      Number(row.hrv_sd_60d) > 0
        ? Math.round(
            ((Number(row.hrv) - Number(row.hrv_mean_60d)) / Number(row.hrv_sd_60d)) * 100,
          ) / 100
        : null;
    const restingHrDeviation =
      row.resting_hr != null &&
      row.rhr_mean_60d != null &&
      row.rhr_sd_60d != null &&
      Number(row.rhr_sd_60d) > 0
        ? Math.round(
            ((Number(row.resting_hr) - Number(row.rhr_mean_60d)) / Number(row.rhr_sd_60d)) * 100,
          ) / 100
        : null;
    const sleepEfficiency = row.efficiency_pct != null ? Number(row.efficiency_pct) : null;
    const { stressScore } = computeDailyStress(
      { hrvDeviation, restingHrDeviation, sleepEfficiency },
      stressThresholds,
    );
    return {
      date: row.date,
      stressScore,
      hrvDeviation,
      restingHrDeviation,
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

  const recoveryQueryDays = days + 60;
  const metricsQueryDays = days + 60;
  const weightDays = Math.max(days, 90);
  const healthspanWeeks = Math.max(Math.ceil(days / 7), 4);

  const [storedParams, recoveryRows, dailyMetricsRows, restingHeartRateCte, goalSetting] =
    await Promise.all([
      loadPersonalizedParams(ctx.db, ctx.userId),
      fetchRecoveryRows(ctx, endDate, recoveryQueryDays),
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
  const readinessScore = computeReadinessRows(
    recoveryRows,
    days,
    endDate,
    effective.readinessWeights,
  );
  const stress = computeStressFromRows(recoveryRows, days, endDate, effective.stressThresholds);
  const dailyMetrics = filterDailyMetrics(dailyMetricsRows, days, endDate);

  const parsedGoalWeightKg = goalSetting?.value != null ? Number(goalSetting.value) : null;
  const goalWeightKg =
    parsedGoalWeightKg != null && Number.isFinite(parsedGoalWeightKg) ? parsedGoalWeightKg : null;

  const [hrvBaseline, weight, weightPrediction, healthspanRaw] = await Promise.all([
    metricsRepo.getHrvBaseline(days, endDate, restingHeartRateCte),
    bodyRepo.getSmoothedWeight(weightDays, endDate),
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
  ]);

  const healthStatus = [
    buildHealthStatusFromValues({
      metric: "hrv",
      label: "Heart Rate Variability (HRV)",
      values: hrvBaseline.flatMap((row) => (row.hrv == null ? [] : [row.hrv])),
      intent: "higher",
    }),
    buildHealthStatusFromValues({
      metric: "resting_heart_rate",
      label: "Resting Heart Rate",
      values: hrvBaseline.flatMap((row) => (row.resting_hr == null ? [] : [row.resting_hr])),
      intent: "lower",
    }),
    buildHealthStatusFromValues({
      metric: "spo2",
      label: "SpO2",
      values: dailyMetrics.flatMap((row) => (row.spo2_avg == null ? [] : [row.spo2_avg])),
      intent: "neutral",
    }),
    buildHealthStatusFromValues({
      metric: "steps",
      label: "Steps",
      values: dailyMetrics.flatMap((row) => (row.steps == null ? [] : [row.steps])),
      intent: "neutral",
    }),
    buildHealthStatusFromValues({
      metric: "skin_temperature",
      label: "Skin Temperature",
      values: dailyMetrics.flatMap((row) => (row.skin_temp_c == null ? [] : [row.skin_temp_c])),
      intent: "neutral",
    }),
    buildWeightHealthStatus(
      weight.map((row) => row.smoothedWeight),
      goalWeightKg,
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
    weightPrediction,
    healthStatus,
    healthspan: buildHealthspanResult(healthspanRaw),
  };
}
