import { strengthExerciseIdentityKey } from "@dofek/training/training";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  ExerciseOrderEvidence,
  ExerciseOrderSession,
  ExerciseOrderSetRow,
  ExerciseOrderWeightUnit,
} from "../contracts/strength-exercise-history.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

const rawDbRowSchema = z.object({
  canonical_activity_id: z.string(),
  workout_date: dateStringSchema,
  started_at: z.union([z.string(), z.date()]),
  member_external_id: z.string(),
  exercise_name: z.string(),
  equipment: z.string().nullable(),
  exercise_index: z.coerce.number(),
  set_index: z.coerce.number(),
  reps: z.coerce.number().nullable(),
  raw: z.unknown(),
});

type RawDbRow = z.infer<typeof rawDbRowSchema>;

const rawRecordSchema = z.record(z.string(), z.unknown());

function rawRecordOf(value: unknown): Record<string, unknown> | null {
  const parsed = rawRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseExactPositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) return null;
  const num = Number(str);
  return Number.isSafeInteger(num) ? num : null;
}

function parseExactFiniteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = String(value).trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(str)) return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

interface LoadedExerciseOccurrence {
  activityOrder: number;
  exerciseName: string;
  equipment: string | null;
  identityKey: string;
  unit: ExerciseOrderWeightUnit;
  sets: ExerciseOrderSetRow[];
}

interface WorkoutProjection {
  loaded: LoadedExerciseOccurrence[];
  occurrenceCountByIdentity: Map<string, number>;
}

interface ObservationSession {
  canonicalActivityId: string;
  workoutDate: string;
  startedAtMs: number;
  position: number;
  unit: ExerciseOrderWeightUnit;
  sets: ExerciseOrderSetRow[];
  isBaseline: boolean;
}

export interface ExerciseOrderResult {
  exerciseName: string;
  equipment: string | null;
  evidence: ExerciseOrderEvidence;
}

/** Returns loaded completed sets for one recorded occurrence, or null when its load is unknown or mixed. */
function loadedSetsOf(
  rows: RawDbRow[],
): { unit: ExerciseOrderWeightUnit; sets: ExerciseOrderSetRow[] } | null {
  let unit: ExerciseOrderWeightUnit | null = null;
  const sets: ExerciseOrderSetRow[] = [];
  for (const row of rows) {
    const raw = rawRecordOf(row.raw);
    if (!raw) continue;
    if (String(raw.COMPLETE ?? "").toLowerCase() !== "true") continue;
    if (row.reps === null || !Number.isInteger(row.reps) || row.reps <= 0) continue;
    const resistance = parseExactFiniteNumber(raw.RESISTANCE);
    if (resistance === null) continue;
    const rowUnit = String(raw.WEIGHT_UNIT ?? "")
      .trim()
      .toUpperCase();
    if (rowUnit !== "KG" && rowUnit !== "LBS") continue;
    if (unit !== null && unit !== rowUnit) return null;
    unit = rowUnit;
    sets.push({ position: row.set_index + 1, resistance, unit: rowUnit, reps: row.reps });
  }
  if (unit === null || sets.length === 0) return null;
  return { unit, sets: sets.sort((a, b) => a.position - b.position) };
}

/**
 * Verifies one source workout against its raw Crimpd positions. Returns null when any
 * row is unverifiable or positions conflict; otherwise every recorded occurrence is
 * counted before load checks so repeats with an unqualified occurrence stay suppressed.
 */
function projectWorkout(groupRows: RawDbRow[]): WorkoutProjection | null {
  const seenPositions = new Set<string>();
  const occurrencesByExerciseIndex = new Map<
    number,
    { identityKey: string; exerciseName: string; equipment: string | null; rows: RawDbRow[] }
  >();

  for (const row of groupRows) {
    const raw = rawRecordOf(row.raw);
    if (!raw || raw.LOG_ID !== row.member_external_id) return null;
    if (parseExactPositiveInteger(raw.ACTIVITY_ORDER) !== row.exercise_index + 1) return null;
    if (parseExactPositiveInteger(raw.SET_ORDER) !== row.set_index + 1) return null;
    const positionKey = `${row.exercise_index}:${row.set_index}`;
    if (seenPositions.has(positionKey)) return null;
    seenPositions.add(positionKey);

    const identityKey = strengthExerciseIdentityKey({
      exerciseName: row.exercise_name,
      equipment: row.equipment,
    });
    const occurrence = occurrencesByExerciseIndex.get(row.exercise_index);
    if (!occurrence) {
      occurrencesByExerciseIndex.set(row.exercise_index, {
        identityKey,
        exerciseName: row.exercise_name,
        equipment: row.equipment,
        rows: [row],
      });
    } else if (occurrence.identityKey !== identityKey) {
      return null;
    } else {
      occurrence.rows.push(row);
    }
  }

  const loaded: LoadedExerciseOccurrence[] = [];
  const occurrenceCountByIdentity = new Map<string, number>();
  for (const [exerciseIndex, occurrence] of occurrencesByExerciseIndex) {
    occurrenceCountByIdentity.set(
      occurrence.identityKey,
      (occurrenceCountByIdentity.get(occurrence.identityKey) ?? 0) + 1,
    );
    const loadedSets = loadedSetsOf(occurrence.rows);
    if (loadedSets) {
      loaded.push({
        activityOrder: exerciseIndex + 1,
        exerciseName: occurrence.exerciseName,
        equipment: occurrence.equipment,
        identityKey: occurrence.identityKey,
        unit: loadedSets.unit,
        sets: loadedSets.sets,
      });
    }
  }
  return { loaded, occurrenceCountByIdentity };
}

/** Repository for source-verified strength exercise ordering insights. */
export class StrengthExerciseOrderRepository extends BaseRepository {
  async getExerciseOrders(days: RangeDays): Promise<Map<string, ExerciseOrderResult>> {
    const rows = await executeWithSchema(
      this.db,
      rawDbRowSchema,
      sql`
        WITH group_crimpd_counts AS (
          SELECT
            a.id AS group_activity_id,
            COUNT(DISTINCT member.id) AS crimpd_count
          FROM fitness.v_activity a
          JOIN fitness.activity member ON member.id = ANY(a.member_activity_ids)
          WHERE a.user_id = ${this.userId}
            AND a.canonical_type = 'strength'
            AND member.user_id = ${this.userId}
            AND member.provider_id = 'crimpd'
            AND member.deleted_at IS NULL
            AND member.provider_absent_at IS NULL
            ${ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`)}
            ${this.timestampAccessPredicate(sql`a.started_at`)}
          GROUP BY a.id
        )
        SELECT
          a.id::text AS canonical_activity_id,
          (member.started_at AT TIME ZONE ${this.timezone})::date::text AS workout_date,
          member.started_at,
          member.external_id AS member_external_id,
          e.name AS exercise_name,
          e.equipment,
          ss.exercise_index,
          ss.set_index,
          ss.reps,
          ss.raw
        FROM fitness.v_activity a
        JOIN group_crimpd_counts gcc ON gcc.group_activity_id = a.id AND gcc.crimpd_count = 1
        JOIN fitness.activity member ON member.id = ANY(a.member_activity_ids)
        JOIN fitness.strength_set ss ON ss.activity_id = member.id
        JOIN fitness.exercise e ON e.id = ss.exercise_id
        WHERE a.user_id = ${this.userId}
          AND a.canonical_type = 'strength'
          AND member.user_id = ${this.userId}
          AND member.provider_id = 'crimpd'
          AND member.deleted_at IS NULL
          AND member.provider_absent_at IS NULL
          ${ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`)}
          ${this.timestampAccessPredicate(sql`a.started_at`)}
          ${ChartRange.fromDays(days).postgresTimestampAfterNow(sql`member.started_at`)}
          ${this.timestampAccessPredicate(sql`member.started_at`)}
        ORDER BY
          member.started_at ASC,
          a.id ASC,
          ss.exercise_index ASC,
          ss.set_index ASC
      `,
    );

    return this.#projectExerciseOrders(rows);
  }

  #projectExerciseOrders(rows: RawDbRow[]): Map<string, ExerciseOrderResult> {
    const rowsByCanonicalActivity = new Map<string, RawDbRow[]>();
    for (const row of rows) {
      const existing = rowsByCanonicalActivity.get(row.canonical_activity_id);
      if (existing) {
        existing.push(row);
      } else {
        rowsByCanonicalActivity.set(row.canonical_activity_id, [row]);
      }
    }

    const sessionsByIdentity = new Map<
      string,
      { exerciseName: string; equipment: string | null; sessions: ObservationSession[] }
    >();

    for (const [canonicalActivityId, groupRows] of rowsByCanonicalActivity) {
      const projection = projectWorkout(groupRows);
      if (!projection) continue;
      const firstRow = groupRows[0];
      if (!firstRow) continue;
      const startedAtMs = new Date(firstRow.started_at).getTime();

      for (const occurrence of projection.loaded) {
        if (projection.occurrenceCountByIdentity.get(occurrence.identityKey) !== 1) continue;

        const session: ObservationSession = {
          canonicalActivityId,
          workoutDate: firstRow.workout_date,
          startedAtMs,
          position: occurrence.activityOrder,
          unit: occurrence.unit,
          sets: occurrence.sets,
          isBaseline: projection.loaded.some(
            (other) =>
              other.identityKey !== occurrence.identityKey &&
              other.activityOrder < occurrence.activityOrder,
          ),
        };

        const existing = sessionsByIdentity.get(occurrence.identityKey);
        if (existing) {
          existing.sessions.push(session);
        } else {
          sessionsByIdentity.set(occurrence.identityKey, {
            exerciseName: occurrence.exerciseName,
            equipment: occurrence.equipment,
            sessions: [session],
          });
        }
      }
    }

    const results = new Map<string, ExerciseOrderResult>();
    for (const [key, { exerciseName, equipment, sessions }] of sessionsByIdentity) {
      sessions.sort((a, b) => a.startedAtMs - b.startedAtMs);
      const latest = sessions.at(-1);
      if (!latest) continue;

      const toSessionDto = (s: ObservationSession): ExerciseOrderSession => ({
        activityId: s.canonicalActivityId,
        date: s.workoutDate,
        position: s.position,
        sets: s.sets,
      });

      const prior = sessions
        .filter(
          (candidate) =>
            candidate.startedAtMs < latest.startedAtMs &&
            candidate.canonicalActivityId !== latest.canonicalActivityId &&
            candidate.isBaseline &&
            candidate.unit === latest.unit &&
            latest.position < candidate.position,
        )
        .at(-1);

      if (prior) {
        results.set(key, {
          exerciseName,
          equipment,
          evidence: {
            source: "Crimpd",
            baseline: toSessionDto(prior),
            earlier: toSessionDto(latest),
          },
        });
      } else if (latest.isBaseline) {
        results.set(key, {
          exerciseName,
          equipment,
          evidence: { source: "Crimpd", baseline: toSessionDto(latest), earlier: null },
        });
      }
    }

    return results;
  }
}
