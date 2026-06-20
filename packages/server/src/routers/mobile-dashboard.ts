import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateWindowInput, endDateSchema } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { AnomalyCheckResult } from "../repositories/anomaly-detection-repository.ts";
import { computeReadinessScore } from "../repositories/training-recommendation.ts";
import {
  loadMobileRecoveryTab,
  mobileRecoveryTabOutputSchema,
} from "../services/mobile-recovery-tab.ts";
import {
  loadMobileTrainingTab,
  mobileTrainingTabOutputSchema,
} from "../services/mobile-training-tab.ts";
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

function requireAccessWindow(
  accessWindow: AccessWindow | undefined,
  feature: string,
): AccessWindow {
  if (!accessWindow) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires resolved entitlement access window.`,
    });
  }
  return accessWindow;
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

const recoveryServingRowSchema = z.object({
  date: dateStringSchema,
  hrv: z.coerce.number().nullable(),
  hrv_score: z.coerce.number().nullable(),
  resting_hr_score: z.coerce.number().nullable(),
  sleep_score: z.coerce.number().nullable(),
  respiratory_rate_score: z.coerce.number().nullable(),
});

const sleepSummaryRowSchema = z.object({
  date: dateStringSchema,
  duration_minutes: z.coerce.number().nullable(),
  deep_minutes: z.coerce.number().nullable(),
  rem_minutes: z.coerce.number().nullable(),
  light_minutes: z.coerce.number().nullable(),
  awake_minutes: z.coerce.number().nullable(),
});

export const mobileDashboardRouter = router({
  dashboard: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ endDate: endDateSchema }))
    .output(mobileDashboardOutputSchema)
    .query(async ({ ctx, input }): Promise<MobileDashboardResult> => {
      const { endDate } = input;
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.dashboard");
      const accessWindow = ctx.accessWindow ?? { kind: "full" as const };
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

      const dashboardDays = 90;
      const accessWindowDateClause = (dateColumn: string): string =>
        accessWindow.kind === "limited"
          ? `AND ${dateColumn} >= toDate({accessStartDate:String})
            AND ${dateColumn} < toDate({accessEndDateExclusive:String})`
          : "";
      const accessWindowDateParams =
        accessWindow.kind === "limited"
          ? {
              accessStartDate: accessWindow.startDate,
              accessEndDateExclusive: accessWindow.endDateExclusive,
            }
          : {};

      // Fetch daily loads (last 90 days) + yesterday's load from ClickHouse.
      const [dailyLoadRows, yesterdayLoadRows] = await timed("activity-loads", () =>
        Promise.all([
          sensorStore.query(
            z.object({
              metric_date: z.string(),
              daily_load: z.coerce.number(),
            }),
            `SELECT
            toString(strain.date) AS metric_date,
            strain.daily_load
          FROM analytics.daily_strain AS strain FINAL
          WHERE strain.user_id = {userId:UUID}
            AND strain.date > toDate({endDate:String}) - {days:UInt32}
            AND strain.date <= toDate({endDate:String})
            ${accessWindowDateClause("strain.date")}
          ORDER BY strain.date DESC`,
            { userId: ctx.userId, endDate, days: dashboardDays, ...accessWindowDateParams },
          ),
          sensorStore.query(
            z.object({ load: z.coerce.number() }),
            `SELECT coalesce(strain.daily_load, 0) AS load
          FROM analytics.daily_strain AS strain FINAL
          WHERE strain.user_id = {userId:UUID}
            AND strain.date = toDate({endDate:String}) - 1
            ${accessWindowDateClause("strain.date")}`,
            { userId: ctx.userId, endDate, ...accessWindowDateParams },
          ),
        ]),
      );

      const dailyLoadByDate = new Map(
        dailyLoadRows.map((row) => [row.metric_date, row.daily_load]),
      );
      const yesterdayLoadFromCh = yesterdayLoadRows[0]?.load ?? 0;

      const readinessRows = await timed("readiness", () =>
        sensorStore.query(
          recoveryServingRowSchema,
          `SELECT
            toString(date) AS date,
            hrv,
            hrv_score,
            resting_hr_score,
            sleep_score,
            respiratory_rate_score
          FROM analytics.daily_recovery AS recovery FINAL
          WHERE recovery.user_id = {userId:UUID}
            AND recovery.date > toDate({endDate:String}) - {days:UInt32}
            AND recovery.date <= toDate({endDate:String})
            ${accessWindowDateClause("recovery.date")}
          ORDER BY recovery.date DESC`,
          { userId: ctx.userId, endDate, days: dashboardDays, ...accessWindowDateParams },
        ),
      );
      const unsortedDashboardSleepRows = await timed("sleep", () =>
        sensorStore.query(
          sleepSummaryRowSchema,
          `SELECT
            toString(date) AS date,
            duration_minutes,
            deep_minutes,
            rem_minutes,
            light_minutes,
            awake_minutes
          FROM analytics.daily_sleep AS sleep FINAL
          WHERE sleep.user_id = {userId:UUID}
            AND sleep.date > toDate({endDate:String}) - {days:UInt32}
            AND sleep.date <= toDate({endDate:String})
            ${accessWindowDateClause("sleep.date")}
          ORDER BY sleep.date ASC`,
          { userId: ctx.userId, endDate, days: dashboardDays, ...accessWindowDateParams },
        ),
      );
      const dashboardSleepRows = [...unsortedDashboardSleepRows].sort((firstNight, secondNight) =>
        firstNight.date.localeCompare(secondNight.date),
      );

      const latestMetric = readinessRows[0];
      let readinessResult: MobileDashboardResult["readiness"] = null;

      const storedParams = await timed("personalization", () =>
        loadPersonalizedParams(ctx.db, ctx.userId),
      );
      const weights = getEffectiveParams(storedParams).readinessWeights;

      if (latestMetric && isRecent(latestMetric.date, endDate)) {
        const scores = {
          hrvScore: Math.round(latestMetric.hrv_score ?? 62),
          restingHrScore: Math.round(latestMetric.resting_hr_score ?? 62),
          sleepScore: Math.round(latestMetric.sleep_score ?? 62),
          respiratoryRateScore: Math.round(latestMetric.respiratory_rate_score ?? 62),
        };
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
      const hrvByDate = new Map(readinessRows.map((row) => [row.date, row.hrv]));
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
      const acuteLoad = dailyLoadRows.reduce((sum, row) => {
        const daysAgo = Math.floor(
          (new Date(endDate).getTime() - new Date(row.metric_date).getTime()) / 86400000,
        );
        return daysAgo >= 0 && daysAgo < 7 ? sum + row.daily_load : sum;
      }, 0);
      const chronicLoad =
        dailyLoadRows.reduce((sum, row) => {
          const daysAgo = Math.floor(
            (new Date(endDate).getTime() - new Date(row.metric_date).getTime()) / 86400000,
          );
          return daysAgo >= 0 && daysAgo < 28 ? sum + row.daily_load : sum;
        }, 0) / 4;
      const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;
      const todayActivityLoad = dailyLoadByDate.get(endDate) ?? 0;
      const currentStrain = computeCurrentStrain({ fallbackActivityLoad: todayActivityLoad });

      const strainResult: MobileDashboardResult["strain"] = {
        dailyStrain: Math.round(currentStrain.currentStrain * 10) / 10,
        acuteLoad: Math.round(acuteLoad),
        chronicLoad: Math.round(chronicLoad),
        workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
        date: latestMetric?.date ?? dailyLoadRows[0]?.metric_date ?? null,
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
        latestDate:
          latestMetric?.date ??
          dashboardSleepRows.at(-1)?.date ??
          dailyLoadRows[0]?.metric_date ??
          null,
      };
      timings.push(`total=${Math.round(performance.now() - dashboardStart)}ms`);
      logger.info(
        `[mobile-dashboard] dashboard timings userId=${ctx.userId} endDate=${endDate} ${timings.join(" ")}`,
      );
      return result;
    }),

  recovery: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .output(mobileRecoveryTabOutputSchema)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.recovery");
      const tabStart = performance.now();
      const result = await loadMobileRecoveryTab(
        {
          db: ctx.db,
          userId: ctx.userId,
          timezone: ctx.timezone ?? "UTC",
          accessWindow: requireAccessWindow(ctx.accessWindow, "mobileDashboard.recovery"),
          sensorStore,
        },
        input.days,
        input.endDate,
      );
      logger.info(
        `[mobile-dashboard] recovery timings userId=${ctx.userId} endDate=${input.endDate} days=${input.days} total=${Math.round(performance.now() - tabStart)}ms`,
      );
      return result;
    }),

  training: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .output(mobileTrainingTabOutputSchema)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.training");
      const tabStart = performance.now();
      const result = await loadMobileTrainingTab(
        {
          db: ctx.db,
          userId: ctx.userId,
          timezone: ctx.timezone ?? "UTC",
          accessWindow: requireAccessWindow(ctx.accessWindow, "mobileDashboard.training"),
          sensorStore,
        },
        input.days,
        input.endDate,
      );
      logger.info(
        `[mobile-dashboard] training timings userId=${ctx.userId} endDate=${input.endDate} days=${input.days} total=${Math.round(performance.now() - tabStart)}ms`,
      );
      return result;
    }),
});
