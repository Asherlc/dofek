import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const weeklyVolumeRowSchema = z.object({
  week: dateStringSchema,
  activity_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

type RecommendationType = "rest" | "strength" | "cardio";
type ReadinessLevel = "low" | "moderate" | "high" | "unknown";
type CardioFocus = "recovery" | "z2" | "intervals" | "hiit";

const READINESS_REST_THRESHOLD = 33;
const READINESS_LIMITED_THRESHOLD = 50;
const READINESS_HIGH_THRESHOLD = 65;
const MAX_HIIT_PER_WEEK = 3;
const HIIT_SPACING_DAYS = 2;
const HIGH_INTENSITY_RATIO_TARGET = 0.2;
const ACWR_HIGH_RISK_THRESHOLD = 1.5;

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

export const trainingRouter = router({
  /**
   * Weekly training volume grouped by activity type.
   * Returns hours and count per activity type per ISO week.
   */
  weeklyVolume: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        weeklyVolumeRowSchema,
        sql`SELECT
              date_trunc('week', started_at)::date AS week,
              activity_type,
              COUNT(*)::int AS count,
              ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600)::numeric, 2) AS hours
            FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ended_at IS NOT NULL
            GROUP BY date_trunc('week', started_at), activity_type
            ORDER BY week`,
      );
    }),

  /**
   * HR zone distribution per week.
   * Computes 5-zone Karvonen model at query time from metric_stream.
   * Zones use % of Heart Rate Reserve: Z1 <60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 >=90%.
   */
  hrZones: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const hrZonesRowSchema = z.object({
        max_hr: z.coerce.number().nullable(),
        week: z.string(),
        zone1: z.coerce.number(),
        zone2: z.coerce.number(),
        zone3: z.coerce.number(),
        zone4: z.coerce.number(),
        zone5: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        hrZonesRowSchema,
        sql`SELECT
              up.max_hr,
              date_trunc('week', a.started_at)::date AS week,
              COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6)::int AS zone1,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7)::int AS zone2,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8)::int AS zone3,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
                                AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone4,
              COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone5
            FROM fitness.user_profile up
            JOIN fitness.v_activity a ON a.user_id = up.id
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            JOIN LATERAL (
              SELECT dm.resting_hr
              FROM fitness.v_daily_metrics dm
              WHERE dm.user_id = up.id
                AND dm.date <= a.started_at::date
                AND dm.resting_hr IS NOT NULL
              ORDER BY dm.date DESC
              LIMIT 1
            ) rhr ON true
            WHERE up.id = ${ctx.userId}
              AND a.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ms.recorded_at > NOW() - (${input.days} + 1)::int * INTERVAL '1 day'
              AND ${enduranceTypeFilter("a")}
              AND up.max_hr IS NOT NULL
              AND ms.heart_rate IS NOT NULL
            GROUP BY up.max_hr, date_trunc('week', a.started_at)
            ORDER BY week`,
      );
      const rawMaxHr = rows[0]?.max_hr;
      const maxHr = typeof rawMaxHr === "number" ? rawMaxHr : null;
      if (!maxHr) return { maxHr: null, weeks: [] };
      return { maxHr, weeks: rows };
    }),

  /**
   * Per-activity summary with HR and power stats.
   * Reads from pre-computed activity_summary rollup view.
   */
  activityStats: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const activityStatsRowSchema = z.object({
        id: z.string(),
        activity_type: z.string(),
        name: z.string().nullable(),
        started_at: z.string(),
        ended_at: z.string().nullable(),
        avg_hr: z.coerce.number().nullable(),
        max_hr: z.coerce.number().nullable(),
        avg_power: z.coerce.number().nullable(),
        max_power: z.coerce.number().nullable(),
        avg_cadence: z.coerce.number().nullable(),
        hr_samples: z.coerce.number().nullable(),
        power_samples: z.coerce.number().nullable(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        activityStatsRowSchema,
        sql`SELECT
              asum.activity_id AS id,
              asum.activity_type,
              asum.name,
              asum.started_at,
              asum.ended_at,
              ROUND(asum.avg_hr::numeric, 1) AS avg_hr,
              asum.max_hr,
              ROUND(asum.avg_power::numeric, 1) AS avg_power,
              asum.max_power,
              ROUND(asum.avg_cadence::numeric, 1) AS avg_cadence,
              asum.hr_sample_count AS hr_samples,
              asum.power_sample_count AS power_samples
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY asum.started_at DESC`,
      );
      return rows;
    }),

  /**
   * Suggests the next workout type based on readiness, weekly balance, and freshness.
   * Returns both a short dashboard blurb and more prescriptive detail for a modal.
   */
  nextWorkout: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
    const weights = getEffectiveParams(storedParams).readinessWeights;

    const readinessMetricSchema = z.object({
      date: dateStringSchema,
      hrv: z.coerce.number().nullable(),
      resting_hr: z.coerce.number().nullable(),
      hrv_mean_60d: z.coerce.number().nullable(),
      hrv_sd_60d: z.coerce.number().nullable(),
      rhr_mean_60d: z.coerce.number().nullable(),
      rhr_sd_60d: z.coerce.number().nullable(),
    });
    const latestMetrics = await executeWithSchema(
      ctx.db,
      readinessMetricSchema,
      sql`WITH latest AS (
            SELECT
              date,
              hrv,
              resting_hr
            FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId}
            ORDER BY date DESC
            LIMIT 1
          )
          SELECT
            latest.date::text AS date,
            latest.hrv,
            latest.resting_hr,
            baseline.hrv_mean_60d,
            baseline.hrv_sd_60d,
            baseline.rhr_mean_60d,
            baseline.rhr_sd_60d
          FROM latest
          CROSS JOIN LATERAL (
            SELECT
              AVG(dm.hrv) AS hrv_mean_60d,
              STDDEV_POP(dm.hrv) AS hrv_sd_60d,
              AVG(dm.resting_hr) AS rhr_mean_60d,
              STDDEV_POP(dm.resting_hr) AS rhr_sd_60d
            FROM fitness.v_daily_metrics dm
            WHERE dm.user_id = ${ctx.userId}
              AND dm.date BETWEEN latest.date - 59 AND latest.date
          ) baseline`,
    );
    const latestMetric = latestMetrics[0];

    const sleepRowSchema = z.object({
      efficiency_pct: z.coerce.number().nullable(),
    });
    const sleepRows = await executeWithSchema(
      ctx.db,
      sleepRowSchema,
      sql`SELECT efficiency_pct
          FROM fitness.v_sleep
          WHERE user_id = ${ctx.userId}
            AND is_nap = false
          ORDER BY COALESCE(ended_at, started_at + interval '8 hours') DESC
          LIMIT 1`,
    );
    const latestSleepEfficiency = sleepRows[0]?.efficiency_pct ?? null;

    const acwrRowSchema = z.object({
      acwr: z.coerce.number().nullable(),
    });
    const acwrRows = await executeWithSchema(
      ctx.db,
      acwrRowSchema,
      sql`WITH date_series AS (
            SELECT generate_series(
              CURRENT_DATE - 28,
              CURRENT_DATE,
              '1 day'::interval
            )::date AS date
          ),
          per_activity AS (
            SELECT
              asum.started_at::date AS date,
              EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at)) / 60.0
                * asum.avg_hr
                / NULLIF(asum.max_hr, 0) AS load
            FROM fitness.activity_summary asum
            WHERE asum.user_id = ${ctx.userId}
              AND asum.started_at::date >= CURRENT_DATE - 28
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
              AVG(daily_load) OVER (ORDER BY date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW) AS chronic_load_avg
            FROM daily
          )
          SELECT
            CASE
              WHEN chronic_load_avg > 0
              THEN acute_load / (chronic_load_avg * 7)
              ELSE NULL
            END AS acwr
          FROM with_windows
          ORDER BY date DESC
          LIMIT 1`,
    );
    const acwr = acwrRows[0]?.acwr ?? null;

    const muscleFreshnessSchema = z.object({
      muscle_group: z.string(),
      last_trained_date: dateStringSchema,
    });
    const muscleFreshnessRows = await executeWithSchema(
      ctx.db,
      muscleFreshnessSchema,
      sql`SELECT
            e.muscle_group,
            MAX(sw.started_at)::date::text AS last_trained_date
          FROM fitness.strength_set ss
          JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
          JOIN fitness.exercise e ON e.id = ss.exercise_id
          WHERE sw.user_id = ${ctx.userId}
            AND e.muscle_group IS NOT NULL
          GROUP BY e.muscle_group`,
    );

    const balanceSchema = z.object({
      strength_7d: z.coerce.number(),
      endurance_7d: z.coerce.number(),
      last_strength_date: dateStringSchema.nullable(),
      last_endurance_date: dateStringSchema.nullable(),
    });
    const balanceRows = await executeWithSchema(
      ctx.db,
      balanceSchema,
      sql`WITH strength_data AS (
            SELECT
              COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days')::int AS strength_7d,
              MAX(started_at)::date::text AS last_strength_date
            FROM fitness.strength_workout
            WHERE user_id = ${ctx.userId}
          ),
          endurance_data AS (
            SELECT
              COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days')::int AS endurance_7d,
              MAX(started_at)::date::text AS last_endurance_date
            FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND ${enduranceTypeFilter("v_activity")}
          )
          SELECT
            s.strength_7d,
            e.endurance_7d,
            s.last_strength_date,
            e.last_endurance_date
          FROM strength_data s
          CROSS JOIN endurance_data e`,
    );
    const balance = balanceRows[0] ?? {
      strength_7d: 0,
      endurance_7d: 0,
      last_strength_date: null,
      last_endurance_date: null,
    };

    const zoneTotalsSchema = z.object({
      zone1: z.coerce.number(),
      zone2: z.coerce.number(),
      zone3: z.coerce.number(),
      zone4: z.coerce.number(),
      zone5: z.coerce.number(),
    });
    const zoneTotalsRows = await executeWithSchema(
      ctx.db,
      zoneTotalsSchema,
      sql`SELECT
            COUNT(*) FILTER (WHERE ms.heart_rate < rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6)::int AS zone1,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.6
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7)::int AS zone2,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.7
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8)::int AS zone3,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8
                              AND ms.heart_rate <  rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone4,
            COUNT(*) FILTER (WHERE ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.9)::int AS zone5
          FROM fitness.user_profile up
          JOIN fitness.v_activity a ON a.user_id = up.id
          JOIN fitness.metric_stream ms ON ms.activity_id = a.id
          JOIN LATERAL (
            SELECT dm.resting_hr
            FROM fitness.v_daily_metrics dm
            WHERE dm.user_id = up.id
              AND dm.date <= a.started_at::date
              AND dm.resting_hr IS NOT NULL
            ORDER BY dm.date DESC
            LIMIT 1
          ) rhr ON true
          WHERE up.id = ${ctx.userId}
            AND a.started_at > NOW() - INTERVAL '14 days'
            AND ms.recorded_at > NOW() - INTERVAL '15 days'
            AND ${enduranceTypeFilter("a")}
            AND up.max_hr IS NOT NULL
            AND ms.heart_rate IS NOT NULL`,
    );
    const zoneTotals = zoneTotalsRows[0] ?? { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };

    const hiitLoadSchema = z.object({
      hiit_count_7d: z.coerce.number(),
      last_hiit_date: dateStringSchema.nullable(),
    });
    const hiitLoadRows = await executeWithSchema(
      ctx.db,
      hiitLoadSchema,
      sql`WITH per_activity AS (
            SELECT
              a.id,
              a.started_at::date AS activity_date,
              BOOL_OR(ms.heart_rate >= rhr.resting_hr + (up.max_hr - rhr.resting_hr) * 0.8) AS had_high_intensity
            FROM fitness.user_profile up
            JOIN fitness.v_activity a ON a.user_id = up.id
            JOIN fitness.metric_stream ms ON ms.activity_id = a.id
            JOIN LATERAL (
              SELECT dm.resting_hr
              FROM fitness.v_daily_metrics dm
              WHERE dm.user_id = up.id
                AND dm.date <= a.started_at::date
                AND dm.resting_hr IS NOT NULL
              ORDER BY dm.date DESC
              LIMIT 1
            ) rhr ON true
            WHERE up.id = ${ctx.userId}
              AND a.started_at > NOW() - INTERVAL '21 days'
              AND ${enduranceTypeFilter("a")}
              AND up.max_hr IS NOT NULL
              AND ms.heart_rate IS NOT NULL
            GROUP BY a.id, a.started_at::date
          )
          SELECT
            SUM(
              CASE
                WHEN had_high_intensity
                  AND activity_date > CURRENT_DATE - 7
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
    const hiitLoad = hiitLoadRows[0] ?? { hiit_count_7d: 0, last_hiit_date: null };

    const trainingDaySchema = z.object({
      training_date: dateStringSchema,
    });
    const trainingDays = await executeWithSchema(
      ctx.db,
      trainingDaySchema,
      sql`WITH combined AS (
            SELECT DISTINCT started_at::date AS training_date
            FROM fitness.v_activity
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - INTERVAL '14 days'
            UNION
            SELECT DISTINCT started_at::date AS training_date
            FROM fitness.strength_workout
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - INTERVAL '14 days'
          )
          SELECT training_date::text
          FROM combined
          ORDER BY training_date DESC`,
    );

    let hrvScore = 50;
    if (
      latestMetric?.hrv != null &&
      latestMetric.hrv_mean_60d != null &&
      latestMetric.hrv_sd_60d != null &&
      latestMetric.hrv_sd_60d > 0
    ) {
      const hrvZ = (latestMetric.hrv - latestMetric.hrv_mean_60d) / latestMetric.hrv_sd_60d;
      hrvScore = zScoreToScore(hrvZ);
    }

    let restingHrScore = 50;
    if (
      latestMetric?.resting_hr != null &&
      latestMetric.rhr_mean_60d != null &&
      latestMetric.rhr_sd_60d != null &&
      latestMetric.rhr_sd_60d > 0
    ) {
      const rhrZ = (latestMetric.resting_hr - latestMetric.rhr_mean_60d) / latestMetric.rhr_sd_60d;
      restingHrScore = zScoreToScore(-rhrZ);
    }

    const sleepScore =
      latestSleepEfficiency != null ? clamp(Math.round(latestSleepEfficiency), 0, 100) : 50;
    const loadBalanceScore = acwrToScore(acwr);
    const readinessScoreRaw = latestMetric
      ? hrvScore * weights.hrv +
        restingHrScore * weights.restingHr +
        sleepScore * weights.sleep +
        loadBalanceScore * weights.loadBalance
      : null;
    const readinessScore = readinessScoreRaw != null ? Math.round(readinessScoreRaw) : null;
    const readinessLevel = getReadinessLevel(readinessScore);

    const todayDate = new Date().toISOString().slice(0, 10);
    const lastStrengthDaysAgo = daysAgoFromDate(balance.last_strength_date, todayDate);
    const lastEnduranceDaysAgo = daysAgoFromDate(balance.last_endurance_date, todayDate);

    const freshMuscles = muscleFreshnessRows
      .map((row) => ({
        name: normalizeMuscleName(row.muscle_group),
        daysAgo: daysAgoFromDate(row.last_trained_date, todayDate),
      }))
      .filter((row): row is { name: string; daysAgo: number } => row.daysAgo != null)
      .sort((a, b) => b.daysAgo - a.daysAgo);
    const focusMuscles = uniqueStrings(
      freshMuscles.filter((m) => m.daysAgo >= 2).map((m) => m.name),
    );
    const orderedFocusMuscles = (
      focusMuscles.length > 0 ? focusMuscles : uniqueStrings(freshMuscles.map((m) => m.name))
    ).slice(0, 3);

    const totalZoneSamples =
      zoneTotals.zone1 + zoneTotals.zone2 + zoneTotals.zone3 + zoneTotals.zone4 + zoneTotals.zone5;
    const highIntensitySamples = zoneTotals.zone4 + zoneTotals.zone5;
    const moderateSamples = zoneTotals.zone3;
    const lowSamples = zoneTotals.zone1 + zoneTotals.zone2;
    const highIntensityPct = totalZoneSamples > 0 ? highIntensitySamples / totalZoneSamples : 0;
    const lowIntensityPct = totalZoneSamples > 0 ? lowSamples / totalZoneSamples : 0;
    const moderateIntensityPct = totalZoneSamples > 0 ? moderateSamples / totalZoneSamples : 0;
    const daysSinceLastHiit = daysAgoFromDate(hiitLoad.last_hiit_date, todayDate);

    const consecutiveTrainingDays = computeTrainingStreak(trainingDays.map((d) => d.training_date));
    const strengthSessions7d = balance.strength_7d;
    const enduranceSessions7d = balance.endurance_7d;

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
    if (hiitLoad.hiit_count_7d > 0) {
      rationale.push(`Hard cardio sessions in last 7 days: ${hiitLoad.hiit_count_7d}.`);
    }

    const acwrHighRisk = acwr != null && acwr > ACWR_HIGH_RISK_THRESHOLD;
    const limitedReadiness = readinessScore != null && readinessScore < READINESS_LIMITED_THRESHOLD;
    const preferRest = readinessLevel === "low" || consecutiveTrainingDays >= 6 || acwrHighRisk;
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

    const shouldDoStrength =
      strengthReady &&
      (strengthUnderTarget ||
        (!cardioUnderTarget && (lastStrengthDaysAgo ?? 99) >= (lastEnduranceDaysAgo ?? 99)));

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
      hiitCount7d: hiitLoad.hiit_count_7d,
      daysSinceLastHiit,
    });
    const cardioPrescription = cardioPlan(cardioFocus);
    rationale.push(
      totalZoneSamples > 0
        ? `Recent intensity split: ${Math.round(lowIntensityPct * 100)}% low, ${Math.round(moderateIntensityPct * 100)}% moderate, ${Math.round(highIntensityPct * 100)}% high.`
        : "No recent HR zone data; defaulting to conservative cardio guidance.",
    );
    if (hiitLoad.hiit_count_7d >= MAX_HIIT_PER_WEEK) {
      rationale.push(`HIIT cap reached (${MAX_HIIT_PER_WEEK}/week), so today stays aerobic.`);
    }
    if (daysSinceLastHiit != null && daysSinceLastHiit < HIIT_SPACING_DAYS) {
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
  }),
});

// Exported for unit testing — these are pure helpers with no side effects.
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function zScoreToScore(zScore: number): number {
  return clamp(Math.round((50 + zScore * 15) * 10) / 10, 0, 100);
}

export function acwrToScore(acwr: number | null): number {
  if (acwr == null) return 50;
  const deviation = Math.abs(acwr - 1);
  return clamp(Math.round((1 - deviation) * 100), 0, 100);
}

export function getReadinessLevel(score: number | null): ReadinessLevel {
  if (score == null) return "unknown";
  if (score < READINESS_REST_THRESHOLD) return "low";
  if (score < READINESS_HIGH_THRESHOLD) return "moderate";
  return "high";
}

export function daysAgoFromDate(date: string | null, todayDate: string): number | null {
  if (!date) return null;
  const lhs = Date.parse(`${todayDate}T00:00:00Z`);
  const rhs = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(lhs) || Number.isNaN(rhs)) return null;
  return Math.max(0, Math.floor((lhs - rhs) / 86_400_000));
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
  if (input.readinessLevel === "moderate" || (input.readinessScore ?? 0) < READINESS_HIGH_THRESHOLD)
    return "z2";
  if (input.totalZoneSamples === 0) return "z2";

  if (input.hiitCount7d >= MAX_HIIT_PER_WEEK) return "z2";
  if (input.daysSinceLastHiit != null && input.daysSinceLastHiit < HIIT_SPACING_DAYS) return "z2";

  if (input.highIntensityPct < 0.08 && input.lowIntensityPct > 0.75) return "hiit";
  if (input.highIntensityPct < HIGH_INTENSITY_RATIO_TARGET && input.lowIntensityPct > 0.6)
    return "intervals";
  if (input.highIntensityPct > 0.25 || input.moderateIntensityPct > 0.3) return "z2";
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
