import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateWindowStart, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { AnomalyCheckResult } from "../repositories/anomaly-detection-repository.ts";
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

function isWithinLookbackDays(
  dateString: string,
  anchorDateString: string,
  lookbackDays: number,
): boolean {
  const date = new Date(`${dateString}T12:00:00Z`);
  const anchor = new Date(`${anchorDateString}T12:00:00Z`);
  const diffDays = Math.round((anchor.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= lookbackDays;
}

const sleepNeedOutputSchema = z.object({
  baselineMinutes: z.number(),
  strainDebtMinutes: z.number(),
  accumulatedDebtMinutes: z.number(),
  totalNeedMinutes: z.number(),
  recentNights: z.array(
    z.object({
      date: z.string(),
      actualMinutes: z.number().nullable(),
      neededMinutes: z.number(),
      debtMinutes: z.number().nullable(),
    }),
  ),
  canRecommend: z.boolean(),
}) satisfies z.ZodType<SleepNeedResult>;

const anomalyCheckOutputSchema = z.object({
  anomalies: z.array(
    z.object({
      date: z.string(),
      metric: z.string(),
      value: z.number(),
      baselineMean: z.number(),
      baselineStddev: z.number(),
      zScore: z.number(),
      severity: z.enum(["warning", "alert"]),
    }),
  ),
  checkedMetrics: z.array(z.string()),
}) satisfies z.ZodType<AnomalyCheckResult>;

const mobileDashboardOutputSchema = z.object({
  readiness: z
    .object({
      score: z.number(),
      date: z.string(),
      components: z.object({
        hrvScore: z.number(),
        restingHrScore: z.number(),
        sleepScore: z.number(),
        respiratoryRateScore: z.number(),
      }),
      weights: z.object({
        hrv: z.number(),
        restingHr: z.number(),
        sleep: z.number(),
        respiratoryRate: z.number(),
      }),
    })
    .nullable(),
  sleep: z
    .object({
      lastNight: z
        .object({
          date: z.string(),
          durationMinutes: z.number(),
          deepPct: z.number(),
          remPct: z.number(),
          lightPct: z.number(),
          awakePct: z.number(),
        })
        .nullable(),
      sleepDebt: z.number(),
    })
    .nullable(),
  strain: z.object({
    dailyStrain: z.number(),
    acuteLoad: z.number(),
    chronicLoad: z.number(),
    workloadRatio: z.number().nullable(),
    date: z.string().nullable(),
  }),
  sleepNeed: sleepNeedOutputSchema.nullable(),
  anomalies: anomalyCheckOutputSchema.nullable(),
  latestDate: z.string().nullable(),
});

export type MobileDashboardResult = z.infer<typeof mobileDashboardOutputSchema>;

export const mobileDashboardRouter = router({
  dashboard: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .output(mobileDashboardOutputSchema)
    .query(async ({ ctx, input }): Promise<MobileDashboardResult> => {
      const { endDate } = input;
      const tz = ctx.timezone;
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.dashboard");
      const timings: string[] = [];
      const dashboardStart = performance.now();
      const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
        const start = performance.now();
        try {
          return await work();
        } finally {
          timings.push(`${label}=${Math.round(performance.now() - start)}ms`);
        }
      };

      // Fetch daily loads (last 60 days) + yesterday's load from ClickHouse.
      const [dailyLoadRows, yesterdayLoadRows, restingHeartRateRows] = await timed(
        "activity-loads",
        () =>
          Promise.all([
            sensorStore.query(
              z.object({
                metric_date: z.string(),
                daily_load: z.coerce.number(),
              }),
              `SELECT
            toString(date) AS metric_date,
            daily_load
          FROM analytics.strain_read_model FINAL
          WHERE user_id = {userId:UUID}
            AND date > toDate({endDate:String}) - 60
            AND date <= toDate({endDate:String})`,
              { userId: ctx.userId, endDate },
            ),
            sensorStore.query(
              z.object({ load: z.coerce.number() }),
              `SELECT coalesce(daily_load, 0) AS load
          FROM analytics.strain_read_model FINAL
          WHERE user_id = {userId:UUID}
            AND date = toDate({endDate:String}) - 1`,
              { userId: ctx.userId, endDate },
            ),
            fetchRestingHeartRateRows({
              sensorStore,
              userId: ctx.userId,
              timezone: tz,
              endDate,
              days: 60,
            }),
          ]),
      );

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

      const [metricsRowsWithoutSleep, unsortedDashboardSleepRows] = await timed(
        "readiness-and-sleep",
        () =>
          Promise.all([
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
              days: 90,
              accessWindow: ctx.accessWindow,
              order: "asc",
            }),
          ]),
      );
      const dashboardSleepRows = [...unsortedDashboardSleepRows].sort((firstNight, secondNight) =>
        firstNight.date.localeCompare(secondNight.date),
      );

      const sleepEfficiencyByDate = new Map(
        dashboardSleepRows
          .filter((sleepNight) => isWithinLookbackDays(sleepNight.date, endDate, 60))
          .map((sleepNight) => [sleepNight.date, sleepNight.efficiency_pct]),
      );
      const metricsRows = metricsRowsWithoutSleep.map((row) => ({
        ...row,
        efficiency_pct: sleepEfficiencyByDate.get(row.date) ?? null,
      }));

      const latestMetric = metricsRows[0];
      let readinessResult: MobileDashboardResult["readiness"] = null;

      const storedParams = await timed("personalization", () =>
        loadPersonalizedParams(ctx.db, ctx.userId),
      );
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
      const sleepRows = [...dashboardSleepRows]
        .filter((sleepNight) => isWithinLookbackDays(sleepNight.date, endDate, 14))
        .reverse()
        .map((row) => {
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
      const hrvRows = await timed("sleep-need-hrv", () =>
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
      );
      const hrvByDate = new Map(hrvRows.map((row) => [row.date, row.hrv]));
      const sleepBaselineRows = dashboardSleepRows.map((row) => ({
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

      const sleepNeedResult: SleepNeedResult | null =
        sleepBaselineRows.length > 0
          ? {
              baselineMinutes,
              strainDebtMinutes,
              accumulatedDebtMinutes: Math.round(accumulatedDebt),
              totalNeedMinutes,
              recentNights,
              canRecommend: nightsByDate.has(yesterdayStr),
            }
          : null;

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
      const anomalies = null;

      const result = {
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
      timings.push(`total=${Math.round(performance.now() - dashboardStart)}ms`);
      logger.info(
        `[mobile-dashboard] dashboard timings userId=${ctx.userId} endDate=${endDate} ${timings.join(" ")}`,
      );
      return result;
    }),
});
