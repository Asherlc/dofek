import { z } from "zod";
import type { SyncWindow } from "../sync-window.ts";

export const ZIVA_INITIAL_HISTORY_DAYS = 730;
export const ZIVA_DATES_PER_JOB = 14;

export interface ZivaSyncCheckpoint {
  version: 1;
  sourceAccountKey: string;
  nextDate: string;
  endDate: string;
  recordsSynced: number;
}

export interface ZivaSyncChunk {
  checkpoint: ZivaSyncCheckpoint;
  dates: string[];
}

export interface ZivaSyncPlanOptions {
  /** Provider-local final diary date for scheduled or full-history windows. */
  calendarEndDate?: string;
}

const dateSchema = z.iso.date();
const sourceAccountKeySchema = z.string().min(1);
const recordsSyncedSchema = z.number().int().nonnegative();
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  sourceAccountKey: sourceAccountKeySchema,
  nextDate: dateSchema,
  endDate: dateSchema,
  recordsSynced: recordsSyncedSchema,
});

function addUtcCalendarDays(date: string, days: number): string {
  const parsedDate = new Date(`${dateSchema.parse(date)}T00:00:00.000Z`);
  parsedDate.setUTCDate(parsedDate.getUTCDate() + days);
  return parsedDate.toISOString().slice(0, 10);
}

function calendarDaySpan(startDate: string, endDate: string): number {
  const start = new Date(`${dateSchema.parse(startDate)}T00:00:00.000Z`);
  const end = new Date(`${dateSchema.parse(endDate)}T00:00:00.000Z`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function boundsForWindow(
  window: SyncWindow,
  options: ZivaSyncPlanOptions = {},
): { startDate: string; endDate: string } {
  const utcStartDate = dateSchema.parse(window.since.toISOString().slice(0, 10));
  const utcEndDate = dateSchema.parse(window.until.toISOString().slice(0, 10));
  const hasCalendarEndDate = options.calendarEndDate !== undefined;
  const endDate = hasCalendarEndDate ? dateSchema.parse(options.calendarEndDate) : utcEndDate;
  const startDate =
    window.kind === "full"
      ? addUtcCalendarDays(endDate, -(ZIVA_INITIAL_HISTORY_DAYS - 1))
      : hasCalendarEndDate
        ? addUtcCalendarDays(endDate, -calendarDaySpan(utcStartDate, utcEndDate))
        : utcStartDate;
  return { startDate, endDate };
}

function assertPendingDateInRange(checkpoint: ZivaSyncCheckpoint): void {
  if (checkpoint.nextDate > checkpoint.endDate) {
    throw new Error("Ziva sync checkpoint next date is after its end date");
  }
}

export function parseZivaSyncCheckpoint(rawCheckpoint: unknown): ZivaSyncCheckpoint {
  const checkpoint = checkpointSchema.parse(rawCheckpoint);
  assertPendingDateInRange(checkpoint);
  return checkpoint;
}

function assertCheckpointMatchesWindow(
  checkpoint: ZivaSyncCheckpoint,
  startDate: string,
  endDate: string,
): void {
  if (checkpoint.endDate !== endDate) {
    throw new Error("Ziva sync checkpoint end date does not match the current window");
  }
  if (checkpoint.nextDate < startDate || checkpoint.nextDate > endDate) {
    throw new Error("Ziva sync checkpoint next date is outside the current window");
  }
}

export function planZivaSyncChunk(
  window: SyncWindow,
  rawCheckpoint: unknown,
  sourceAccountKey: string,
  options: ZivaSyncPlanOptions = {},
): ZivaSyncChunk {
  const { startDate, endDate } = boundsForWindow(window, options);
  const parsedSourceAccountKey = sourceAccountKeySchema.parse(sourceAccountKey);
  const savedCheckpoint = rawCheckpoint === null ? null : parseZivaSyncCheckpoint(rawCheckpoint);
  const checkpoint =
    savedCheckpoint === null || savedCheckpoint.sourceAccountKey !== parsedSourceAccountKey
      ? {
          version: 1 as const,
          sourceAccountKey: parsedSourceAccountKey,
          nextDate: startDate,
          endDate,
          recordsSynced: 0,
        }
      : savedCheckpoint;

  assertCheckpointMatchesWindow(checkpoint, startDate, endDate);

  const dates: string[] = [];
  let date = checkpoint.nextDate;
  while (date <= endDate && dates.length < ZIVA_DATES_PER_JOB) {
    dates.push(date);
    date = addUtcCalendarDays(date, 1);
  }

  return { checkpoint, dates };
}

export function advanceZivaSyncCheckpoint(
  checkpoint: ZivaSyncCheckpoint,
  completedDate: string,
  cumulativeRecordsSynced: number,
): ZivaSyncCheckpoint | null {
  const parsedCheckpoint = parseZivaSyncCheckpoint(checkpoint);
  if (completedDate !== parsedCheckpoint.nextDate) {
    throw new Error("Ziva sync checkpoint can advance only after its pending date completes");
  }

  const parsedRecordsSynced = recordsSyncedSchema.parse(cumulativeRecordsSynced);
  if (parsedRecordsSynced < parsedCheckpoint.recordsSynced) {
    throw new Error("Ziva sync checkpoint record count cannot decrease");
  }
  if (completedDate === parsedCheckpoint.endDate) return null;

  return {
    ...parsedCheckpoint,
    nextDate: addUtcCalendarDays(parsedCheckpoint.nextDate, 1),
    recordsSynced: parsedRecordsSynced,
  };
}
