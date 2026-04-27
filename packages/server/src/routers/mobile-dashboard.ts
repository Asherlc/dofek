import { StrainScore } from "@dofek/scoring/scoring";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowStart, endDateSchema, timestampWindowStart } from "../lib/date-window.ts";
import { sleepNightDate } from "../lib/sql-fragments.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import {
  type AnomalyCheckResult,
  AnomalyDetectionRepository,
} from "../repositories/anomaly-detection-repository.ts";
import {
  computeComponentScores,
  computeReadinessScore,
  type NextWorkoutRecommendation,
  TrainingRepository,
} from "../repositories/training-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";
import type { SleepNeedResult, SleepNight } from "./sleep-need.ts";

/** Simple date comparison for server-side logic (where @dofek/format is not available). */
export function isRecent(dateStr: string, anchorDateStr: string): boolean {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const anchor = new Date(`${anchorDateStr}T12:00:00Z`);
  const diffDays = Math.round((anchor.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= 1;
}

export interface MobileDashboardResult {
  readiness: {
    score: number;
    date: string;
    components: {
      hrvScore: number;
      restingHrScore: number;
      sleepScore: number;
      respiratoryRateScore: number;
    };
    weights: {
      hrv: number;
      restingHr: number;
      sleep: number;
      respiratoryRate: number;
    };
  } | null;
  sleep: {
    lastNight: {
      date: string;
      durationMinutes: number;
      deepPct: number;
      remPct: number;
      lightPct: number;
      awakePct: number;
    } | null;
    sleepDebt: number;
  } | null;
  strain: {
    dailyStrain: number;
    acuteLoad: number;
    chronicLoad: number;
    workloadRatio: number | null;
    date: string | null;
  };
  nextWorkout: NextWorkoutRecommendation | null;
  sleepNeed: SleepNeedResult | null;
  anomalies: AnomalyCheckResult | null;
  latestDate: string | null;
}

export const mobileDashboardRouter = router({
  dashboard: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<MobileDashboardResult> => {
      const { endDate } = input;
      const tz = ctx.timezone;

      // 1. Fetch Readiness, Strain, and Trends in a consolidated query
      const readinessSchema = z.object({
        date: dateStringSchema,
        hrv: z.coerce.number().nullable(),
        resting_hr: z.coerce.number().nullable(),
        respiratory_rate: z.coerce.number().nullable(),
        efficiency_pct: z.coerce.number().nullable(),
        hrv_mean_30d: z.coerce.number().nullable(),
        hrv_sd_30d: z.coerce.number().nullable(),
        rhr_mean_30d: z.coerce.number().nullable(),
        rhr_sd_30d: z.coerce.number().nullable(),
        rr_mean_30d: z.coerce.number().nullable(),
        rr_sd_30d: z.coerce.number().nullable(),
        daily_load: z.coerce.number(),
      });

      const metricsRows = await executeWithSchema(
        ctx.db,
        readinessSchema,
        sql`
          WITH metrics_with_baselines AS (
            SELECT
              date,
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
            WHERE user_id = ${ctx.userId}
              AND date > ${endDate}::date - 60
              AND date <= ${endDate}
          ),
          daily_loads AS (
            SELECT
              (ended_at AT TIME ZONE ${tz})::date AS date,
              COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0 * avg_hr / NULLIF(max_hr, 0), 0)
                AS daily_load
            FROM fitness.activity_summary
            WHERE user_id = ${ctx.userId}
              AND ended_at IS NOT NULL
              AND avg_hr IS NOT NULL
              AND (ended_at AT TIME ZONE ${tz})::date > ${endDate}::date - 60
              AND (ended_at AT TIME ZONE ${tz})::date <= ${endDate}
            GROUP BY date
          ),
          sleep_eff AS (
            SELECT DISTINCT ON (local_date)
              local_date::text AS date,
              efficiency_pct
            FROM (
              SELECT (COALESCE(ended_at, started_at + interval '8 hours') AT TIME ZONE ${tz})::date AS local_date,
                     efficiency_pct,
                     duration_minutes
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > ${endDate}::date - 60
            ) sleep_sub
            ORDER BY local_date, duration_minutes DESC NULLS LAST
          )
          SELECT
            m.date::text,
            m.hrv, m.resting_hr, m.respiratory_rate, s.efficiency_pct,
            m.hrv_mean_30d, m.hrv_sd_30d, m.rhr_mean_30d, m.rhr_sd_30d, m.rr_mean_30d, m.rr_sd_30d,
            COALESCE(dl.daily_load, 0) AS daily_load
          FROM metrics_with_baselines m
          LEFT JOIN sleep_eff s ON s.date = m.date::text
          LEFT JOIN daily_loads dl ON dl.date = m.date
          ORDER BY m.date DESC
        `,
      );

      const latestMetric = metricsRows[0];
      let readinessResult: MobileDashboardResult["readiness"] = null;

      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const weights = getEffectiveParams(storedParams).readinessWeights;

      if (latestMetric && isRecent(latestMetric.date, endDate)) {
        const scores = computeComponentScores(
          {
            date: latestMetric.date,
            hrv: latestMetric.hrv,
            resting_hr: latestMetric.resting_hr,
            respiratory_rate: latestMetric.respiratory_rate,
            hrv_mean_30d: latestMetric.hrv_mean_30d,
            hrv_sd_30d: latestMetric.hrv_sd_30d,
            rhr_mean_30d: latestMetric.rhr_mean_30d,
            rhr_sd_30d: latestMetric.rhr_sd_30d,
            rr_mean_30d: latestMetric.rr_mean_30d,
            rr_sd_30d: latestMetric.rr_sd_30d,
          },
          latestMetric.efficiency_pct,
        );
        const score = computeReadinessScore(scores, weights, true);

        if (score != null) {
          readinessResult = {
            score,
            date: latestMetric.date,
            components: scores,
            weights,
          };
        }
      }

      // 2. Sleep Analytics (Last Night)
      const sleepRows = await executeWithSchema(
        ctx.db,
        z.object({
          date: dateStringSchema,
          duration_minutes: z.coerce.number(),
          deep_pct: z.coerce.number(),
          rem_pct: z.coerce.number(),
          light_pct: z.coerce.number(),
          awake_pct: z.coerce.number(),
        }),
        sql`
          WITH sleep_rows AS (
            SELECT
              ${sleepNightDate(tz)} AS sleep_date,
              duration_minutes,
              deep_pct,
              rem_pct,
              light_pct,
              awake_pct
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND is_nap = false
              AND started_at > ${endDate}::date - 14
          )
          SELECT DISTINCT ON (sleep_date)
            sleep_date::text AS date,
            duration_minutes, deep_pct, rem_pct, light_pct, awake_pct
          FROM sleep_rows
          ORDER BY sleep_date DESC, duration_minutes DESC NULLS LAST
        `,
      );

      const lastNightRow = sleepRows.find((r) => isRecent(r.date, endDate));

      // 3. Sleep Need (90-day baseline)
      const sleepBaselineRows = await executeWithSchema(
        ctx.db,
        z.object({
          date: dateStringSchema,
          duration_minutes: z.coerce.number(),
          hrv: z.coerce.number().nullable(),
          yesterday_load: z.coerce.number(),
        }),
        sql`
          WITH sleep_nights AS (
             SELECT DISTINCT ON (sleep_date)
               ${sleepNightDate(tz)} AS sleep_date,
               duration_minutes
             FROM fitness.v_sleep
             WHERE user_id = ${ctx.userId} AND is_nap = false AND started_at > ${timestampWindowStart(endDate, 90)}
             ORDER BY sleep_date, duration_minutes DESC NULLS LAST
          ),
          daily_hrv AS (
            SELECT date, hrv
            FROM fitness.v_daily_metrics
            WHERE user_id = ${ctx.userId} AND date > ${dateWindowStart(endDate, 90)}
          ),
          yesterday_load AS (
            SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0 * avg_hr / NULLIF(max_hr, 0)), 0) AS load
            FROM fitness.activity_summary
            WHERE user_id = ${ctx.userId} AND (started_at AT TIME ZONE ${tz})::date = ${endDate}::date - 1
          )
          SELECT
            s.sleep_date::text AS date,
            s.duration_minutes,
            h.hrv,
            yl.load as yesterday_load
          FROM sleep_nights s
          LEFT JOIN daily_hrv h ON h.date = s.sleep_date + 1
          CROSS JOIN yesterday_load yl
        `,
      );

      const hrvMedian = (() => {
        const values = sleepBaselineRows
          .map((r) => r.hrv)
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b);
        if (values.length === 0) return 50;
        const mid = Math.floor(values.length / 2);
        return values.length % 2 !== 0
          ? (values[mid] ?? 50)
          : ((values[mid - 1] ?? 50) + (values[mid] ?? 50)) / 2;
      })();

      const goodNights = sleepBaselineRows.filter(
        (r) => r.hrv != null && r.hrv >= hrvMedian && r.duration_minutes > 0,
      );
      const baselineMinutes =
        goodNights.length >= 7
          ? Math.round(goodNights.reduce((s, r) => s + r.duration_minutes, 0) / goodNights.length)
          : 480;

      const yesterdayLoad = Number(sleepBaselineRows[0]?.yesterday_load ?? 0);
      const strainDebtMinutes = Math.min(60, Math.round(yesterdayLoad / 5));
      const accumulatedDebt = sleepBaselineRows
        .slice(-14)
        .reduce((acc, r) => acc + Math.max(0, baselineMinutes - r.duration_minutes), 0);
      const totalNeedMinutes =
        baselineMinutes + strainDebtMinutes + Math.round(accumulatedDebt * 0.25);

      const nightsByDate = new Map(sleepBaselineRows.map((r) => [r.date, r]));
      const recentNights: SleepNight[] = [];
      const anchorDate = new Date(`${endDate}T12:00:00Z`);
      for (let i = 7; i >= 1; i--) {
        const nightDate = new Date(anchorDate);
        nightDate.setUTCDate(nightDate.getUTCDate() - i);
        const dateStr = nightDate.toISOString().slice(0, 10);
        const night = nightsByDate.get(dateStr);
        recentNights.push({
          date: dateStr,
          actualMinutes: night ? Math.round(night.duration_minutes) : null,
          neededMinutes: baselineMinutes,
          debtMinutes: night
            ? Math.max(0, Math.round(baselineMinutes - night.duration_minutes))
            : null,
        });
      }

      const yesterdayStr = new Date(anchorDate.getTime() - 86400000).toISOString().slice(0, 10);

      const sleepNeedResult: SleepNeedResult = {
        baselineMinutes,
        strainDebtMinutes,
        accumulatedDebtMinutes: Math.round(accumulatedDebt),
        totalNeedMinutes,
        recentNights,
        canRecommend: nightsByDate.has(yesterdayStr),
      };

      // 4. Strain (Acute/Chronic)
      const acuteLoad = metricsRows
        .slice(0, 7)
        .reduce((sum, r) => sum + Number(r.daily_load ?? 0), 0);
      const chronicLoad =
        metricsRows.slice(0, 28).reduce((sum, r) => sum + Number(r.daily_load ?? 0), 0) / 4;
      const isLatestStrainRecent = metricsRows[0] != null && isRecent(metricsRows[0].date, endDate);
      const latestStrainDailyLoad = isLatestStrainRecent
        ? Math.round(Number(metricsRows[0]?.daily_load ?? 0) * 10) / 10
        : 0;
      const dailyStrain = isLatestStrainRecent
        ? StrainScore.fromRawLoad(latestStrainDailyLoad).value
        : 0;
      const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;

      const strainResult: MobileDashboardResult["strain"] = {
        dailyStrain: Math.round(dailyStrain * 10) / 10,
        acuteLoad: Math.round(acuteLoad),
        chronicLoad: Math.round(chronicLoad),
        workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
        date: metricsRows[0]?.date ?? null,
      };

      // 5. Next Workout
      const trainingRepo = new TrainingRepository(ctx.db, ctx.userId, tz);
      const workoutData = await trainingRepo.getNextWorkoutData(endDate);
      const nextWorkout = await trainingRepo.getRecommendation(workoutData, endDate, weights);

      // 6. Anomalies
      const anomalyRepo = new AnomalyDetectionRepository(ctx.db, ctx.userId, tz);
      const anomalies = await anomalyRepo.check(endDate);

      return {
        readiness: readinessResult,
        sleep: {
          lastNight: lastNightRow
            ? {
                date: lastNightRow.date,
                durationMinutes: lastNightRow.duration_minutes,
                deepPct: lastNightRow.deep_pct,
                remPct: lastNightRow.rem_pct,
                lightPct: lastNightRow.light_pct,
                awakePct: lastNightRow.awake_pct,
              }
            : null,
          sleepDebt: Math.round(accumulatedDebt),
        },
        strain: strainResult,
        nextWorkout,
        sleepNeed: sleepNeedResult,
        anomalies,
        latestDate: metricsRows[0]?.date ?? null,
      };
    }),
});
