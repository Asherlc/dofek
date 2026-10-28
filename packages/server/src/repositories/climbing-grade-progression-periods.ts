import type { ClimbingProgressionEntry } from "./climbing-grade-progression.ts";

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthDate(month: number, day = 1): string {
  return new Date(Date.UTC(Math.floor(month / 12), month % 12, day)).toISOString().slice(0, 10);
}

export function buildClimbingProgressionPeriods(entries: Pick<ClimbingProgressionEntry, "date">[]) {
  if (entries.length === 0) return { firstMonth: 0, bucketMonths: 1, periods: [] };
  const months = entries.map((entry) => monthIndex(entry.date));
  const firstMonth = Math.min(...months);
  const lastMonth = Math.max(...months);
  const bucketMonths = Math.ceil((lastMonth - firstMonth + 1) / 6);
  const periods = Array.from(
    { length: Math.ceil((lastMonth - firstMonth + 1) / bucketMonths) },
    (_, index) => ({
      startDate: monthDate(firstMonth + index * bucketMonths),
      endDate: monthDate(Math.min(firstMonth + (index + 1) * bucketMonths, lastMonth + 1), 0),
    }),
  );
  return { firstMonth, bucketMonths, periods };
}

export function climbingProgressionPeriodIndex(
  date: string,
  firstMonth: number,
  bucketMonths: number,
): number {
  return Math.floor((monthIndex(date) - firstMonth) / bucketMonths);
}
