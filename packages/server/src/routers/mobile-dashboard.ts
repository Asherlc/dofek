import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateWindowStart, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type AnomalyCheckResult,
  AnomalyDetectionRepository,
} from "../repositories/anomaly-detection-repository.ts";
import { fetchSleepNights } from "../repositories/clickhouse-sleep-repository.ts";
import {
  fetchRestingHeartRateRows,
  restingHeartRateValuesCte,
} from "../repositories/resting-heart-rate-query.ts";
import {
  computeComponentScores,
  computeReadinessScore,
} from "../repositories/training-recommendation.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";
import type { SleepNeedResult, SleepNight } from "./sleep-need.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

/** Simple date comparison for server-side logic (where @dofek/format is not available). */
export function isRecent(dateStr: string, anchorDateStr: string): boolean {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const anchor = new Date(`${anchorDateStr}T12:00:00Z`);
  const diffDays = Math.round((anchor.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= 1;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.dashboard");

      // Fetch daily loads (last 60 days) + yesterday's load from ClickHouse.
      const [dailyLoadRows, yesterdayLoadRows, restingHeartRateRows] = await Promise.all([
        sensorStore.query(
          z.object({
            metric_date: z.string(),
            daily_load: z.coerce.number(),
          }),
          `SELECT
            toString(toDate(toTimeZone(ended_at, {timezone:String}))) AS metric_date,
            sum(dateDiff('second', started_at, ended_at) / 60.0
                * avg_hr / nullIf(toFloat64(max_hr), 0)) AS daily_load
          FROM analytics.activity_summary
          WHERE user_id = {userId:UUID}
            AND ended_at IS NOT NULL
            AND avg_hr IS NOT NULL
            AND toDate(toTimeZone(ended_at, {timezone:String})) > toDate({endDate:String}) - 60
            AND toDate(toTimeZone(ended_at, {timezone:String})) <= toDate({endDate:String})
          GROUP BY metric_date`,
          { userId: ctx.userId, timezone: tz, endDate },
        ),
        sensorStore.query(
          z.object({ load: z.coerce.number() }),
          `SELECT coalesce(sum(dateDiff('second', started_at, ended_at) / 60.0
                  * avg_hr / nullIf(toFloat64(max_hr), 0)), 0) AS load
          FROM analytics.activity_summary
          WHERE user_id = {userId:UUID}
            AND toDate(toTimeZone(started_at, {timezone:String})) = toDate({endDate:String}) - 1`,
          { userId: ctx.userId, timezone: tz, endDate },
        ),
        fetchRestingHeartRateRows({
          sensorStore,
          userId: ctx.userId,
          timezone: tz,
          endDate,
          days: 60,
        }),
      ]);

      const dailyLoadByDate = new Map(
        dailyLoadRows.map((row) => [row.metric_date, row.daily_load]),
      );
      const yesterdayLoadFromCh = yesterdayLoadRows[0]?.load ?? 0;
      const restingHeartRateCte = restingHeartRateValuesCte(restingHeartRateRows);

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
      });

      const [metricsRowsWithoutSleep, readinessSleepRows] = await Promise.all([
        executeWithSchema(
          ctx.db,
          readinessSchema,
          sql`
          WITH ${restingHeartRateCte},
          metrics_base AS (
            SELECT
              base_dates.date AS metric_date,
              dm.hrv,
              drhr.resting_hr,
              dm.respiratory_rate_avg AS respiratory_rate
            FROM (
              SELECT user_id, date
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > ${endDate}::date - 60
                AND date <= ${endDate}
              UNION
              SELECT ${ctx.userId} AS user_id, date
              FROM resting_heart_rate
            ) base_dates
            LEFT JOIN fitness.v_daily_metrics dm
              ON dm.user_id = base_dates.user_id
             AND dm.date = base_dates.date
            LEFT JOIN resting_heart_rate drhr
              ON drhr.date = base_dates.date
          ),
          metrics_with_baselines AS (
            SELECT
              metric_date,
              hrv,
              resting_hr,
              respiratory_rate,
              AVG(hrv) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_mean_30d,
              STDDEV_POP(hrv) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS hrv_sd_30d,
              AVG(resting_hr) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_mean_30d,
              STDDEV_POP(resting_hr) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rhr_sd_30d,
              AVG(respiratory_rate) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_mean_30d,
              STDDEV_POP(respiratory_rate) OVER (ORDER BY metric_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) AS rr_sd_30d
            FROM metrics_base
          )
          SELECT
            m.metric_date::text AS date,
            m.hrv, m.resting_hr, m.respiratory_rate, NULL::real AS efficiency_pct,
            m.hrv_mean_30d, m.hrv_sd_30d, m.rhr_mean_30d, m.rhr_sd_30d, m.rr_mean_30d, m.rr_sd_30d
          FROM metrics_with_baselines m
          ORDER BY m.metric_date DESC
        `,
        ),
        fetchSleepNights({
          sensorStore,
          userId: ctx.userId,
          timezone: tz,
          endDate,
          days: 60,
          accessWindow: ctx.accessWindow,
          order: "asc",
        }),
      ]);

      const sleepEfficiencyByDate = new Map(
        readinessSleepRows.map((row) => [row.date, row.efficiency_pct]),
      );
      const metricsRows = metricsRowsWithoutSleep.map((row) => ({
        ...row,
        efficiency_pct: sleepEfficiencyByDate.get(row.date) ?? null,
      }));

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
      const sleepRows = (
        await fetchSleepNights({
          sensorStore,
          userId: ctx.userId,
          timezone: tz,
          endDate,
          days: 14,
          accessWindow: ctx.accessWindow,
          order: "desc",
        })
      ).map((row) => {
        const durationMinutes = row.duration_minutes ?? 0;
        return {
          date: row.date,
          duration_minutes: durationMinutes,
          deep_pct: durationMinutes > 0 ? ((row.deep_minutes ?? 0) / durationMinutes) * 100 : 0,
          rem_pct: durationMinutes > 0 ? ((row.rem_minutes ?? 0) / durationMinutes) * 100 : 0,
          light_pct: durationMinutes > 0 ? ((row.light_minutes ?? 0) / durationMinutes) * 100 : 0,
          awake_pct: durationMinutes > 0 ? ((row.awake_minutes ?? 0) / durationMinutes) * 100 : 0,
        };
      });

      const lastNightRow = sleepRows.find((r) => isRecent(r.date, endDate));

      // 3. Sleep Need (90-day baseline)
      const [baselineSleepRows, hrvRows] = await Promise.all([
        fetchSleepNights({
          sensorStore,
          userId: ctx.userId,
          timezone: tz,
          endDate,
          days: 90,
          accessWindow: ctx.accessWindow,
          order: "asc",
        }),
        executeWithSchema(
          ctx.db,
          z.object({
            date: dateStringSchema,
            hrv: z.coerce.number().nullable(),
          }),
          sql`
          SELECT
            date::text AS date,
            hrv
          FROM fitness.v_daily_metrics
          WHERE user_id = ${ctx.userId} AND date > ${dateWindowStart(endDate, 90)}
        `,
        ),
      ]);
      const hrvByDate = new Map(hrvRows.map((row) => [row.date, row.hrv]));
      const sleepBaselineRows = baselineSleepRows.map((row) => ({
        date: row.date,
        duration_minutes: row.duration_minutes ?? 0,
        hrv: hrvByDate.get(addDays(row.date, 1)) ?? null,
        yesterday_load: yesterdayLoadFromCh,
      }));

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

      // 4. Strain (Acute/Chronic) — daily loads come from ClickHouse, indexed by metric date
      const acuteLoad = metricsRows
        .slice(0, 7)
        .reduce((sum, r) => sum + (dailyLoadByDate.get(r.date) ?? 0), 0);
      const chronicLoad =
        metricsRows.slice(0, 28).reduce((sum, r) => sum + (dailyLoadByDate.get(r.date) ?? 0), 0) /
        4;
      const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;
      const todayActivityLoad = dailyLoadByDate.get(endDate) ?? 0;
      const currentStrain = computeCurrentStrain({ fallbackActivityLoad: todayActivityLoad });

      const strainResult: MobileDashboardResult["strain"] = {
        dailyStrain: Math.round(currentStrain.currentStrain * 10) / 10,
        acuteLoad: Math.round(acuteLoad),
        chronicLoad: Math.round(chronicLoad),
        workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
        date: metricsRows[0]?.date ?? null,
      };

      // 5. Anomalies
      const anomalyRepo = new AnomalyDetectionRepository(ctx.db, ctx.userId, tz, sensorStore);
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
        sleepNeed: sleepNeedResult,
        anomalies,
        latestDate: metricsRows[0]?.date ?? null,
      };
    }),
});
