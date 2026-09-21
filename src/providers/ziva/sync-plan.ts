import { z } from "zod";
import type { SyncWindow } from "../sync-window.ts";

export const ZIVA_INITIAL_HISTORY_DAYS = 730;
export const ZIVA_DATES_PER_JOB = 14;

export interface ZivaSyncCheckpoint {
  version: 1;
  nextDate: string;
  endDate: string;
  recordsSynced: number;
}

export interface ZivaSyncChunk {
  checkpoint: ZivaSyncCheckpoint;
  dates: string[];
}

const dateSchema = z.iso.date();
const recordsSyncedSchema = z.number().int().nonnegative();
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  nextDate: dateSchema,
  endDate: dateSchema,
  recordsSynced: recordsSyncedSchema,
});

function addUtcCalendarDays(date: string, days: number): string {
  const parsedDate = new Date(`${dateSchema.parse(date)}T00:00:00.000Z`);
  parsedDate.setUTCDate(parsedDate.getUTCDate() + days);
  return parsedDate.toISOString().slice(0, 10);
}

function boundsForWindow(window: SyncWindow): { startDate: string; endDate: string } {
  const endDate = dateSchema.parse(window.until.toISOString().slice(0, 10));
  const startDate =
    window.since.getTime() === 0
      ? addUtcCalendarDays(endDate, -(ZIVA_INITIAL_HISTORY_DAYS - 1))
      : dateSchema.parse(window.since.toISOString().slice(0, 10));
  return { startDate, endDate };
}

function parseCheckpoint(rawCheckpoint: unknown): ZivaSyncCheckpoint {
  return checkpointSchema.parse(rawCheckpoint);
}

function assertPendingDateInRange(checkpoint: ZivaSyncCheckpoint): void {
  if (checkpoint.nextDate > checkpoint.endDate) {
    throw new Error("Ziva sync checkpoint next date is after its end date");
  }
}

export function planZivaSyncChunk(window: SyncWindow, rawCheckpoint: unknown): ZivaSyncChunk {
  const { startDate, endDate } = boundsForWindow(window);
  const checkpoint =
    rawCheckpoint === null
      ? { version: 1 as const, nextDate: startDate, endDate, recordsSynced: 0 }
      : parseCheckpoint(rawCheckpoint);

  if (checkpoint.endDate !== endDate) {
    throw new Error("Ziva sync checkpoint end date does not match the current window");
  }
  if (checkpoint.nextDate < startDate || checkpoint.nextDate > endDate) {
    throw new Error("Ziva sync checkpoint next date is outside the current window");
  }

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
  const parsedCheckpoint = parseCheckpoint(checkpoint);
  assertPendingDateInRange(parsedCheckpoint);
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
