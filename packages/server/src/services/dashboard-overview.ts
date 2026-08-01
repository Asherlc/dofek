import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { getEffectiveParams } from "dofek/personalization/params";
import { z } from "zod";
import {
  buildSleepNeedComputation,
  type SleepNeedResult,
  type SleepNeedV2,
  type SleepNight,
  toSleepNeedV1,
  toSleepNeedV2,
} from "../contracts/sleep-need-contract.ts";
import { computeCurrentStrain } from "../lib/current-strain.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { computeReadinessScore } from "../repositories/training-recommendation.ts";

type DashboardAccessWindow =
  | { kind: "full" }
  | { kind: "limited"; startDate: string; endDateExclusive: string };

interface LoadDashboardOverviewInput {
  accessWindow: DashboardAccessWindow;
  endDate: string;
  readinessWeights?: ReturnType<typeof getEffectiveParams>["readinessWeights"];
  sensorStore: ActivitySensorStore;
  userId: string;
}

export interface DashboardOverviewResult {
  readiness: {
    score: number;
    date: string;
    components: {
      hrvScore: number;
      restingHrScore: number;
      sleepScore: number;
      respiratoryRateScore: number;
    };
    weights: ReturnType<typeof getEffectiveParams>["readinessWeights"];
  } | null;
  sleep: {
    lastNight: {
      date: string;
      durationMinutes: number;
      deepPct: number | null;
      remPct: number | null;
      lightPct: number | null;
      awakePct: number | null;
      stagingAvailable: boolean;
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
  sleepNeedV2: SleepNeedV2;
  anomalies: null;
  latestDate: string | null;
}

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
  staging_available: z.boolean(),
});

export function isRecent(dateString: string, anchorDateString: string): boolean {
  const date = new Date(`${dateString}T12:00:00Z`);
  const anchor = new Date(`${anchorDateString}T12:00:00Z`);
  const diffDays = Math.round((anchor.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= 1;
}

function addDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateYmdInTimeZone(date, "UTC");
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

function accessWindowDateClause(accessWindow: DashboardAccessWindow, dateColumn: string): string {
  return accessWindow.kind === "limited"
    ? `AND ${dateColumn} >= toDate({accessStartDate:String})
            AND ${dateColumn} < toDate({accessEndDateExclusive:String})`
    : "";
}

function accessWindowDateParams(accessWindow: DashboardAccessWindow): Record<string, string> {
  return accessWindow.kind === "limited"
    ? {
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      }
    : {};
}

export async function loadDashboardOverview({
  accessWindow,
  endDate,
  readinessWeights,
  sensorStore,
  userId,
}: LoadDashboardOverviewInput): Promise<DashboardOverviewResult> {
  const dashboardDays = 90;
  const dateParams = accessWindowDateParams(accessWindow);

  const [dailyLoadRows, yesterdayLoadRows] = await Promise.all([
    sensorStore.query(
      z.object({
        metric_date: dateStringSchema,
        daily_load: z.coerce.number(),
      }),
      `SELECT
            toString(strain.date) AS metric_date,
            strain.daily_load
          FROM analytics.daily_strain AS strain FINAL
          WHERE strain.user_id = {userId:UUID}
            AND strain.is_deleted = 0
            AND strain.date > toDate({endDate:String}) - {days:UInt32}
            AND strain.date <= toDate({endDate:String})
            ${accessWindowDateClause(accessWindow, "strain.date")}
          ORDER BY strain.date DESC`,
      { userId, endDate, days: dashboardDays, ...dateParams },
      { priority: "dashboard" },
    ),
    sensorStore.query(
      z.object({ load: z.coerce.number().nullable() }),
      `SELECT sumOrNull(strain.daily_load) AS load
          FROM analytics.daily_strain AS strain FINAL
          WHERE strain.user_id = {userId:UUID}
            AND strain.is_deleted = 0
            AND strain.date = toDate({endDate:String}) - 1
            ${accessWindowDateClause(accessWindow, "strain.date")}`,
      { userId, endDate, ...dateParams },
      { priority: "dashboard" },
    ),
  ]);

  const dailyLoadByDate = new Map(dailyLoadRows.map((row) => [row.metric_date, row.daily_load]));
  const yesterdayLoadFromClickHouse = yesterdayLoadRows[0]?.load ?? null;

  const readinessRows = await sensorStore.query(
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
            AND recovery.is_deleted = 0
            AND recovery.date > toDate({endDate:String}) - {days:UInt32}
            AND recovery.date <= toDate({endDate:String})
            ${accessWindowDateClause(accessWindow, "recovery.date")}
          ORDER BY recovery.date DESC`,
    { userId, endDate, days: dashboardDays, ...dateParams },
    { priority: "dashboard" },
  );
  const unsortedDashboardSleepRows = await sensorStore.query(
    sleepSummaryRowSchema,
    `SELECT
            toString(date) AS date,
            duration_minutes,
            deep_minutes,
            rem_minutes,
            light_minutes,
            awake_minutes,
            staging_available
          FROM analytics.daily_sleep AS sleep FINAL
          WHERE sleep.user_id = {userId:UUID}
            AND sleep.is_deleted = 0
            AND sleep.date > toDate({endDate:String}) - {days:UInt32}
            AND sleep.date <= toDate({endDate:String})
            ${accessWindowDateClause(accessWindow, "sleep.date")}
          ORDER BY sleep.date ASC`,
    { userId, endDate, days: dashboardDays, ...dateParams },
    { priority: "dashboard" },
  );
  const dashboardSleepRows = [...unsortedDashboardSleepRows].sort((firstNight, secondNight) =>
    firstNight.date.localeCompare(secondNight.date),
  );

  const latestMetric = readinessRows[0];
  let readinessResult: DashboardOverviewResult["readiness"] = null;
  const weights = readinessWeights ?? getEffectiveParams(null).readinessWeights;

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

  const sleepRows = [...dashboardSleepRows]
    .filter((sleepNight) => isWithinLookbackDays(sleepNight.date, endDate, 14))
    .reverse()
    .flatMap((row) => {
      if (row.duration_minutes == null) return [];
      return [
        {
          date: row.date,
          duration_minutes: row.duration_minutes,
          deep_pct:
            row.staging_available && row.duration_minutes > 0
              ? ((row.deep_minutes ?? 0) / row.duration_minutes) * 100
              : null,
          rem_pct:
            row.staging_available && row.duration_minutes > 0
              ? ((row.rem_minutes ?? 0) / row.duration_minutes) * 100
              : null,
          light_pct:
            row.staging_available && row.duration_minutes > 0
              ? ((row.light_minutes ?? 0) / row.duration_minutes) * 100
              : null,
          awake_pct:
            row.staging_available && row.duration_minutes > 0
              ? ((row.awake_minutes ?? 0) / row.duration_minutes) * 100
              : null,
          staging_available: row.staging_available,
        },
      ];
    });

  const lastNightRow = sleepRows.find((row) => isRecent(row.date, endDate));
  const hrvByDate = new Map(readinessRows.map((row) => [row.date, row.hrv]));
  const sleepBaselineRows = dashboardSleepRows.map((row) => ({
    date: row.date,
    duration_minutes: row.duration_minutes,
    hrv: hrvByDate.get(addDays(row.date, 1)) ?? null,
    yesterday_load: yesterdayLoadFromClickHouse,
  }));

  const hrvMedian = (() => {
    const values = sleepBaselineRows
      .map((row) => row.hrv)
      .filter((value): value is number => value != null)
      .sort((firstValue, secondValue) => firstValue - secondValue);
    if (values.length === 0) return 50;
    const midpoint = Math.floor(values.length / 2);
    return values.length % 2 !== 0
      ? (values[midpoint] ?? 50)
      : ((values[midpoint - 1] ?? 50) + (values[midpoint] ?? 50)) / 2;
  })();

  const goodNightDurations = sleepBaselineRows
    .filter((row) => row.hrv != null && row.hrv >= hrvMedian)
    .map((row) => row.duration_minutes)
    .filter((duration): duration is number => duration != null && duration > 0);
  const baselineMinutes =
    goodNightDurations.length >= 7
      ? Math.round(
          goodNightDurations.reduce(
            (totalMinutes, durationMinutes) => totalMinutes + durationMinutes,
            0,
          ) / goodNightDurations.length,
        )
      : 480;

  const yesterdayLoad = yesterdayLoadFromClickHouse ?? 0;
  const strainDebtMinutes = Math.min(60, Math.round(yesterdayLoad / 5));
  const recentDebtRows = sleepBaselineRows.slice(-14);
  const debtObservedNightCount = recentDebtRows.filter(
    (row) => row.duration_minutes != null,
  ).length;
  const accumulatedDebt = recentDebtRows.reduce(
    (totalDebt, row) =>
      row.duration_minutes == null
        ? totalDebt
        : totalDebt + Math.max(0, baselineMinutes - row.duration_minutes),
    0,
  );
  const nightsByDate = new Map(sleepBaselineRows.map((row) => [row.date, row]));
  const recentNights: SleepNight[] = [];
  const anchorDate = new Date(`${endDate}T12:00:00Z`);
  for (let dayOffset = 7; dayOffset >= 1; dayOffset -= 1) {
    const nightDate = new Date(anchorDate);
    nightDate.setUTCDate(nightDate.getUTCDate() - dayOffset);
    const dateString = formatDateYmdInTimeZone(nightDate, "UTC");
    const night = nightsByDate.get(dateString);
    recentNights.push({
      date: dateString,
      actualMinutes: night?.duration_minutes != null ? Math.round(night.duration_minutes) : null,
      neededMinutes: baselineMinutes,
      debtMinutes:
        night?.duration_minutes != null
          ? Math.max(0, Math.round(baselineMinutes - night.duration_minutes))
          : null,
      providerId: null,
      sourceName: null,
      sourceProviders: [],
    });
  }

  const yesterdayDateString = formatDateYmdInTimeZone(
    new Date(anchorDate.getTime() - 86400000),
    "UTC",
  );

  const sleepNeedComputation = buildSleepNeedComputation({
    baselineMinutes,
    strainDebtMinutes,
    accumulatedDebtMinutes: Math.round(accumulatedDebt),
    baselineQualifyingNightCount: goodNightDurations.length,
    debtObservedNightCount,
    recentNights,
    hasPreviousNight: dashboardSleepRows.some(
      (sleepRow) => sleepRow.date === yesterdayDateString && sleepRow.duration_minutes != null,
    ),
    hasYesterdayLoad: yesterdayLoadFromClickHouse != null,
  });
  const sleepNeedResult = toSleepNeedV1(sleepNeedComputation);

  const acuteLoad = dailyLoadRows.reduce((totalLoad, row) => {
    const daysAgo = Math.floor(
      (new Date(endDate).getTime() - new Date(row.metric_date).getTime()) / 86400000,
    );
    return daysAgo >= 0 && daysAgo < 7 ? totalLoad + row.daily_load : totalLoad;
  }, 0);
  const chronicLoad =
    dailyLoadRows.reduce((totalLoad, row) => {
      const daysAgo = Math.floor(
        (new Date(endDate).getTime() - new Date(row.metric_date).getTime()) / 86400000,
      );
      return daysAgo >= 0 && daysAgo < 28 ? totalLoad + row.daily_load : totalLoad;
    }, 0) / 4;
  const workloadRatio = chronicLoad > 0 ? acuteLoad / chronicLoad : null;
  const todayActivityLoad = dailyLoadByDate.get(endDate) ?? 0;
  const currentStrain = computeCurrentStrain({ fallbackActivityLoad: todayActivityLoad });

  const strainResult: DashboardOverviewResult["strain"] = {
    dailyStrain: Math.round(currentStrain.currentStrain * 10) / 10,
    acuteLoad: Math.round(acuteLoad),
    chronicLoad: Math.round(chronicLoad),
    workloadRatio: workloadRatio != null ? Math.round(workloadRatio * 100) / 100 : null,
    date: latestMetric?.date ?? dailyLoadRows[0]?.metric_date ?? null,
  };

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
            stagingAvailable: lastNightRow.staging_available,
          }
        : null,
      sleepDebt: Math.round(accumulatedDebt),
    },
    strain: strainResult,
    sleepNeed: sleepNeedResult,
    sleepNeedV2: toSleepNeedV2(sleepNeedComputation),
    anomalies: null,
    latestDate:
      latestMetric?.date ??
      dashboardSleepRows.at(-1)?.date ??
      dailyLoadRows[0]?.metric_date ??
      null,
  };
}
