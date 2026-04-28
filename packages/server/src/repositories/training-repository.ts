import { ZONE_BOUNDARIES_HRR } from "@dofek/zones/zones";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStart, timestampWindowStart } from "../lib/date-window.ts";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import {
  acwrCte,
  heartRateZoneColumns,
  restingHeartRateLateral,
  vitalsBaselineCte,
} from "../lib/sql-fragments.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for DB rows
// ---------------------------------------------------------------------------

const weeklyVolumeRowSchema = z.object({
  week: dateStringSchema,
  activity_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

export type WeeklyVolumeRow = z.infer<typeof weeklyVolumeRowSchema>;

const hrZoneRowSchema = z.object({
  max_hr: z.number().nullable(),
  week: dateStringSchema,
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type HrZoneRow = z.infer<typeof hrZoneRowSchema>;

const activityStatsRowSchema = z.object({
  id: z.string(),
  activity_type: z.string(),
  name: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  hr_samples: z.coerce.number().nullable(),
  power_samples: z.coerce.number().nullable(),
  distance_meters: z.coerce.number().nullable(),
});

export type ActivityStatsRow = z.infer<typeof activityStatsRowSchema>;

const readinessMetricSchema = z.object({
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
});

export type ReadinessMetricRow = z.infer<typeof readinessMetricSchema>;

const sleepRowSchema = z.object({
  efficiency_pct: z.coerce.number().nullable(),
});

const acwrRowSchema = z.object({
  acwr: z.coerce.number().nullable(),
});

const muscleFreshnessSchema = z.object({
  muscle_group: z.string(),
  last_trained_date: dateStringSchema,
});

export type MuscleFreshnessRow = z.infer<typeof muscleFreshnessSchema>;

const balanceSchema = z.object({
  strength_7d: z.coerce.number(),
  endurance_7d: z.coerce.number(),
  last_strength_date: dateStringSchema.nullable(),
  last_endurance_date: dateStringSchema.nullable(),
});

export type BalanceRow = z.infer<typeof balanceSchema>;

const zoneTotalsSchema = z.object({
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

export type ZoneTotalsRow = z.infer<typeof zoneTotalsSchema>;

const hiitLoadSchema = z.object({
  hiit_count_7d: z.coerce.number(),
  last_hiit_date: dateStringSchema.nullable(),
});

export type HiitLoadRow = z.infer<typeof hiitLoadSchema>;

const trainingDaySchema = z.object({
  training_date: dateStringSchema,
});

// ---------------------------------------------------------------------------
// Data bundle returned by getNextWorkoutData
// ---------------------------------------------------------------------------

export interface NextWorkoutData {
  latestMetric: ReadinessMetricRow | null;
  latestSleepEfficiency: number | null;
  acwr: number | null;
  muscleFreshness: MuscleFreshnessRow[];
  balance: BalanceRow;
  zoneTotals: ZoneTotalsRow;
  hiitLoad: HiitLoadRow;
  trainingDates: string[];
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class TrainingRepository extends BaseRepository {
  /** Weekly training volume grouped by activity type. */
  async getWeeklyVolume(days: number): Promise<WeeklyVolumeRow[]> {
    return this.queryWithViewRefresh(
      () =>
        this.query(
          weeklyVolumeRowSchema,
          sql`SELECT
                date_trunc('week', (started_at AT TIME ZONE ${this.timezone})::date)::date AS week,
                activity_type,
                COUNT(*)::int AS count,
                ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600)::numeric, 2) AS hours
              FROM fitness.v_activity
              WHERE user_id = ${this.userId}
                AND started_at > NOW() - ${days}::int * INTERVAL '1 day'
                AND ended_at IS NOT NULL
                ${this.timestampAccessPredicate(sql`started_at`)}
              GROUP BY 1, activity_type
              ORDER BY week`,
        ),
      days,
      "weeklyVolume",
    );
  }

  /** HR zone distribution per week using 5-zone Karvonen model. */
  async getHrZones(days: number): Promise<{ maxHr: number | null; weeks: HrZoneRow[] }> {
    const zones = heartRateZoneColumns(
      sql`ds.scalar`,
      sql`up.max_hr`,
      sql`rhr.resting_hr`,
      ZONE_BOUNDARIES_HRR,
    );

    const rows = await this.query(
      hrZoneRowSchema,
      sql`SELECT
            up.max_hr,
            date_trunc('week', (a.started_at AT TIME ZONE ${this.timezone})::date)::date AS week,
            ${zones.zone1} AS zone1,
            ${zones.zone2} AS zone2,
            ${zones.zone3} AS zone3,
            ${zones.zone4} AS zone4,
            ${zones.zone5} AS zone5
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.deduped_sensor ds ON ds.activity_id = a.id AND ds.channel = 'heart_rate'
          JOIN ${restingHeartRateLateral(sql`up.id`, sql`(a.started_at AT TIME ZONE ${this.timezone})::date`)}
          WHERE up.id = ${this.userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND ds.scalar IS NOT NULL
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          GROUP BY up.max_hr, 2
          ORDER BY week`,
    );
    const rawMaxHr = rows[0]?.max_hr;
    const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
    if (!maxHr) return { maxHr: null, weeks: [] };
    return { maxHr, weeks: rows };
  }

  /** Per-activity summary with HR and power stats. */
  async getActivityStats(days: number): Promise<ActivityStatsRow[]> {
    return this.queryWithViewRefresh(
      () =>
        this.query(
          activityStatsRowSchema,
          sql`SELECT
                a.id,
                a.activity_type,
                a.name,
                a.started_at,
                a.ended_at,
                ROUND(s.avg_hr::numeric, 1) AS avg_hr,
                s.max_hr,
                ROUND(s.avg_power::numeric, 1) AS avg_power,
                s.max_power,
                ROUND(s.avg_cadence::numeric, 1) AS avg_cadence,
                s.hr_sample_count AS hr_samples,
                s.power_sample_count AS power_samples,
                s.total_distance AS distance_meters
              FROM fitness.v_activity a
              LEFT JOIN fitness.activity_summary s ON s.activity_id = a.id
              WHERE a.user_id = ${this.userId}
                AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
                ${this.timestampAccessPredicate(sql`a.started_at`)}
              ORDER BY a.started_at DESC`,
        ),
      days,
      "activityStats",
    );
  }

  /** Fetch all raw data needed for the nextWorkout recommendation. */
  async getNextWorkoutData(endDate: string): Promise<NextWorkoutData> {
    const [
      latestMetrics,
      sleepRows,
      acwrRows,
      muscleFreshnessRows,
      balanceRows,
      zoneTotalsRows,
      hiitLoadRows,
      trainingDays,
    ] = await Promise.all([
      this.#fetchLatestMetrics(),
      this.#fetchLatestSleepEfficiency(),
      this.#fetchAcwr(endDate),
      this.#fetchMuscleFreshness(),
      this.#fetchBalance(endDate),
      this.#fetchZoneTotals(endDate),
      this.#fetchHiitLoad(endDate),
      this.#fetchTrainingDays(endDate),
    ]);

    return {
      latestMetric: latestMetrics[0] ?? null,
      latestSleepEfficiency: sleepRows[0]?.efficiency_pct ?? null,
      acwr: acwrRows[0]?.acwr ?? null,
      muscleFreshness: muscleFreshnessRows,
      balance: balanceRows[0] ?? {
        strength_7d: 0,
        endurance_7d: 0,
        last_strength_date: null,
        last_endurance_date: null,
      },
      zoneTotals: zoneTotalsRows[0] ?? { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 },
      hiitLoad: hiitLoadRows[0] ?? { hiit_count_7d: 0, last_hiit_date: null },
      trainingDates: trainingDays.map((day) => day.training_date),
    };
  }

  async #fetchLatestMetrics(): Promise<ReadinessMetricRow[]> {
    return this.query(
      readinessMetricSchema,
      sql`WITH ${vitalsBaselineCte(this.userId, "now", 1, 30)}
        SELECT
          vb.date::text AS date,
          vb.hrv,
          vb.resting_hr,
          vb.respiratory_rate_avg AS respiratory_rate,
          vb.hrv_mean_30d,
          vb.hrv_stddev_30d AS hrv_sd_30d,
          vb.resting_hr_mean_30d AS rhr_mean_30d,
          vb.resting_hr_stddev_30d AS rhr_sd_30d,
          vb.respiratory_rate_mean_30d AS rr_mean_30d,
          vb.respiratory_rate_stddev_30d AS rr_sd_30d
        FROM vitals_baseline vb
        ORDER BY vb.date DESC
        LIMIT 1`,
    );
  }

  async #fetchLatestSleepEfficiency(): Promise<z.infer<typeof sleepRowSchema>[]> {
    return this.query(
      sleepRowSchema,
      sql`SELECT efficiency_pct
        FROM fitness.v_sleep
        WHERE user_id = ${this.userId}
          AND is_nap = false
        ORDER BY COALESCE(ended_at, started_at + interval '8 hours') DESC
        LIMIT 1`,
    );
  }

  async #fetchAcwr(endDate: string): Promise<z.infer<typeof acwrRowSchema>[]> {
    return this.query(
      acwrRowSchema,
      sql`WITH ${acwrCte(this.userId, this.timezone, endDate, 0)}
        SELECT
          CASE
            WHEN chronic_load_avg > 0
            THEN acute_load / (chronic_load_avg * 7)
            ELSE NULL
          END AS acwr
        FROM acwr_with_windows
        ORDER BY date DESC
        LIMIT 1`,
    );
  }

  async #fetchMuscleFreshness(): Promise<MuscleFreshnessRow[]> {
    return this.query(
      muscleFreshnessSchema,
      sql`SELECT
          mg AS muscle_group,
          MAX((a.started_at AT TIME ZONE ${this.timezone})::date)::text AS last_trained_date
        FROM fitness.strength_set ss
        JOIN fitness.activity a ON a.id = ss.activity_id
        JOIN fitness.exercise e ON e.id = ss.exercise_id
        CROSS JOIN LATERAL unnest(e.muscle_groups) AS mg
        WHERE a.user_id = ${this.userId}
          AND a.activity_type = 'strength'
          AND e.muscle_groups IS NOT NULL
        GROUP BY mg`,
    );
  }

  async #fetchBalance(endDate: string): Promise<BalanceRow[]> {
    return this.query(
      balanceSchema,
      sql`WITH strength_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS strength_7d,
            MAX((started_at AT TIME ZONE ${this.timezone})::date)::text AS last_strength_date
          FROM fitness.activity
          WHERE user_id = ${this.userId}
            AND activity_type = 'strength'
        ),
        endurance_data AS (
          SELECT
            COUNT(*) FILTER (WHERE started_at > ${timestampWindowStart(endDate, 7)})::int AS endurance_7d,
            MAX((started_at AT TIME ZONE ${this.timezone})::date)::text AS last_endurance_date
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}
            AND ${enduranceTypeFilter("v_activity")}
            ${this.timestampAccessPredicate(sql`started_at`)}
        )
        SELECT
          s.strength_7d,
          e.endurance_7d,
          s.last_strength_date,
          e.last_endurance_date
        FROM strength_data s
        CROSS JOIN endurance_data e`,
    );
  }

  async #fetchZoneTotals(endDate: string): Promise<ZoneTotalsRow[]> {
    const zones = heartRateZoneColumns(
      sql`ds.scalar`,
      sql`up.max_hr`,
      sql`rhr.resting_hr`,
      ZONE_BOUNDARIES_HRR,
    );

    return this.query(
      zoneTotalsSchema,
      sql`SELECT
          ${zones.zone1} AS zone1,
          ${zones.zone2} AS zone2,
          ${zones.zone3} AS zone3,
          ${zones.zone4} AS zone4,
          ${zones.zone5} AS zone5
        FROM fitness.user_profile up
        JOIN fitness.v_activity a ON a.user_id = up.id
        JOIN fitness.deduped_sensor ds ON ds.activity_id = a.id AND ds.channel = 'heart_rate'
        JOIN ${restingHeartRateLateral(sql`up.id`, sql`(a.started_at AT TIME ZONE ${this.timezone})::date`)}
        WHERE up.id = ${this.userId}
          AND a.started_at > ${timestampWindowStart(endDate, 14)}
          AND ${enduranceTypeFilter("a")}
          AND up.max_hr IS NOT NULL
          AND ds.scalar IS NOT NULL
          ${this.timestampAccessPredicate(sql`a.started_at`)}`,
    );
  }

  async #fetchHiitLoad(endDate: string): Promise<HiitLoadRow[]> {
    return this.query(
      hiitLoadSchema,
      sql`WITH per_activity AS (
          SELECT
            a.id,
            (a.started_at AT TIME ZONE ${this.timezone})::date AS activity_date,
            BOOL_OR(ds.scalar >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * ${ZONE_BOUNDARIES_HRR[2]}::numeric) AS had_high_intensity
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.deduped_sensor ds ON ds.activity_id = a.id AND ds.channel = 'heart_rate'
          JOIN ${restingHeartRateLateral(sql`up.id`, sql`(a.started_at AT TIME ZONE ${this.timezone})::date`)}
          WHERE up.id = ${this.userId}
            AND a.started_at > ${timestampWindowStart(endDate, 21)}
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND ds.scalar IS NOT NULL
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          GROUP BY a.id, 2
        )
        SELECT
          SUM(
            CASE
              WHEN had_high_intensity
                AND activity_date > ${dateWindowStart(endDate, 7)}
              THEN 1
              ELSE 0
            END
          )::int AS hiit_count_7d,
          MAX(
            CASE
              WHEN had_high_intensity THEN activity_date
              ELSE NULL
            END
          )::text AS last_hiit_date
        FROM per_activity`,
    );
  }

  async #fetchTrainingDays(endDate: string): Promise<z.infer<typeof trainingDaySchema>[]> {
    return this.query(
      trainingDaySchema,
      sql`SELECT DISTINCT (started_at AT TIME ZONE ${this.timezone})::date::text AS training_date
          FROM fitness.v_activity
          WHERE user_id = ${this.userId}
            AND started_at > ${timestampWindowStart(endDate, 14)}
            ${this.timestampAccessPredicate(sql`started_at`)}
          ORDER BY training_date DESC`,
    );
  }

  /**
   * Recommendation logic moved from TrainingRouter for reuse in consolidated dashboard.
   */
  async getRecommendation(
    data: NextWorkoutData,
    endDate: string,
    weights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number },
  ): Promise<NextWorkoutRecommendation> {
    const { latestMetric } = data;

    const scores = computeComponentScores(latestMetric, data.latestSleepEfficiency);
    const readinessScore = computeReadinessScore(scores, weights, latestMetric != null);
    const readinessLevel = getReadinessLevel(readinessScore);

    const todayDate = endDate;
    const lastStrengthDaysAgo = daysAgoFromDate(data.balance.last_strength_date, todayDate);
    const lastEnduranceDaysAgo = daysAgoFromDate(data.balance.last_endurance_date, todayDate);

    const orderedFocusMuscles = computeFocusMuscles(data.muscleFreshness, todayDate);

    const { totalZoneSamples, highIntensityPct, lowIntensityPct, moderateIntensityPct } =
      computeZonePercentages(data.zoneTotals);
    const daysSinceLastHiit = daysAgoFromDate(data.hiitLoad.last_hiit_date, todayDate);

    const consecutiveTrainingDays = computeTrainingStreak(data.trainingDates);
    const strengthSessions7d = data.balance.strength_7d;
    const enduranceSessions7d = data.balance.endurance_7d;

    const rationale: string[] = [];
    if (readinessScore != null) {
      rationale.push(`Readiness score is ${readinessScore}/100 (${readinessLevel}).`);
    } else {
      rationale.push("Readiness score unavailable; using workload and recency only.");
    }
    rationale.push(
      `Last 7 days: ${strengthSessions7d} strength and ${enduranceSessions7d} cardio sessions.`,
    );

    if (consecutiveTrainingDays >= 6) {
      rationale.push(`Training streak is ${consecutiveTrainingDays} consecutive days.`);
    }
    if (data.hiitLoad.hiit_count_7d > 0) {
      rationale.push(`Hard cardio sessions in last 7 days: ${data.hiitLoad.hiit_count_7d}.`);
    }

    const limitedReadiness = readinessScore != null && readinessScore < 50; // READINESS_LIMITED_THRESHOLD
    const preferRest = shouldPreferRest(readinessLevel, consecutiveTrainingDays, data.acwr);
    const strengthUnderTarget = strengthSessions7d < 2;
    const cardioUnderTarget = enduranceSessions7d < 3;
    const strengthReady =
      orderedFocusMuscles.length > 0 || lastStrengthDaysAgo == null || lastStrengthDaysAgo >= 2;

    if (preferRest) {
      return {
        generatedAt: new Date().toISOString(),
        recommendationType: "rest",
        title: "Recovery Day",
        shortBlurb:
          "Take a lighter day: 20-40 min easy Z1 movement plus mobility. Resume harder work tomorrow if readiness rebounds.",
        readiness: { score: readinessScore, level: readinessLevel },
        rationale,
        details: [
          "Keep intensity low (easy walk, spin, or light swim).",
          "Add 10-15 minutes of mobility and soft tissue work.",
          "Prioritize sleep tonight to support adaptation.",
        ],
        strength: null,
        cardio: {
          focus: "recovery",
          durationMinutes: 30,
          targetZones: ["Z1"],
          structure: "20-40 min easy movement, conversational effort only.",
          lastEnduranceDaysAgo,
        },
      } satisfies NextWorkoutRecommendation;
    }

    if (limitedReadiness) {
      rationale.push("Readiness is below high-performance threshold; keep intensity low today.");
      return {
        generatedAt: new Date().toISOString(),
        recommendationType: "cardio",
        title: "Easy Aerobic Session",
        shortBlurb: "Keep today easy: 30-45 min in Z1-Z2 to support recovery and aerobic base.",
        readiness: { score: readinessScore, level: readinessLevel },
        rationale,
        details: [
          "Keep effort conversational and avoid hard surges.",
          "Stay in Z1-Z2 for 30-45 minutes.",
          "Treat this as recovery-supportive training, not a hard session.",
        ],
        strength: null,
        cardio: {
          focus: "z2",
          durationMinutes: 40,
          targetZones: ["Z1", "Z2"],
          structure: "30-45 min steady easy aerobic work.",
          lastEnduranceDaysAgo,
        },
      } satisfies NextWorkoutRecommendation;
    }

    const shouldDoStrength = shouldDoStrengthToday({
      strengthReady,
      strengthUnderTarget,
      cardioUnderTarget,
      lastStrengthDaysAgo,
      lastEnduranceDaysAgo,
    });

    if (shouldDoStrength) {
      const split = pickStrengthSplit(orderedFocusMuscles);
      rationale.push(
        orderedFocusMuscles.length > 0
          ? `Most recovered muscle groups: ${orderedFocusMuscles.join(", ")}.`
          : "No muscle-group freshness data; using balanced full-body guidance.",
      );

      return {
        generatedAt: new Date().toISOString(),
        recommendationType: "strength",
        title: "Strength Session",
        shortBlurb: `Prioritize ${split.toLowerCase()} today. Aim for 45-70 min with controlled effort and good technique.`,
        readiness: { score: readinessScore, level: readinessLevel },
        rationale,
        details: [
          `Warm up 8-10 min, then train ${split.toLowerCase()} exercises.`,
          "Use 3-4 working sets per exercise in the 6-12 rep range.",
          "Stop 1-3 reps before failure on most sets to manage fatigue.",
        ],
        strength: {
          focusMuscles: orderedFocusMuscles,
          split,
          targetSets: "10-16 hard sets total",
          lastStrengthDaysAgo,
        },
        cardio: null,
      } satisfies NextWorkoutRecommendation;
    }

    const cardioFocus = pickCardioFocus({
      readinessLevel,
      readinessScore,
      highIntensityPct,
      lowIntensityPct,
      moderateIntensityPct,
      totalZoneSamples,
      hiitCount7d: data.hiitLoad.hiit_count_7d,
      daysSinceLastHiit,
    });
    const cardioPrescription = cardioPlan(cardioFocus);
    rationale.push(
      totalZoneSamples > 0
        ? `Recent intensity split: ${Math.round(lowIntensityPct * 100)}% low, ${Math.round(moderateIntensityPct * 100)}% moderate, ${Math.round(highIntensityPct * 100)}% high.`
        : "No recent HR zone data; defaulting to conservative cardio guidance.",
    );
    if (data.hiitLoad.hiit_count_7d >= 3) {
      rationale.push(`HIIT cap reached (3/week), so today stays aerobic.`);
    }
    if (daysSinceLastHiit != null && daysSinceLastHiit < 2) {
      rationale.push("Less than 48 hours since the last hard cardio session.");
    }

    return {
      generatedAt: new Date().toISOString(),
      recommendationType: "cardio",
      title: cardioPrescription.title,
      shortBlurb: cardioPrescription.shortBlurb,
      readiness: { score: readinessScore, level: readinessLevel },
      rationale,
      details: cardioPrescription.details,
      strength: null,
      cardio: {
        focus: cardioFocus,
        durationMinutes: cardioPrescription.durationMinutes,
        targetZones: cardioPrescription.targetZones,
        structure: cardioPrescription.structure,
        lastEnduranceDaysAgo,
      },
    } satisfies NextWorkoutRecommendation;
  }
}

// ---------------------------------------------------------------------------
// Pure logic and types moved from TrainingRouter
// ---------------------------------------------------------------------------

export type RecommendationType = "rest" | "strength" | "cardio";
export type ReadinessLevel = "low" | "moderate" | "high" | "unknown";
export type CardioFocus = "recovery" | "z2" | "intervals" | "hiit";

export interface NextWorkoutRecommendation {
  generatedAt: string;
  recommendationType: RecommendationType;
  title: string;
  shortBlurb: string;
  readiness: {
    score: number | null;
    level: ReadinessLevel;
  };
  rationale: string[];
  details: string[];
  strength: {
    focusMuscles: string[];
    split: string;
    targetSets: string;
    lastStrengthDaysAgo: number | null;
  } | null;
  cardio: {
    focus: CardioFocus;
    durationMinutes: number;
    targetZones: string[];
    structure: string;
    lastEnduranceDaysAgo: number | null;
  } | null;
}

export function computeZonePercentages(zoneTotals: {
  zone1: number;
  zone2: number;
  zone3: number;
  zone4: number;
  zone5: number;
}): {
  totalZoneSamples: number;
  highIntensityPct: number;
  lowIntensityPct: number;
  moderateIntensityPct: number;
} {
  const totalZoneSamples =
    zoneTotals.zone1 + zoneTotals.zone2 + zoneTotals.zone3 + zoneTotals.zone4 + zoneTotals.zone5;
  const highIntensitySamples = zoneTotals.zone4 + zoneTotals.zone5;
  const moderateSamples = zoneTotals.zone3;
  const lowSamples = zoneTotals.zone1 + zoneTotals.zone2;
  const highIntensityPct = totalZoneSamples > 0 ? highIntensitySamples / totalZoneSamples : 0;
  const lowIntensityPct = totalZoneSamples > 0 ? lowSamples / totalZoneSamples : 0;
  const moderateIntensityPct = totalZoneSamples > 0 ? moderateSamples / totalZoneSamples : 0;
  return { totalZoneSamples, highIntensityPct, lowIntensityPct, moderateIntensityPct };
}

import { zScoreToRecoveryScore } from "@dofek/scoring/scoring";

export function computeComponentScores(
  latestMetric: ReadinessMetricRow | null,
  latestSleepEfficiency: number | null,
): {
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  respiratoryRateScore: number;
} {
  let hrvScore = 62;
  if (
    latestMetric?.hrv != null &&
    latestMetric.hrv_mean_30d != null &&
    latestMetric.hrv_sd_30d != null &&
    latestMetric.hrv_sd_30d > 0
  ) {
    const hrvZ = (latestMetric.hrv - latestMetric.hrv_mean_30d) / latestMetric.hrv_sd_30d;
    hrvScore = zScoreToRecoveryScore(hrvZ);
  }

  let restingHrScore = 62;
  if (
    latestMetric?.resting_hr != null &&
    latestMetric.rhr_mean_30d != null &&
    latestMetric.rhr_sd_30d != null &&
    latestMetric.rhr_sd_30d > 0
  ) {
    const rhrZ = (latestMetric.resting_hr - latestMetric.rhr_mean_30d) / latestMetric.rhr_sd_30d;
    restingHrScore = zScoreToRecoveryScore(-rhrZ);
  }

  const sleepScore =
    latestSleepEfficiency != null
      ? Math.max(0, Math.min(100, Math.round(latestSleepEfficiency)))
      : 62;

  let respiratoryRateScore = 62;
  if (
    latestMetric?.respiratory_rate != null &&
    latestMetric.rr_mean_30d != null &&
    latestMetric.rr_sd_30d != null &&
    latestMetric.rr_sd_30d > 0
  ) {
    const rrZ = (latestMetric.respiratory_rate - latestMetric.rr_mean_30d) / latestMetric.rr_sd_30d;
    respiratoryRateScore = zScoreToRecoveryScore(-rrZ);
  }

  return { hrvScore, restingHrScore, sleepScore, respiratoryRateScore };
}

export function computeReadinessScore(
  scores: {
    hrvScore: number;
    restingHrScore: number;
    sleepScore: number;
    respiratoryRateScore: number;
  },
  weights: { hrv: number; restingHr: number; sleep: number; respiratoryRate: number },
  hasMetric: boolean,
): number | null {
  if (!hasMetric) return null;
  const raw =
    scores.hrvScore * weights.hrv +
    scores.restingHrScore * weights.restingHr +
    scores.sleepScore * weights.sleep +
    scores.respiratoryRateScore * weights.respiratoryRate;
  return Math.round(raw);
}

export function shouldPreferRest(
  readinessLevel: ReadinessLevel,
  consecutiveTrainingDays: number,
  acwr: number | null,
): boolean {
  return readinessLevel === "low" || consecutiveTrainingDays >= 6 || (acwr != null && acwr > 1.5);
}

export function shouldDoStrengthToday(input: {
  strengthReady: boolean;
  strengthUnderTarget: boolean;
  cardioUnderTarget: boolean;
  lastStrengthDaysAgo: number | null;
  lastEnduranceDaysAgo: number | null;
}): boolean {
  return (
    input.strengthReady &&
    (input.strengthUnderTarget ||
      (!input.cardioUnderTarget &&
        (input.lastStrengthDaysAgo ?? 99) >= (input.lastEnduranceDaysAgo ?? 99)))
  );
}

export function computeFocusMuscles(
  muscleFreshness: MuscleFreshnessRow[],
  todayDate: string,
): string[] {
  const freshMuscles = muscleFreshness
    .map((row) => ({
      name: normalizeMuscleName(row.muscle_group),
      daysAgo: daysAgoFromDate(row.last_trained_date, todayDate),
    }))
    .filter((row): row is { name: string; daysAgo: number } => row.daysAgo != null)
    .sort((a, b) => b.daysAgo - a.daysAgo);
  const focusMuscles = [...new Set(freshMuscles.filter((m) => m.daysAgo >= 2).map((m) => m.name))];
  return (
    focusMuscles.length > 0 ? focusMuscles : [...new Set(freshMuscles.map((m) => m.name))]
  ).slice(0, 3);
}

export function getReadinessLevel(score: number | null): ReadinessLevel {
  if (score == null) return "unknown";
  if (score < 33) return "low";
  if (score < 65) return "moderate";
  return "high";
}

export function daysAgoFromDate(date: string | null, todayDate: string): number | null {
  if (!date) return null;
  const lhs = Date.parse(`${todayDate}T00:00:00Z`);
  const rhs = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(lhs) || Number.isNaN(rhs)) return null;
  return Math.max(0, Math.floor((lhs - rhs) / 86_400_000));
}

export function normalizeMuscleName(name: string): string {
  const cleaned = name.replace(/_/g, " ").trim().toLowerCase();
  const aliases: Record<string, string> = {
    delts: "shoulders",
    lats: "back",
    "upper back": "back",
    "lower back": "core",
    abdominals: "core",
    abs: "core",
    obliques: "core",
    quads: "quadriceps",
  };
  return aliases[cleaned] ?? cleaned;
}

export function pickStrengthSplit(focusMuscles: string[]): string {
  if (focusMuscles.length === 0) return "Full-body strength";

  const lower = new Set(["legs", "quadriceps", "hamstrings", "glutes", "calves"]);
  const push = new Set(["chest", "shoulders", "triceps"]);
  const pull = new Set(["back", "biceps", "traps"]);
  const core = new Set(["core"]);

  let lowerCount = 0;
  let pushCount = 0;
  let pullCount = 0;
  let coreCount = 0;

  for (const muscle of focusMuscles) {
    if (lower.has(muscle)) lowerCount++;
    if (push.has(muscle)) pushCount++;
    if (pull.has(muscle)) pullCount++;
    if (core.has(muscle)) coreCount++;
  }

  if (lowerCount >= 2) return "Lower-body strength";
  if (pushCount > 0 && pullCount > 0) return "Upper-body push/pull";
  if (pushCount > pullCount) return "Upper-body push";
  if (pullCount > pushCount) return "Upper-body pull";
  if (coreCount > 0) return "Core + accessories";
  return "Full-body strength";
}

export function computeTrainingStreak(trainingDates: string[]): number {
  if (trainingDates.length === 0) return 0;
  const normalized = trainingDates
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((d) => !Number.isNaN(d))
    .sort((a, b) => b - a);
  if (normalized.length === 0) return 0;

  let streak = 1;
  for (let i = 1; i < normalized.length; i++) {
    const current = normalized[i];
    const prev = normalized[i - 1];
    if (current == null || prev == null) continue;
    const deltaDays = Math.round((prev - current) / 86_400_000);
    if (deltaDays === 1) {
      streak++;
      continue;
    }
    if (deltaDays > 1) break;
  }
  return streak;
}

export function pickCardioFocus(input: {
  readinessLevel: ReadinessLevel;
  readinessScore: number | null;
  highIntensityPct: number;
  lowIntensityPct: number;
  moderateIntensityPct: number;
  totalZoneSamples: number;
  hiitCount7d: number;
  daysSinceLastHiit: number | null;
}): CardioFocus {
  if (input.readinessLevel === "low") return "recovery";
  if (input.readinessLevel === "moderate" || (input.readinessScore ?? 0) < 65) return "z2";
  if (input.totalZoneSamples === 0) return "z2";

  if (input.hiitCount7d >= 3) return "z2";
  if (input.daysSinceLastHiit != null && input.daysSinceLastHiit < 2) return "z2";

  if (input.highIntensityPct < 0.08 && input.lowIntensityPct > 0.75) return "hiit";
  if (input.highIntensityPct < 0.2 && input.lowIntensityPct > 0.6) return "intervals";
  return "z2";
}

export function cardioPlan(focus: CardioFocus): {
  title: string;
  shortBlurb: string;
  durationMinutes: number;
  targetZones: string[];
  structure: string;
  details: string[];
} {
  if (focus === "hiit") {
    return {
      title: "Cardio HIIT Session",
      shortBlurb: "Do a short HIIT session today: 8 x 30s hard (Z5) with 90s easy recovery.",
      durationMinutes: 35,
      targetZones: ["Z1", "Z5"],
      structure: "10 min warm-up, 8 x 30s Z5 / 90s easy, 8-10 min cool-down.",
      details: [
        "Warm up progressively for 10 minutes before your first rep.",
        "Hit Z5 on each 30-second effort; keep recoveries very easy.",
        "Stop the session early if power/pace drops sharply.",
      ],
    };
  }

  if (focus === "intervals") {
    return {
      title: "Cardio Intervals Session",
      shortBlurb: "Do threshold-style intervals: 4 x 4 min around Z4 with easy recoveries.",
      durationMinutes: 50,
      targetZones: ["Z2", "Z4"],
      structure: "15 min warm-up, 4 x 4 min Z4 with 3 min easy between reps, 10 min cool-down.",
      details: [
        "Keep each work rep controlled and repeatable, not all-out.",
        "Spin/jog easily between reps to keep quality high.",
        "If your readiness drops mid-session, reduce to 3 reps.",
      ],
    };
  }

  if (focus === "recovery") {
    return {
      title: "Easy Recovery Cardio",
      shortBlurb:
        "Keep cardio very easy today: Z1-only movement to promote circulation and recovery.",
      durationMinutes: 30,
      targetZones: ["Z1"],
      structure: "20-40 min easy walk, spin, or swim in Z1.",
      details: [
        "Keep breathing relaxed and conversational throughout.",
        "Add 5-10 minutes of mobility after the session.",
        "This should leave you feeling better than when you started.",
      ],
    };
  }

  return {
    title: "Aerobic Base Cardio",
    shortBlurb:
      "Do steady Z2 cardio for 45-60 min to build aerobic fitness without excess fatigue.",
    durationMinutes: 50,
    targetZones: ["Z2"],
    structure: "Continuous Z2 effort for 45-60 min at a conversational pace.",
    details: [
      "Keep effort steady and controlled in the aerobic zone.",
      "Fuel and hydrate as needed if you go beyond 60 minutes.",
      "Finish with a short cooldown and light mobility.",
    ],
  };
}
