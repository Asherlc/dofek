import { shiftDateYmd } from "@dofek/format/format";
import { z } from "zod";
import {
  PLANNED_WORKOUT_HORIZON_DAYS,
  type PlannedWorkoutEvent,
  replacePlannedWorkoutSnapshot,
} from "../../db/planned-workout-repository.ts";
import type { SyncRun } from "../sync-run.ts";
import type { SyncError } from "../types.ts";
import type { IntervalsIcuClient } from "./client.ts";
import { intervalsIcuLocalDateWindow } from "./local-date-window.ts";

const DATE_PATH = "/athlete/0/events";
// Large enough that a full epoch backfill stays in the tens of calls and a
// normal ~92-day import window fits in a single request.
const DEFAULT_CHUNK_DAYS = 365;

const localDate = z.iso.date();

/** Exact, inclusive athlete-local day bounds; rejects garbage and reversed windows. */
export function strictLocalEnvelope(from: string, to: string): { from: string; to: string } {
  const validFrom = localDate.parse(from);
  const validTo = localDate.parse(to);
  if (validFrom > validTo) throw new Error("Invalid calendar window: from is after to");
  return { from: validFrom, to: validTo };
}

/**
 * Split an exact window into disjoint authoritative chunks. Each chunk's bounds
 * are both the query sent to the vendor and the filter applied to its response:
 * the API accepts exact local dates but can still return overlapping records
 * (e.g. an event that starts before `from` and spans into the window), so a
 * record is only authoritative for the chunk whose start-day range contains it.
 */
export function buildCalendarQueryWindows(
  strict: { from: string; to: string },
  options: { chunkDays?: number } = {},
): Array<{ oldest: string; newest: string }> {
  const { from, to } = strictLocalEnvelope(strict.from, strict.to);
  const chunkDays = options.chunkDays ?? DEFAULT_CHUNK_DAYS;
  if (!Number.isInteger(chunkDays) || chunkDays < 1) {
    throw new Error("Calendar chunk size must be a positive integer");
  }

  const windows: Array<{ oldest: string; newest: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    const chunkTo =
      shiftDateYmd(cursor, chunkDays - 1) > to ? to : shiftDateYmd(cursor, chunkDays - 1);
    windows.push({ oldest: cursor, newest: chunkTo });
    cursor = shiftDateYmd(chunkTo, 1);
  }
  return windows;
}

/**
 * The WORKOUT event shape authored by Intervals.icu. This is the only place
 * vendor field names are interpreted; everything downstream is neutral.
 */
const calendarEventSchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1)]),
    category: z.literal("WORKOUT"),
    // The regex checks shape, not calendar validity: a date like 2026-02-30
    // must be rejected here at the vendor boundary, before window filtering
    // could treat the impossible day as an authoritative event.
    start_date_local: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?)?$/)
      .refine((value) => localDate.safeParse(value.slice(0, 10)).success, {
        message: "Invalid calendar date in start_date_local",
      }),
    name: z.string().nullish(),
    description: z.string().nullish(),
    type: z.string().nullish(),
    workout_doc: z.unknown().optional(),
    /** Coach-set flag; hidden events are private and never reach the athlete. */
    hide_from_athlete: z.boolean().optional(),
  })
  .passthrough();

type CalendarEvent = z.infer<typeof calendarEventSchema>;

export interface PlannedWorkoutFetchResult {
  window: { from: string; to: string };
  events: CalendarEvent[];
}

/**
 * Fetch the complete WORKOUT list for an exact window. A malformed response
 * from any chunk throws before any events are returned, so callers never write
 * a partial snapshot.
 */
export async function fetchPlannedWorkouts(
  client: IntervalsIcuClient,
  options: {
    strict: { from: string; to: string };
    chunkDays?: number;
    signal?: AbortSignal;
  },
): Promise<PlannedWorkoutFetchResult> {
  const window = strictLocalEnvelope(options.strict.from, options.strict.to);
  const windows = buildCalendarQueryWindows(window, options);
  const byId = new Map<string, CalendarEvent>();
  for (const chunk of windows) {
    const events = await client.get(DATE_PATH, z.array(calendarEventSchema), {
      query: { category: "WORKOUT", oldest: chunk.oldest, newest: chunk.newest },
      signal: options.signal,
    });
    for (const event of events) {
      // The vendor can return overlapping records despite exact bounds; only
      // a start day inside this chunk makes the event authoritative here.
      const day = event.start_date_local.slice(0, 10);
      if (day < chunk.oldest || day > chunk.newest) continue;
      // A coach can hide a workout from the athlete. Exclude it before the
      // snapshot is written so it can never surface in upcoming workouts or
      // exports; reconciliation then removes any previously stored row whose
      // event became hidden. https://forum.intervals.icu/t/hide-planned-workouts-from-athletes/5591
      if (event.hide_from_athlete) continue;
      const id = String(event.id);
      const prior = byId.get(id);
      if (prior && eventFingerprint(prior) !== eventFingerprint(event)) {
        throw new Error(`Conflicting planned workout events for id ${id}`);
      }
      byId.set(id, event);
    }
  }
  return { window, events: [...byId.values()] };
}

/** Stable comparison of the authored fields that define one calendar event. */
function eventFingerprint(event: CalendarEvent): string {
  return JSON.stringify([
    event.id,
    event.start_date_local,
    event.name,
    event.description,
    event.type,
    event.workout_doc,
  ]);
}

/** Convert validated vendor events into the provider-neutral storage shape. */
export function toPlannedWorkoutEvents(events: readonly CalendarEvent[]): PlannedWorkoutEvent[] {
  return events.map((event) => {
    const local = event.start_date_local;
    let clock = local.length > 10 ? local.slice(11) : "";
    // Intervals.icu encodes a date-only WORKOUT as T00:00:00. Exact midnight
    // is not an authored time, so never present it as one; the calendar day is
    // authoritative and stays unchanged.
    // https://forum.intervals.icu/t/api-access-to-intervals-icu/609/4
    if (clock === "00:00" || clock === "00:00:00") clock = "";
    return {
      externalId: String(event.id),
      startDate: local.slice(0, 10),
      startTime: clock ? (clock.length === 5 ? `${clock}:00` : clock) : null,
      title: event.name ?? null,
      description: event.description ?? null,
      sportType: event.type ?? null,
      workoutDoc: event.workout_doc ?? null,
    };
  });
}

/**
 * Exact athlete-local import window. Explicit historical backfills stay within
 * their requested range; normal syncs extend through the inclusive +90 horizon.
 */
export function plannedWorkoutLocalWindow(run: SyncRun): { from: string; to: string } {
  const local = intervalsIcuLocalDateWindow(run);
  // Explicit historical backfills stay inside their requested range; normal
  // syncs (full or relative) extend through the inclusive +90 horizon.
  const to =
    run.window.kind === "full" || run.options.relativeWindow
      ? shiftDateYmd(local.newest, PLANNED_WORKOUT_HORIZON_DAYS)
      : local.newest;
  return strictLocalEnvelope(local.oldest, to);
}

export interface IntervalsIcuPlannedWorkoutsResult {
  recordsSynced: number;
  errors: SyncError[];
}

/** Sync the WORKOUT calendar into one exact, user-scoped snapshot. */
export async function syncIntervalsIcuPlannedWorkouts(
  client: IntervalsIcuClient,
  run: SyncRun,
  providerId: string,
): Promise<IntervalsIcuPlannedWorkoutsResult> {
  if (!run.options.userId) throw new Error("Intervals.icu planned workout sync requires a user ID");
  const fetched = await fetchPlannedWorkouts(client, {
    strict: plannedWorkoutLocalWindow(run),
    chunkDays: DEFAULT_CHUNK_DAYS,
    signal: run.options.signal,
  });
  const { upserted, removed } = await replacePlannedWorkoutSnapshot(run.db, {
    userId: run.options.userId,
    providerId,
    window: fetched.window,
    events: toPlannedWorkoutEvents(fetched.events),
  });
  // A refresh whose authoritative snapshot only shrank still did work; count
  // the rows removed alongside the rows upserted.
  return { recordsSynced: upserted + removed, errors: [] };
}
