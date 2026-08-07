import type { TimeRangeDays } from "@dofek/stats/time-range";

export type { TimeRangeDays } from "@dofek/stats/time-range";

export const TIME_RANGE_OPTIONS: ReadonlyArray<{ label: string; days: TimeRangeDays }> = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: null },
] as const;

export function selectedRangeQueryInput(days: TimeRangeDays): { days: TimeRangeDays } {
  return { days };
}

export function minimumSelectedRangeDays(days: TimeRangeDays, minimumDays: number): TimeRangeDays {
  if (days === null) return null;
  return Math.max(days, minimumDays);
}

export function minimumSelectedRangeQueryInput(
  days: TimeRangeDays,
  minimumDays: number,
): { days: TimeRangeDays } {
  return selectedRangeQueryInput(minimumSelectedRangeDays(days, minimumDays));
}

export function fixedRangeQueryInput(days: number): { days: number } {
  return { days };
}

export function formatTimeRangeLabel(days: TimeRangeDays): string {
  return days === null ? "All" : `${days} days`;
}

export function formatTimeRangeShortLabel(days: TimeRangeDays): string {
  return days === null ? "All" : `${days}d`;
}
