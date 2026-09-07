import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { dateWindowStartString } from "../lib/date-window.ts";
import {
  monthlyReportEmptyState,
  type ReportEmptyState,
  weeklyReportEmptyState,
} from "./report-empty-state.ts";

export interface ReportDateRange {
  startDate: string;
  endDate: string;
}

export interface ReportRecovery {
  range: ReportDateRange;
  emptyMessage: string;
}

function recoveryForRange(range: ReportDateRange, emptyState: ReportEmptyState): ReportRecovery {
  return {
    range,
    emptyMessage: `${emptyState.title} ${emptyState.requirement} Period: ${range.startDate} through ${range.endDate}.`,
  };
}

export function weeklyReportRecovery(weeks: number, endDate: string): ReportRecovery {
  const end = new Date(`${endDate}T00:00:00Z`);
  const daysSinceFirstWeekStart = end.getUTCDay() + (weeks - 1) * 7;
  return recoveryForRange(
    {
      startDate: dateWindowStartString(endDate, daysSinceFirstWeekStart),
      endDate,
    },
    weeklyReportEmptyState,
  );
}

export function monthlyReportRecovery(months: number, endDate: string): ReportRecovery {
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));
  return recoveryForRange(
    {
      startDate: formatDateYmdInTimeZone(start, "UTC"),
      endDate,
    },
    monthlyReportEmptyState,
  );
}

export function reportRefreshErrorMessage(
  reportType: "weekly" | "monthly",
  range: ReportDateRange,
): string {
  return `The ${reportType} report for ${range.startDate} through ${range.endDate} could not be refreshed. Retry now or review processing alerts if the problem continues.`;
}
