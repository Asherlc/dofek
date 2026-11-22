import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./index.ts";
import { plannedWorkout } from "./schema/planned-workout.ts";
import { executeWithSchema } from "./typed-sql.ts";

/**
 * Inclusive forward horizon for planned workouts. The import window and the
 * upcoming read window both end this many athlete-local days after today.
 */
export const PLANNED_WORKOUT_HORIZON_DAYS = 90;

const BATCH_SIZE = 500;

/** Provider-neutral event produced by a provider adapter, never a raw vendor record. */
export const plannedWorkoutEventSchema = z.object({
  externalId: z.string().min(1),
  /** Source-local calendar day. */
  startDate: z.iso.date(),
  /** Source-local time of day as HH:MM:SS, or null when none was authored. */
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)
    .nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  sportType: z.string().nullable(),
  /** Original structured workout document, preserved exactly as authored. */
  workoutDoc: z.unknown(),
});
export type PlannedWorkoutEvent = z.infer<typeof plannedWorkoutEventSchema>;

export interface PlannedWorkoutSnapshot {
  userId: string;
  providerId: string;
  /** Inclusive source-local day bounds of the successful request. */
  window: { from: string; to: string };
  /** Provider-neutral snapshot data, validated before any write. */
  events: unknown;
}

/**
 * Replace the planned workouts in one source-local window with a validated snapshot.
 * The whole neutral list is validated and the write is a single transaction, so a
 * malformed record or a failed statement preserves the previous snapshot.
 */
export async function replacePlannedWorkoutSnapshot(
  db: Pick<Database, "transaction">,
  snapshot: PlannedWorkoutSnapshot,
): Promise<{ upserted: number; removed: number }> {
  const from = z.iso.date().parse(snapshot.window.from);
  const to = z.iso.date().parse(snapshot.window.to);
  if (from > to) throw new Error("Invalid planned workout window");
  // Re-validate defensively: a malformed record anywhere in a nominally valid
  // list must fail before the first write.
  const allEvents = z.array(plannedWorkoutEventSchema).parse(snapshot.events);
  const externalIds = new Set<string>();
  for (const event of allEvents) {
    if (externalIds.has(event.externalId)) {
      throw new Error(`Duplicate planned workout id ${event.externalId}`);
    }
    externalIds.add(event.externalId);
  }
  // A padded fetch can return workouts outside the authoritative window.
  const events = allEvents.filter((event) => event.startDate >= from && event.startDate <= to);
  const ids = events.map((event) => event.externalId);

  return db.transaction(async (tx) => {
    // Upsert the authoritative list first, in bounded batches. The conflict
    // target is the stable identity, so an existing or rescheduled row keeps
    // its identity and `created_at`; only authored fields and `updated_at` move.
    for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
      await tx
        .insert(plannedWorkout)
        .values(
          events.slice(offset, offset + BATCH_SIZE).map((event) => ({
            userId: snapshot.userId,
            providerId: snapshot.providerId,
            externalId: event.externalId,
            startDate: event.startDate,
            startTime: event.startTime,
            title: event.title,
            description: event.description,
            sportType: event.sportType,
            workoutDoc: event.workoutDoc ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [plannedWorkout.userId, plannedWorkout.providerId, plannedWorkout.externalId],
          set: {
            startDate: sqlExcluded("start_date"),
            startTime: sqlExcluded("start_time"),
            title: sqlExcluded("title"),
            description: sqlExcluded("description"),
            sportType: sqlExcluded("sport_type"),
            workoutDoc: sqlExcluded("workout_doc"),
            updatedAt: sql`now()`,
          },
        });
    }

    // Delete only the rows in the valid window whose identity is absent from
    // this authoritative snapshot. `<> ALL(:ids::text[])` is stock array
    // binding and accepts an empty list (deleting the whole window) without a
    // separate branch. The returned count is the number of rows actually
    // removed, not the size of the incoming list.
    const removed = await executeWithSchema(
      tx,
      z.object({ external_id: z.string() }),
      sql`
        DELETE FROM fitness.planned_workout
        WHERE user_id = ${snapshot.userId}::uuid
          AND provider_id = ${snapshot.providerId}
          AND start_date BETWEEN ${from}::date AND ${to}::date
          AND external_id <> ALL(${sql.param(ids)}::text[])
        RETURNING external_id
      `,
    );
    return { upserted: events.length, removed: removed.length };
  });
}

function sqlExcluded(column: string) {
  // Kept local so each conflict target column updates from the inserted row.
  return sql`excluded.${sql.identifier(column)}`;
}
