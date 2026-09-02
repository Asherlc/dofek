import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import {
  executeWithSchema,
  type SchemaExecutionDatabase,
  timestampStringSchema,
} from "../lib/typed-sql.ts";

export const fingerLoadingExerciseSchema = z.enum([
  "max_hang",
  "repeater",
  "min_edge",
  "one_arm",
  "campus",
  "no_hang",
]);
export const fingerLoadingGripPositionSchema = z.enum([
  "half_crimp",
  "full_crimp",
  "open_hand",
  "three_finger_drag",
  "two_finger_pocket",
]);
export const fingerLoadingLateralitySchema = z.enum(["both", "left", "right"]);
const fingerLoadingRowSchema = z.object({
  activity_id: z.string(),
  started_at: timestampStringSchema,
  exercise: fingerLoadingExerciseSchema,
  edge_size_mm: z.coerce.number().nullable(),
  grip_position: fingerLoadingGripPositionSchema.nullable(),
  external_load_kg: z.coerce.number(),
  bodyweight_kg: z.coerce.number(),
  laterality: fingerLoadingLateralitySchema,
  set_count: z.coerce.number().int(),
  hold_duration_seconds: z.coerce.number(),
  rest_interval_seconds: z.coerce.number().int(),
  rpe: z.coerce.number().nullable(),
  notes: z.string().nullable(),
});

export interface FingerLoadingDetail {
  activityId: string;
  bodyweightKg: number;
  edgeSizeMm: number | null;
  effectiveLoadKg: number;
  exercise: z.infer<typeof fingerLoadingExerciseSchema>;
  externalLoadKg: number;
  gripPosition: z.infer<typeof fingerLoadingGripPositionSchema> | null;
  holdDurationSeconds: number;
  laterality: z.infer<typeof fingerLoadingLateralitySchema>;
  notes: string | null;
  restIntervalSeconds: number;
  rpe: number | null;
  setCount: number;
  startedAt: string;
}

function toFingerLoadingDetail(row: z.infer<typeof fingerLoadingRowSchema>): FingerLoadingDetail {
  return {
    activityId: row.activity_id,
    bodyweightKg: row.bodyweight_kg,
    edgeSizeMm: row.edge_size_mm,
    effectiveLoadKg: row.bodyweight_kg + row.external_load_kg,
    exercise: row.exercise,
    externalLoadKg: row.external_load_kg,
    gripPosition: row.grip_position,
    holdDurationSeconds: row.hold_duration_seconds,
    laterality: row.laterality,
    notes: row.notes,
    restIntervalSeconds: row.rest_interval_seconds,
    rpe: row.rpe,
    setCount: row.set_count,
    startedAt: row.started_at,
  };
}

export async function readFingerLoadingRange(input: {
  database: SchemaExecutionDatabase;
  endDate: string;
  startDate: string;
  timezone: string;
  userId: string;
}): Promise<FingerLoadingDetail[]> {
  const rows = await executeWithSchema(
    input.database,
    fingerLoadingRowSchema,
    sql`SELECT
          a.id::text AS activity_id,
          a.started_at,
          entry.exercise,
          entry.edge_size_mm,
          entry.grip_position,
          entry.external_load_kg,
          entry.bodyweight_kg,
          entry.laterality,
          entry.set_count,
          entry.hold_duration_seconds,
          entry.rest_interval_seconds,
          entry.rpe,
          entry.notes
        FROM fitness.v_activity AS a
        JOIN fitness.finger_loading_entry AS entry
          ON entry.activity_id = ANY(a.member_activity_ids)
        WHERE a.user_id = ${input.userId}::uuid
          AND (a.started_at AT TIME ZONE ${input.timezone})::date
            BETWEEN ${input.startDate}::date AND ${input.endDate}::date
        ORDER BY a.started_at DESC, entry.created_at DESC`,
  );
  return rows.map(toFingerLoadingDetail);
}

/** Returns structured finger-loading details for one visible activity. */
export async function readFingerLoadingActivity(input: {
  activityId: string;
  database: SchemaExecutionDatabase;
  userId: string;
}): Promise<FingerLoadingDetail[]> {
  const rows = await executeWithSchema(
    input.database,
    fingerLoadingRowSchema,
    sql`SELECT
          a.id::text AS activity_id,
          a.started_at,
          entry.exercise,
          entry.edge_size_mm,
          entry.grip_position,
          entry.external_load_kg,
          entry.bodyweight_kg,
          entry.laterality,
          entry.set_count,
          entry.hold_duration_seconds,
          entry.rest_interval_seconds,
          entry.rpe,
          entry.notes
        FROM fitness.v_activity AS a
        JOIN fitness.finger_loading_entry AS entry
          ON entry.activity_id = ANY(a.member_activity_ids)
        WHERE a.id = ${input.activityId}::uuid
          AND a.user_id = ${input.userId}::uuid
        ORDER BY entry.created_at DESC`,
  );
  return rows.map(toFingerLoadingDetail);
}

type TrainingLogDatabase = Pick<Database, "execute">;

export class ClimbingTrainingLogRepository extends BaseRepository<TrainingLogDatabase> {
  constructor(
    database: TrainingLogDatabase,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
  ) {
    super(database, userId, timezone, accessWindow);
  }

  async getFingerLoadingHistory(days: number): Promise<FingerLoadingDetail[]> {
    const rows = await this.query(
      fingerLoadingRowSchema,
      sql`SELECT
            a.id::text AS activity_id,
            a.started_at,
            entry.exercise,
            entry.edge_size_mm,
            entry.grip_position,
            entry.external_load_kg,
            entry.bodyweight_kg,
            entry.laterality,
            entry.set_count,
            entry.hold_duration_seconds,
            entry.rest_interval_seconds,
            entry.rpe,
            entry.notes
          FROM fitness.v_activity AS a
          JOIN fitness.finger_loading_entry AS entry
            ON entry.activity_id = ANY(a.member_activity_ids)
          WHERE a.user_id = ${this.userId}::uuid
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY a.started_at DESC, entry.created_at DESC`,
    );
    return rows.map(toFingerLoadingDetail);
  }

  async getFingerLoadingRange(startDate: string, endDate: string): Promise<FingerLoadingDetail[]> {
    return readFingerLoadingRange({
      database: this.db,
      endDate,
      startDate,
      timezone: this.timezone,
      userId: this.userId,
    });
  }
}
