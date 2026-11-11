import type { SummaryDateContext } from "@dofek/format/summary-date-context";
import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";

type DashboardAccessWindow =
  | { kind: "full" }
  | { kind: "limited"; startDate: string; endDateExclusive: string };

interface LoadDashboardOverviewInput {
  accessWindow: DashboardAccessWindow;
  endDate: string;
  sensorStore: ActivitySensorStore;
  timezone?: string;
  userId: string;
}

export interface DashboardOverviewResult {
  summaryDateContext: SummaryDateContext;
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
  } | null;
  anomalies: null;
  latestDate: string | null;
}

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
  sensorStore,
  timezone = "UTC",
  userId,
}: LoadDashboardOverviewInput): Promise<DashboardOverviewResult> {
  const dashboardDays = 90;
  const dateParams = accessWindowDateParams(accessWindow);
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
  return {
    summaryDateContext: { effectiveDate: endDate, timezone },
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
    },
    anomalies: null,
    latestDate: dashboardSleepRows.at(-1)?.date ?? null,
  };
}
