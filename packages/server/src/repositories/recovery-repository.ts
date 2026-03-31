import { type ReadinessComponents, ReadinessScore } from "@dofek/recovery/readiness";
import { computeSleepConsistencyScore } from "@dofek/recovery/sleep-consistency";
import { StrainScore, zScoreToRecoveryScore } from "@dofek/scoring/scoring";
import { computeStrainTarget } from "@dofek/scoring/strain-target";
import { selectRecentDailyLoad } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowEnd, dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface SleepConsistencyDayRow {
  date: string;
  bedtimeHour: number;
  waketimeHour: number;
  rollingBedtimeStddev: number | null;
  rollingWaketimeStddev: number | null;
  windowCount: number;
}

/** A single day's sleep schedule consistency data. */
export class SleepConsistencyDay {
  readonly #row: SleepConsistencyDayRow;

  constructor(row: SleepConsistencyDayRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get bedtimeHour(): number {
    return Math.round(this.#row.bedtimeHour * 100) / 100;
  }

  get waketimeHour(): number {
    return Math.round(this.#row.waketimeHour * 100) / 100;
  }

  get rollingBedtimeStddev(): number | null {
    return this.#row.rollingBedtimeStddev != null
      ? Math.round(this.#row.rollingBedtimeStddev * 100) / 100
      : null;
  }

  get rollingWaketimeStddev(): number | null {
    return this.#row.rollingWaketimeStddev != null
      ? Math.round(this.#row.rollingWaketimeStddev * 100) / 100
      : null;
  }

  get consistencyScore(): number | null {
    if (this.#row.windowCount < 7) return null;
    return computeSleepConsistencyScore(
      this.#row.rollingBedtimeStddev,
      this.#row.rollingWaketimeStddev,
    );
  }

  toDetail() {
    return {
      date: this.date,
      bedtimeHour: this.bedtimeHour,
      waketimeHour: this.waketimeHour,
      rollingBedtimeStddev: this.rollingBedtimeStddev,
      rollingWaketimeStddev: this.rollingWaketimeStddev,
      consistencyScore: this.consistencyScore,
    };
  }
}

export interface HrvVariabilityDayRow {
  date: string;
  hrv: number | null;
  rollingMean: number | null;
  rollingCoefficientOfVariation: number | null;
}

/** A single day's HRV variability data with rolling statistics. */
export class HrvVariabilityDay {
  readonly #row: HrvVariabilityDayRow;

  constructor(row: HrvVariabilityDayRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      hrv: this.#row.hrv != null ? Math.round(this.#row.hrv * 10) / 10 : null,
      rollingCoefficientOfVariation:
        this.#row.rollingCoefficientOfVariation != null
          ? Math.round(this.#row.rollingCoefficientOfVariation * 100) / 100
          : null,
      rollingMean:
        this.#row.rollingMean != null ? Math.round(this.#row.rollingMean * 10) / 10 : null,
    };
  }
}

export interface WorkloadDayRow {
  date: string;
  dailyLoad: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

/** A single day's workload ratio data with strain computation. */
export class WorkloadDay {
  readonly #row: WorkloadDayRow;

  constructor(row: WorkloadDayRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get dailyLoad(): number {
    return Math.round(this.#row.dailyLoad * 10) / 10;
  }

  get strain(): number {
    return StrainScore.fromRawLoad(this.dailyLoad).value;
  }

  get acuteLoad(): number {
    return Math.round(this.#row.acuteLoad * 10) / 10;
  }

  get chronicLoad(): number {
    return Math.round(this.#row.chronicLoad * 10) / 10;
  }

  get workloadRatio(): number | null {
    return this.#row.workloadRatio != null ? Math.round(this.#row.workloadRatio * 100) / 100 : null;
  }

  toDetail() {
    return {
      date: this.date,
      dailyLoad: this.dailyLoad,
      strain: this.strain,
      acuteLoad: this.acuteLoad,
      chronicLoad: this.chronicLoad,
      workloadRatio: this.workloadRatio,
    };
  }
}

/** Compute displayed strain from workload time series. */
export function computeWorkloadResult(days: WorkloadDay[]) {
  const timeSeries = days.map((day) => day.toDetail());
  const displayed = selectRecentDailyLoad(timeSeries);
  return {
    timeSeries,
    displayedStrain: displayed?.strain ?? 0,
    displayedDate: displayed?.date ?? null,
  };
}

export interface SleepNightRow {
  date: string;
  durationMinutes: number;
  sleepMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
  rollingAvgDuration: number | null;
}

/** A single night's sleep data with stage percentages. */
export class SleepNight {
  readonly #row: SleepNightRow;

  constructor(row: SleepNightRow) {
    this.#row = row;
  }

  get sleepMinutes(): number {
    return this.#row.sleepMinutes;
  }

  toDetail() {
    return {
      date: this.#row.date,
      durationMinutes: this.#row.durationMinutes,
      sleepMinutes: this.#row.sleepMinutes,
      deepPct: Math.round(this.#row.deepPct * 10) / 10,
      remPct: Math.round(this.#row.remPct * 10) / 10,
      lightPct: Math.round(this.#row.lightPct * 10) / 10,
      awakePct: Math.round(this.#row.awakePct * 10) / 10,
      efficiency: Math.round(this.#row.efficiency * 10) / 10,
      rollingAvgDuration:
        this.#row.rollingAvgDuration != null
          ? Math.round(this.#row.rollingAvgDuration * 10) / 10
          : null,
    };
  }
}

/** Compute sleep debt from the last 14 nights against a target. */
export function computeSleepDebt(nights: SleepNight[], targetMinutes: number): number {
  const last14 = nights.slice(-14);
  const debt = last14.reduce((accumulated, night) => {
    return accumulated + (targetMinutes - night.sleepMinutes);
  }, 0);
  return Math.round(debt);
}

export interface ReadinessDayRow {
  date: string;
  hrv: number | null;
  restingHr: number | null;
  respiratoryRate: number | null;
  hrvMean30d: number | null;
  hrvSd30d: number | null;
  rhrMean30d: number | null;
  rhrSd30d: number | null;
  rrMean30d: number | null;
  rrSd30d: number | null;
  efficiencyPct: number | null;
}

/** Compute component scores and readiness for a single day's metrics. */
export function computeReadinessComponents(row: ReadinessDayRow): ReadinessComponents {
  // HRV score: higher HRV = better (positive z = good)
  let hrvScore = 62;
  if (row.hrv != null && row.hrvMean30d != null && row.hrvSd30d != null && row.hrvSd30d > 0) {
    const zHrv = (row.hrv - row.hrvMean30d) / row.hrvSd30d;
    hrvScore = zScoreToRecoveryScore(zHrv);
  }

  // Resting HR score: lower HR = better (invert z)
  let restingHrScore = 62;
  if (row.restingHr != null && row.rhrMean30d != null && row.rhrSd30d != null && row.rhrSd30d > 0) {
    const zRhr = (row.restingHr - row.rhrMean30d) / row.rhrSd30d;
    restingHrScore = zScoreToRecoveryScore(-zRhr);
  }

  // Sleep efficiency score: direct mapping (0-100 already)
  const sleepScore =
    row.efficiencyPct != null ? Math.max(0, Math.min(100, Math.round(row.efficiencyPct))) : 62;

  // Respiratory rate score: lower is better (invert z, like RHR)
  let respiratoryRateScore = 62;
  if (
    row.respiratoryRate != null &&
    row.rrMean30d != null &&
    row.rrSd30d != null &&
    row.rrSd30d > 0
  ) {
    const zRr = (row.respiratoryRate - row.rrMean30d) / row.rrSd30d;
    respiratoryRateScore = zScoreToRecoveryScore(-zRr);
  }

  return {
    hrvScore: Math.round(hrvScore),
    restingHrScore: Math.round(restingHrScore),
    sleepScore,
    respiratoryRateScore: Math.round(respiratoryRateScore),
  };
}

export interface StrainTargetInput {
  readinessScore: number;
  chronicLoad: number;
  acuteLoad: number;
  currentStrain: number;
}

/** Compute strain target from readiness and training loads. */
export function computeStrainTargetResult(input: StrainTargetInput) {
  const target = computeStrainTarget(input.readinessScore, input.chronicLoad, input.acuteLoad);
  return {
    targetStrain: target.targetStrain,
    currentStrain: Math.round(input.currentStrain * 10) / 10,
    progressPercent:
      target.targetStrain > 0 ? Math.round((input.currentStrain / target.targetStrain) * 100) : 0,
    zone: target.zone,
    explanation: target.explanation,
  };
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const consistencyRowSchema = z.object({
  date: dateStringSchema,
  bedtime_hour: z.coerce.number(),
  waketime_hour: z.coerce.number(),
  rolling_bedtime_stddev: z.coerce.number().nullable(),
  rolling_waketime_stddev: z.coerce.number().nullable(),
  window_count: z.coerce.number(),
});

const hrvRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  rolling_mean: z.coerce.number().nullable(),
  rolling_cv: z.coerce.number().nullable(),
});

const workloadRowSchema = z.object({
  date: dateStringSchema,
  daily_load: z.coerce.number(),
  acute_load: z.coerce.number(),
  chronic_load: z.coerce.number(),
  workload_ratio: z.coerce.number().nullable(),
});

const sleepRowSchema = z.object({
  date: dateStringSchema,
  duration_minutes: z.coerce.number(),
  sleep_minutes: z.coerce.number(),
  deep_pct: z.coerce.number(),
  rem_pct: z.coerce.number(),
  light_pct: z.coerce.number(),
  awake_pct: z.coerce.number(),
  efficiency: z.coerce.number(),
  rolling_avg_duration: z.coerce.number().nullable(),
});

const readinessRowSchema = z.object({
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
  efficiency_pct: z.coerce.number().nullable(),
});

const strainMetricsRowSchema = z.object({
  date: dateStringSchema,
  resting_hr: z.number().nullable(),
  hrv: z.number().nullable(),
  spo2_avg: z.number().nullable(),
  respiratory_rate_avg: z.number().nullable(),
});

const strainDailyLoadRowSchema = z.object({
  date: dateStringSchema,
  daily_load: z.coerce.number(),
});

const strainSleepRowSchema = z.object({
  efficiency_pct: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for recovery, sleep, and readiness analytics. */
export class RecoveryRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Sleep schedule consistency with rolling 14-day stddev windows. */
  async getSleepConsistency(days: number): Promise<SleepConsistencyDay[]> {
    const queryDays = days + 14;
    const rows = await executeWithSchema(
      this.#db,
      consistencyRowSchema,
      sql`WITH sleep_raw AS (
            SELECT
              (started_at AT TIME ZONE ${this.#timezone})::date AS date,
              EXTRACT(HOUR FROM started_at AT TIME ZONE ${this.#timezone}) + EXTRACT(MINUTE FROM started_at AT TIME ZONE ${this.#timezone}) / 60.0 AS bedtime_hour,
              EXTRACT(HOUR FROM ended_at AT TIME ZONE ${this.#timezone}) + EXTRACT(MINUTE FROM ended_at AT TIME ZONE ${this.#timezone}) / 60.0 AS waketime_hour,
              duration_minutes
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at > NOW() - ${queryDays}::int * INTERVAL '1 day'
          ),
          nightly AS (
            SELECT DISTINCT ON (date) date, bedtime_hour, waketime_hour
            FROM sleep_raw
            ORDER BY date, duration_minutes DESC NULLS LAST
          )
          SELECT
            date::text,
            bedtime_hour,
            waketime_hour,
            STDDEV_POP(bedtime_hour) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS rolling_bedtime_stddev,
            STDDEV_POP(waketime_hour) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS rolling_waketime_stddev,
            COUNT(*) OVER (ORDER BY date ROWS BETWEEN 13 PRECEDING AND CURRENT ROW) AS window_count
          FROM nightly
          WHERE date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new SleepConsistencyDay({
          date: row.date,
          bedtimeHour: Number(row.bedtime_hour),
          waketimeHour: Number(row.waketime_hour),
          rollingBedtimeStddev:
            row.rolling_bedtime_stddev != null ? Number(row.rolling_bedtime_stddev) : null,
          rollingWaketimeStddev:
            row.rolling_waketime_stddev != null ? Number(row.rolling_waketime_stddev) : null,
          windowCount: Number(row.window_count),
        }),
    );
  }

  /** Rolling 7-day coefficient of variation of HRV. */
  async getHrvVariability(days: number): Promise<HrvVariabilityDay[]> {
    const queryDays = days + 7;
    const rows = await executeWithSchema(
      this.#db,
      hrvRowSchema,
      sql`WITH daily AS (
            SELECT
              date,
              hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > CURRENT_DATE - ${queryDays}::int
              AND hrv IS NOT NULL
            ORDER BY date ASC
          )
          SELECT
            date::text AS date,
            hrv,
            AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_mean,
            CASE
              WHEN AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) > 0
                AND COUNT(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) = 7
              THEN (STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
                    / AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)) * 100
              ELSE NULL
            END AS rolling_cv
          FROM daily
          WHERE date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new HrvVariabilityDay({
          date: row.date,
          hrv: row.hrv != null ? Number(row.hrv) : null,
          rollingMean: row.rolling_mean != null ? Number(row.rolling_mean) : null,
          rollingCoefficientOfVariation: row.rolling_cv != null ? Number(row.rolling_cv) : null,
        }),
    );
  }

  /** Acute:Chronic Workload Ratio time series. */
  async getWorkloadRatio(days: number, endDate: string): Promise<WorkloadDay[]> {
    const queryDays = days + 28;
    const rows = await executeWithSchema(
      this.#db,
      workloadRowSchema,
      sql`WITH date_series AS (
            SELECT generate_series(
              ${dateWindowStart(endDate, queryDays)},
              ${dateWindowEnd(endDate)},
              '1 day'::interval
            )::date AS date
          ),
          per_activity AS (
            SELECT
              (asum.started_at AT TIME ZONE ${this.#timezone})::date AS date,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                * asum.avg_hr
                / NULLIF(asum.max_hr, 0) AS load
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${this.#userId}
              AND (asum.started_at AT TIME ZONE ${this.#timezone})::date >= ${dateWindowStart(endDate, queryDays)}
              AND asum.ended_at IS NOT NULL
              AND asum.avg_hr IS NOT NULL
          ),
          activity_load AS (
            SELECT date, SUM(load) AS daily_load
            FROM per_activity
            GROUP BY date
          ),
          daily AS (
            SELECT
              ds.date,
              COALESCE(al.daily_load, 0) AS daily_load
            FROM date_series ds
            LEFT JOIN activity_load al ON al.date = ds.date
          ),
          with_windows AS (
            SELECT
              date,
              daily_load,
              SUM(daily_load) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS acute_load,
              AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg,
              COUNT(*) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_count
            FROM daily
          )
          SELECT
            date::text AS date,
            daily_load,
            acute_load,
            chronic_load_avg * 7 AS chronic_load,
            CASE
              WHEN chronic_load_avg > 0 AND chronic_count = 28
              THEN acute_load / (chronic_load_avg * 7)
              ELSE NULL
            END AS workload_ratio
          FROM with_windows
          WHERE date > ${dateWindowStart(endDate, days)}
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new WorkloadDay({
          date: row.date,
          dailyLoad: Number(row.daily_load),
          acuteLoad: Number(row.acute_load),
          chronicLoad: Number(row.chronic_load),
          workloadRatio: row.workload_ratio != null ? Number(row.workload_ratio) : null,
        }),
    );
  }

  /** Sleep analytics: stage percentages, rolling avg duration. */
  async getSleepNights(days: number): Promise<SleepNight[]> {
    const rows = await executeWithSchema(
      this.#db,
      sleepRowSchema,
      sql`WITH sleep_raw AS (
            SELECT
              (started_at AT TIME ZONE ${this.#timezone})::date AS date,
              duration_minutes,
              CASE
                WHEN provider_id = 'apple_health'
                  AND (deep_minutes IS NOT NULL OR rem_minutes IS NOT NULL OR light_minutes IS NOT NULL)
                  THEN COALESCE(deep_minutes, 0) + COALESCE(rem_minutes, 0) + COALESCE(light_minutes, 0)
                ELSE duration_minutes
              END AS sleep_minutes,
              deep_minutes,
              rem_minutes,
              light_minutes,
              awake_minutes,
              efficiency_pct,
              CASE WHEN duration_minutes > 0 THEN deep_minutes::real / duration_minutes * 100 ELSE 0 END AS deep_pct,
              CASE WHEN duration_minutes > 0 THEN rem_minutes::real / duration_minutes * 100 ELSE 0 END AS rem_pct,
              CASE WHEN duration_minutes > 0 THEN light_minutes::real / duration_minutes * 100 ELSE 0 END AS light_pct,
              CASE WHEN duration_minutes > 0 THEN awake_minutes::real / duration_minutes * 100 ELSE 0 END AS awake_pct
            FROM fitness.v_sleep
            WHERE user_id = ${this.#userId}
              AND is_nap = false
              AND started_at > NOW() - ${days}::int * INTERVAL '1 day'
          ),
          nightly AS (
            SELECT DISTINCT ON (date)
              date, duration_minutes, sleep_minutes, deep_minutes, rem_minutes,
              light_minutes, awake_minutes, efficiency_pct, deep_pct, rem_pct, light_pct, awake_pct
            FROM sleep_raw
            ORDER BY date, duration_minutes DESC NULLS LAST
          )
          SELECT
            date::text AS date,
            duration_minutes,
            sleep_minutes,
            deep_pct,
            rem_pct,
            light_pct,
            awake_pct,
            efficiency_pct AS efficiency,
            AVG(sleep_minutes) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS rolling_avg_duration
          FROM nightly
          ORDER BY date ASC`,
    );

    return rows.map(
      (row) =>
        new SleepNight({
          date: row.date,
          durationMinutes: Number(row.duration_minutes),
          sleepMinutes: Number(row.sleep_minutes),
          deepPct: Number(row.deep_pct),
          remPct: Number(row.rem_pct),
          lightPct: Number(row.light_pct),
          awakePct: Number(row.awake_pct),
          efficiency: Number(row.efficiency),
          rollingAvgDuration:
            row.rolling_avg_duration != null ? Number(row.rolling_avg_duration) : null,
        }),
    );
  }

  /** Compute sleep analytics including sleep debt. */
  async getSleepAnalytics(days: number) {
    const nights = await this.getSleepNights(days);
    const nightly = nights.map((night) => night.toDetail());

    const storedParams = await loadPersonalizedParams(this.#db, this.#userId);
    const effective = getEffectiveParams(storedParams);
    const targetMinutes = effective.sleepTarget.minutes;
    const sleepDebt = computeSleepDebt(nights, targetMinutes);

    return { nightly, sleepDebt };
  }

  /** Readiness metrics with baselines and sleep efficiency. */
  async getReadinessMetrics(days: number, endDate: string): Promise<ReadinessDayRow[]> {
    const queryDays = days + 30;
    const rows = await executeWithSchema(
      this.#db,
      readinessRowSchema,
      sql`WITH metrics_with_baselines AS (
            SELECT
              date::text AS date,
              hrv,
              resting_hr,
              respiratory_rate_avg AS respiratory_rate,
              AVG(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean_30d,
              STDDEV_POP(hrv) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd_30d,
              AVG(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean_30d,
              STDDEV_POP(resting_hr) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd_30d,
              AVG(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean_30d,
              STDDEV_POP(respiratory_rate_avg) OVER (ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd_30d
            FROM fitness.v_daily_metrics
            WHERE user_id = ${this.#userId}
              AND date > ${dateWindowStart(endDate, queryDays)}
          ),
          sleep_eff AS (
            SELECT DISTINCT ON (local_date)
              local_date::text AS date,
              efficiency_pct
            FROM (
              SELECT (COALESCE(ended_at, started_at + interval '8 hours') AT TIME ZONE ${this.#timezone})::date AS local_date,
                     efficiency_pct, duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${this.#userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(endDate, queryDays)}
            ) sleep_sub
            ORDER BY local_date, duration_minutes DESC NULLS LAST
          )
          SELECT
            m.date,
            m.hrv,
            m.resting_hr,
            m.respiratory_rate,
            m.hrv_mean_30d,
            m.hrv_sd_30d,
            m.rhr_mean_30d,
            m.rhr_sd_30d,
            m.rr_mean_30d,
            m.rr_sd_30d,
            s.efficiency_pct
          FROM metrics_with_baselines m
          LEFT JOIN sleep_eff s ON s.date = m.date
          ORDER BY m.date ASC`,
    );

    return rows.map((row) => ({
      date: row.date,
      hrv: row.hrv != null ? Number(row.hrv) : null,
      restingHr: row.resting_hr != null ? Number(row.resting_hr) : null,
      respiratoryRate: row.respiratory_rate != null ? Number(row.respiratory_rate) : null,
      hrvMean30d: row.hrv_mean_30d != null ? Number(row.hrv_mean_30d) : null,
      hrvSd30d: row.hrv_sd_30d != null ? Number(row.hrv_sd_30d) : null,
      rhrMean30d: row.rhr_mean_30d != null ? Number(row.rhr_mean_30d) : null,
      rhrSd30d: row.rhr_sd_30d != null ? Number(row.rhr_sd_30d) : null,
      rrMean30d: row.rr_mean_30d != null ? Number(row.rr_mean_30d) : null,
      rrSd30d: row.rr_sd_30d != null ? Number(row.rr_sd_30d) : null,
      efficiencyPct: row.efficiency_pct != null ? Number(row.efficiency_pct) : null,
    }));
  }

  /** Composite readiness scores over time. */
  async getReadinessScores(days: number, endDate: string) {
    const storedParams = await loadPersonalizedParams(this.#db, this.#userId);
    const effective = getEffectiveParams(storedParams);
    const weights = effective.readinessWeights;

    const metricsRows = await this.getReadinessMetrics(days, endDate);

    const cutoffDate = new Date(endDate);
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split("T")[0] ?? "";

    const results: Array<{
      date: string;
      readinessScore: number;
      components: ReadinessComponents;
    }> = [];

    for (const metrics of metricsRows) {
      if (metrics.date <= cutoffStr) continue;

      const components = computeReadinessComponents(metrics);
      const readiness = new ReadinessScore(components, weights);

      results.push({
        date: metrics.date,
        readinessScore: readiness.score,
        components: readiness.components,
      });
    }

    return results;
  }

  /** Fetch latest daily metrics for strain target computation. */
  async getLatestDailyMetrics() {
    const rows = await executeWithSchema(
      this.#db,
      strainMetricsRowSchema,
      sql`
        SELECT date, resting_hr, hrv, spo2_avg, respiratory_rate_avg
        FROM fitness.daily_metrics
        WHERE user_id = ${this.#userId}
        ORDER BY date DESC
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /** Fetch daily loads for ACWR. */
  async getDailyLoads(days: number, endDate: string) {
    return executeWithSchema(
      this.#db,
      strainDailyLoadRowSchema,
      sql`
        SELECT
          asum.started_at::date::text AS date,
          SUM(
            asum.avg_hr * EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0 / 100.0
          ) AS daily_load
        FROM fitness.activity_summary asum
        WHERE asum.user_id = ${this.#userId}
          AND asum.started_at::date >= ${dateWindowStart(endDate, days)}
          AND asum.ended_at IS NOT NULL
          AND asum.avg_hr IS NOT NULL
        GROUP BY asum.started_at::date
        ORDER BY date ASC
      `,
    );
  }

  /** Fetch latest sleep efficiency for strain target. */
  async getLatestSleepEfficiency() {
    const rows = await executeWithSchema(
      this.#db,
      strainSleepRowSchema,
      sql`
        SELECT efficiency_pct
        FROM fitness.sleep_session
        WHERE user_id = ${this.#userId}
          AND sleep_type = 'sleep'
        ORDER BY started_at DESC
        LIMIT 1
      `,
    );
    return rows[0]?.efficiency_pct ?? null;
  }

  /** Compute daily strain target based on readiness and training loads. */
  async getStrainTarget(days: number, endDate: string) {
    const readinessMetrics = await this.getLatestDailyMetrics();

    let readinessScore = 50;
    if (readinessMetrics) {
      const params = getEffectiveParams(await loadPersonalizedParams(this.#db, this.#userId));
      const sleepEff = await this.getLatestSleepEfficiency();
      const sleepScore = sleepEff != null ? Math.max(0, Math.min(100, Math.round(sleepEff))) : 62;
      const components: ReadinessComponents = {
        hrvScore:
          readinessMetrics.hrv != null
            ? Math.max(0, Math.min(100, Math.round(readinessMetrics.hrv)))
            : 62,
        restingHrScore:
          readinessMetrics.resting_hr != null
            ? Math.max(0, Math.min(100, 120 - readinessMetrics.resting_hr))
            : 62,
        sleepScore,
        respiratoryRateScore: 62,
      };
      const weights = params.readinessWeights;
      const score = new ReadinessScore(components, weights);
      readinessScore = score.score;
    }

    const loads = await this.getDailyLoads(days, endDate);

    const acuteWindow = 7;
    const chronicWindow = 28;
    let acuteLoad = 0;
    let chronicLoad = 0;
    let currentStrain = 0;

    for (const row of loads) {
      const daysAgo = Math.floor(
        (new Date(endDate).getTime() - new Date(row.date).getTime()) / 86400000,
      );
      if (daysAgo < acuteWindow) acuteLoad += row.daily_load;
      if (daysAgo < chronicWindow) chronicLoad += row.daily_load;
      if (row.date === endDate) {
        currentStrain = StrainScore.fromRawLoad(row.daily_load).value;
      }
    }
    acuteLoad /= acuteWindow;
    chronicLoad /= chronicWindow;

    return computeStrainTargetResult({
      readinessScore,
      chronicLoad,
      acuteLoad,
      currentStrain,
    });
  }
}
