import { resolveProviderActivityType } from "@dofek/training/activity-types";
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
import { ensurePushProvider } from "./push-provider-repository.ts";

const DOFEK_PROVIDER_ID = "dofek";
const DOFEK_PROVIDER_NAME = "Dofek App";
const FINGER_LOADING_ACTIVITY_TYPE = resolveProviderActivityType("finger_loading", "strength");
const CLIMBING_ACTIVITY_TYPE = resolveProviderActivityType("rock_climbing", "climbing");

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
export const climbingHoldTypeSchema = z.enum(["crimp", "sloper", "pinch", "pocket", "jug"]);
export const climbingAttemptOutcomeSchema = z.enum(["sent", "failed"]);
export const climbingFailureReasonSchema = z.enum(["fell", "pumped", "skin", "technique", "fear"]);

export interface FingerLoadingInput {
  bodyweightKg: number;
  edgeSizeMm: number | null;
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

export interface ClimbingAttemptInput {
  failureReason: z.infer<typeof climbingFailureReasonSchema> | null;
  notes: string | null;
  outcome: z.infer<typeof climbingAttemptOutcomeSchema>;
}

export interface ClimbInput {
  attempts: ClimbingAttemptInput[];
  climbType: "boulder" | "route";
  grade: string;
  gradeSystem: "v_scale" | "yds";
  holdType: z.infer<typeof climbingHoldTypeSchema> | null;
  routeName: string | null;
  wallAngleDegrees: number | null;
}

const insertedIdSchema = z.object({ id: z.string() });
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

type TrainingLogDatabase = Pick<Database, "execute" | "transaction">;

export class ClimbingTrainingLogRepository extends BaseRepository<TrainingLogDatabase> {
  constructor(
    database: TrainingLogDatabase,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
  ) {
    super(database, userId, timezone, accessWindow);
  }

  async logFingerLoading(input: FingerLoadingInput): Promise<FingerLoadingDetail> {
    await ensurePushProvider({
      database: this.db,
      providerId: DOFEK_PROVIDER_ID,
      providerName: DOFEK_PROVIDER_NAME,
      userId: this.userId,
    });

    const activityId = await this.db.transaction(async (transaction) => {
      const activityRows = await executeWithSchema(
        transaction,
        insertedIdSchema,
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, canonical_type, provider_type, modality,
              started_at, ended_at, name, source_name
            ) VALUES (
              ${DOFEK_PROVIDER_ID},
              ${this.userId}::uuid,
              ${`manual:${crypto.randomUUID()}`},
              ${FINGER_LOADING_ACTIVITY_TYPE.canonicalType},
              ${FINGER_LOADING_ACTIVITY_TYPE.providerType},
              ${FINGER_LOADING_ACTIVITY_TYPE.modality},
              ${input.startedAt}::timestamptz,
              ${input.startedAt}::timestamptz,
              'Finger loading',
              ${DOFEK_PROVIDER_NAME}
            )
            RETURNING id`,
      );
      const activity = activityRows[0];
      if (!activity) throw new Error("Finger-loading activity insert returned no id");

      await transaction.execute(sql`INSERT INTO fitness.finger_loading_entry (
            activity_id,
            exercise,
            edge_size_mm,
            grip_position,
            external_load_kg,
            bodyweight_kg,
            laterality,
            set_count,
            hold_duration_seconds,
            rest_interval_seconds,
            rpe,
            notes
          ) VALUES (
            ${activity.id}::uuid,
            ${input.exercise}::fitness.finger_loading_exercise,
            ${input.edgeSizeMm},
            ${input.gripPosition}::fitness.finger_loading_grip_position,
            ${input.externalLoadKg},
            ${input.bodyweightKg},
            ${input.laterality}::fitness.finger_loading_laterality,
            ${input.setCount},
            ${input.holdDurationSeconds},
            ${input.restIntervalSeconds},
            ${input.rpe},
            ${input.notes}
          )`);
      return activity.id;
    });

    const created = await this.#getFingerLoadingActivity(activityId);
    if (!created) throw new Error("Saved finger-loading activity could not be read");
    return created;
  }

  async logClimbingSession(input: {
    climbs: ClimbInput[];
    endedAt: string | null;
    locationName: string | null;
    startedAt: string;
  }): Promise<{
    activityId: string;
    climbs: Array<{ attemptCount: number; id: string; sent: boolean }>;
  }> {
    await ensurePushProvider({
      database: this.db,
      providerId: DOFEK_PROVIDER_ID,
      providerName: DOFEK_PROVIDER_NAME,
      userId: this.userId,
    });

    return this.db.transaction(async (transaction) => {
      const activityRows = await executeWithSchema(
        transaction,
        insertedIdSchema,
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, canonical_type, provider_type, modality,
              started_at, ended_at, name, source_name
            ) VALUES (
              ${DOFEK_PROVIDER_ID},
              ${this.userId}::uuid,
              ${`manual:${crypto.randomUUID()}`},
              ${CLIMBING_ACTIVITY_TYPE.canonicalType},
              ${CLIMBING_ACTIVITY_TYPE.providerType},
              ${CLIMBING_ACTIVITY_TYPE.modality},
              ${input.startedAt}::timestamptz,
              ${input.endedAt}::timestamptz,
              'Climbing session',
              ${DOFEK_PROVIDER_NAME}
            )
            RETURNING id`,
      );
      const activity = activityRows[0];
      if (!activity) throw new Error("Climbing activity insert returned no id");

      const climbs: Array<{ attemptCount: number; id: string; sent: boolean }> = [];
      for (const climb of input.climbs) {
        const climbingRows = await executeWithSchema(
          transaction,
          insertedIdSchema,
          sql`INSERT INTO fitness.climbing_entry (
                activity_id,
                climb_type,
                grade_system,
                grade,
                sent,
                attempt_count,
                wall_angle_degrees,
                hold_type,
                route_name,
                location_name,
                source_name
              ) VALUES (
                ${activity.id}::uuid,
                ${climb.climbType}::fitness.climbing_climb_type,
                ${climb.gradeSystem}::fitness.climbing_grade_system,
                ${climb.grade},
                NULL,
                NULL,
                ${climb.wallAngleDegrees},
                ${climb.holdType}::fitness.climbing_hold_type,
                ${climb.routeName},
                ${input.locationName},
                ${DOFEK_PROVIDER_NAME}
              )
              RETURNING id`,
        );
        const climbingEntry = climbingRows[0];
        if (!climbingEntry) throw new Error("Climbing entry insert returned no id");

        for (const [attemptOffset, attempt] of climb.attempts.entries()) {
          await transaction.execute(sql`INSERT INTO fitness.climbing_attempt (
                climbing_entry_id, attempt_index, outcome, failure_reason, notes
              ) VALUES (
                ${climbingEntry.id}::uuid,
                ${attemptOffset + 1},
                ${attempt.outcome}::fitness.climbing_attempt_outcome,
                ${attempt.failureReason}::fitness.climbing_failure_reason,
                ${attempt.notes}
              )`);
        }
        climbs.push({
          attemptCount: climb.attempts.length,
          id: climbingEntry.id,
          sent: climb.attempts.some((attempt) => attempt.outcome === "sent"),
        });
      }
      return { activityId: activity.id, climbs };
    });
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

  async #getFingerLoadingActivity(activityId: string): Promise<FingerLoadingDetail | null> {
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
            AND ${activityId}::uuid = ANY(a.member_activity_ids)`,
    );
    return rows[0] ? toFingerLoadingDetail(rows[0]) : null;
  }
}
