import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../../src/db/index.ts";
import { lookupExerciseMuscleGroups } from "../../../../src/exercise-metadata.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import {
  ProgressiveOverload,
  type ProgressiveOverloadObservation,
} from "./progressive-overload.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface VolumeWeekRow {
  week: string;
  totalVolumeKg: number;
  setCount: number;
  workoutCount: number;
}

/** Weekly strength training volume summary. */
export class VolumeWeek {
  readonly #row: VolumeWeekRow;

  constructor(row: VolumeWeekRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      week: this.#row.week,
      totalVolumeKg: this.#row.totalVolumeKg,
      setCount: this.#row.setCount,
      workoutCount: this.#row.workoutCount,
    };
  }
}

export interface OneRepMaxEntryRow {
  date: string;
  estimatedMax: number;
  actualWeight: number;
  actualReps: number;
}

export type EstimatedMaxTrendDirection = "increasing" | "decreasing" | "stable";

export interface EstimatedMaxTrendEvidence {
  direction: EstimatedMaxTrendDirection;
  summary: string;
  changeMagnitudeKg: number;
  firstDate: string;
  latestDate: string;
}

/** An exercise with estimated 1RM history over time. */
export class EstimatedOneRepMax {
  readonly #exerciseName: string;
  readonly #history: OneRepMaxEntryRow[];

  constructor(exerciseName: string, history: OneRepMaxEntryRow[]) {
    this.#exerciseName = exerciseName;
    this.#history = history;
  }

  get trend(): EstimatedMaxTrendEvidence {
    const firstEntry = this.#history[0];
    const latestEntry = this.#history.at(-1);
    if (!firstEntry || !latestEntry) {
      throw new Error("Estimated max history must contain at least one observation.");
    }

    const changeKg = Math.round((latestEntry.estimatedMax - firstEntry.estimatedMax) * 10) / 10;
    if (changeKg > 0) {
      return {
        direction: "increasing",
        summary: "Estimated max increased from first to latest estimate.",
        changeMagnitudeKg: changeKg,
        firstDate: firstEntry.date,
        latestDate: latestEntry.date,
      };
    }
    if (changeKg < 0) {
      return {
        direction: "decreasing",
        summary: "Estimated max decreased from first to latest estimate.",
        changeMagnitudeKg: -changeKg,
        firstDate: firstEntry.date,
        latestDate: latestEntry.date,
      };
    }
    return {
      direction: "stable",
      summary: "Estimated max did not change from first to latest estimate.",
      changeMagnitudeKg: 0,
      firstDate: firstEntry.date,
      latestDate: latestEntry.date,
    };
  }

  toDetail() {
    return {
      exerciseName: this.#exerciseName,
      history: this.#history,
      trend: this.trend,
    };
  }
}

export interface MuscleGroupWeekRow {
  week: string;
  sets: number;
}

/** Weekly sets per muscle group. */
export class MuscleGroupVolume {
  readonly #muscleGroup: string;
  readonly #weeklyData: MuscleGroupWeekRow[];

  constructor(muscleGroup: string, weeklyData: MuscleGroupWeekRow[]) {
    this.#muscleGroup = muscleGroup;
    this.#weeklyData = weeklyData;
  }

  toDetail() {
    return {
      muscleGroup: this.#muscleGroup,
      weeklyData: this.#weeklyData,
    };
  }
}

/** A single set within a strength exercise. */
export interface SetDetail {
  setIndex: number;
  setType: string | null;
  weightKg: number | null;
  reps: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  notes: string | null;
}

/** An exercise with all its sets, for the activity detail view. */
export class ExerciseWithSets {
  readonly #exerciseIndex: number;
  readonly #exerciseName: string;
  readonly #equipment: string | null;
  readonly #muscleGroups: string[] | null;
  readonly #exerciseType: string | null;
  readonly #sets: SetDetail[];

  constructor(
    exerciseIndex: number,
    exerciseName: string,
    equipment: string | null,
    muscleGroups: string[] | null,
    exerciseType: string | null,
    sets: SetDetail[],
  ) {
    this.#exerciseIndex = exerciseIndex;
    this.#exerciseName = exerciseName;
    this.#equipment = equipment;
    this.#muscleGroups = muscleGroups;
    this.#exerciseType = exerciseType;
    this.#sets = sets;
  }

  toDetail() {
    return {
      exerciseIndex: this.#exerciseIndex,
      exerciseName: this.#exerciseName,
      equipment: this.#equipment,
      muscleGroups: this.#muscleGroups,
      exerciseType: this.#exerciseType,
      sets: this.#sets,
    };
  }
}

export interface WorkoutSummaryItemRow {
  date: string;
  name: string;
  exerciseCount: number;
  totalSets: number;
  totalVolumeKg: number;
  durationMinutes: number;
}

/** A single strength workout summary. */
export class WorkoutSummary {
  readonly #row: WorkoutSummaryItemRow;

  constructor(row: WorkoutSummaryItemRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      name: this.#row.name,
      exerciseCount: this.#row.exerciseCount,
      totalSets: this.#row.totalSets,
      totalVolumeKg: this.#row.totalVolumeKg,
      durationMinutes: this.#row.durationMinutes,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const volumeRowSchema = z.object({
  week: dateStringSchema,
  total_volume_kg: z.coerce.number(),
  set_count: z.coerce.number(),
  workout_count: z.coerce.number(),
});

const oneRepMaxRowSchema = z.object({
  exercise_name: z.string(),
  workout_date: dateStringSchema,
  estimated_max: z.coerce.number(),
  actual_weight: z.coerce.number(),
  actual_reps: z.coerce.number(),
});

const muscleGroupRowSchema = z.object({
  muscle_group: z.string(),
  week: dateStringSchema,
  sets: z.coerce.number(),
});

const overloadRowSchema = z.object({
  exercise_name: z.string(),
  week: dateStringSchema,
  weekly_volume: z.coerce.number(),
});

const exerciseSetRowSchema = z.object({
  member_activity_id: z.string(),
  member_provider_id: z.string(),
  source_priority: z.coerce.number(),
  exercise_name: z.string(),
  equipment: z.string().nullable(),
  muscle_groups: z.array(z.string()).nullable(),
  exercise_type: z.string().nullable(),
  exercise_index: z.coerce.number(),
  set_index: z.coerce.number(),
  set_type: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  reps: z.coerce.number().nullable(),
  duration_seconds: z.coerce.number().nullable(),
  rpe: z.coerce.number().nullable(),
  notes: z.string().nullable(),
});

const summaryRowSchema = z.object({
  date: dateStringSchema,
  name: z.string(),
  exercise_count: z.coerce.number(),
  total_sets: z.coerce.number(),
  total_volume_kg: z.coerce.number(),
  duration_minutes: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for strength training analytics. */
export class StrengthRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  #dedupedStrengthSets(days: RangeDays) {
    const rangeFilter = ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`);
    return sql`WITH ranked_strength_sets AS (
          SELECT
            a.id AS group_activity_id,
            a.started_at,
            e.name AS exercise_name,
            LOWER(REGEXP_REPLACE(TRIM(e.name), '[[:space:]]+', ' ', 'g')) AS normalized_exercise_name,
            e.equipment,
            LOWER(REGEXP_REPLACE(TRIM(COALESCE(e.equipment, '')), '[[:space:]]+', ' ', 'g')) AS normalized_equipment,
            e.muscle_groups,
            e.exercise_type,
            ss.set_index,
            ss.set_type,
            ss.weight_kg,
            ss.reps,
            ss.distance_meters,
            ss.duration_seconds,
            ss.rpe,
            ss.notes,
            ROW_NUMBER() OVER (
              PARTITION BY
                a.id,
                LOWER(REGEXP_REPLACE(TRIM(e.name), '[[:space:]]+', ' ', 'g')),
                LOWER(REGEXP_REPLACE(TRIM(COALESCE(e.equipment, '')), '[[:space:]]+', ' ', 'g')),
                ss.set_type,
                ss.set_index,
                ss.weight_kg,
                ss.reps,
                ss.duration_seconds
              ORDER BY
                (
                  CASE WHEN ss.rpe IS NOT NULL THEN 1 ELSE 0 END
                  + CASE WHEN NULLIF(TRIM(ss.notes), '') IS NOT NULL THEN 1 ELSE 0 END
                  + CASE WHEN ss.distance_meters IS NOT NULL THEN 1 ELSE 0 END
                  + CASE WHEN e.muscle_groups IS NOT NULL AND CARDINALITY(e.muscle_groups) > 0 THEN 1 ELSE 0 END
                  + CASE WHEN e.exercise_type IS NOT NULL THEN 1 ELSE 0 END
                ) DESC,
                COALESCE(dp.priority, pp.priority, 100) ASC,
                member.id ASC
            ) AS dedupe_rank
          FROM fitness.v_activity a
          JOIN fitness.strength_set ss ON ss.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.exercise e ON e.id = ss.exercise_id
          JOIN fitness.activity member ON member.id = ss.activity_id
          LEFT JOIN fitness.provider_priority pp ON pp.provider_id = member.provider_id
          LEFT JOIN LATERAL (
            SELECT dp2.priority
            FROM fitness.device_priority dp2
            WHERE dp2.provider_id = member.provider_id
              AND member.source_name LIKE dp2.source_name_pattern
            ORDER BY
              LENGTH(dp2.source_name_pattern) DESC,
              dp2.priority ASC,
              dp2.source_name_pattern ASC
            LIMIT 1
          ) dp ON true
          WHERE a.user_id = ${this.#userId}
            AND a.canonical_type = 'strength'
            ${rangeFilter}
        ),
        deduped_strength_sets AS (
          SELECT * FROM ranked_strength_sets WHERE dedupe_rank = 1
        )`;
  }

  /** Weekly tonnage: SUM(weight_kg * reps) grouped by week. */
  async getVolumeOverTime(days: RangeDays): Promise<VolumeWeek[]> {
    const rows = await executeWithSchema(
      this.#db,
      volumeRowSchema,
      sql`${this.#dedupedStrengthSets(days)}
          SELECT
            date_trunc('week', (started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COALESCE(SUM(weight_kg * reps) FILTER (WHERE set_type = 'working'), 0)::real AS total_volume_kg,
            COUNT(*) FILTER (WHERE set_type = 'working')::int AS set_count,
            COUNT(DISTINCT group_activity_id)::int AS workout_count
          FROM deduped_strength_sets
          GROUP BY 1
          ORDER BY week`,
    );

    return rows.map(
      (row) =>
        new VolumeWeek({
          week: row.week,
          totalVolumeKg: row.total_volume_kg,
          setCount: row.set_count,
          workoutCount: row.workout_count,
        }),
    );
  }

  /** Estimated 1RM using Epley formula, best e1RM per workout per exercise. */
  async getEstimatedOneRepMax(days: RangeDays): Promise<EstimatedOneRepMax[]> {
    const rows = await executeWithSchema(
      this.#db,
      oneRepMaxRowSchema,
      sql`${this.#dedupedStrengthSets(days)},
          best_per_workout AS (
            SELECT
              exercise_name,
              normalized_exercise_name,
              normalized_equipment,
              (started_at AT TIME ZONE ${this.#timezone})::date::text AS workout_date,
              weight_kg * (1 + reps / 30.0) AS e1rm,
              weight_kg AS actual_weight,
              reps AS actual_reps,
              ROW_NUMBER() OVER (
                PARTITION BY
                  normalized_exercise_name,
                  normalized_equipment,
                  group_activity_id
                ORDER BY weight_kg * (1 + reps / 30.0) DESC
              ) AS rn
            FROM deduped_strength_sets
            WHERE set_type = 'working'
              AND weight_kg > 0
              AND reps BETWEEN 1 AND 12
          ),
          qualified_exercises AS (
            SELECT normalized_exercise_name, normalized_equipment
            FROM best_per_workout
            WHERE rn = 1
            GROUP BY normalized_exercise_name, normalized_equipment
            HAVING COUNT(*) >= 3
          )
          SELECT
            MIN(b.exercise_name) OVER (
              PARTITION BY b.normalized_exercise_name, b.normalized_equipment
            ) AS exercise_name,
            b.workout_date,
            ROUND(b.e1rm::numeric, 1)::real AS estimated_max,
            b.actual_weight,
            b.actual_reps
          FROM best_per_workout b
          JOIN qualified_exercises q
            ON q.normalized_exercise_name = b.normalized_exercise_name
            AND q.normalized_equipment = b.normalized_equipment
          WHERE b.rn = 1
          ORDER BY b.exercise_name, b.workout_date`,
    );

    const exerciseMap = new Map<string, OneRepMaxEntryRow[]>();
    for (const row of rows) {
      const entries = exerciseMap.get(row.exercise_name) ?? [];
      entries.push({
        date: row.workout_date,
        estimatedMax: row.estimated_max,
        actualWeight: row.actual_weight,
        actualReps: row.actual_reps,
      });
      exerciseMap.set(row.exercise_name, entries);
    }

    return Array.from(exerciseMap.entries()).map(
      ([exerciseName, history]) => new EstimatedOneRepMax(exerciseName, history),
    );
  }

  /** Weekly sets per muscle group. */
  async getMuscleGroupVolume(days: RangeDays): Promise<MuscleGroupVolume[]> {
    const rows = await executeWithSchema(
      this.#db,
      muscleGroupRowSchema,
      sql`${this.#dedupedStrengthSets(days)}
          SELECT
            mg AS muscle_group,
            date_trunc('week', (started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COUNT(*) FILTER (WHERE set_type = 'working')::int AS sets
          FROM deduped_strength_sets
          CROSS JOIN LATERAL unnest(muscle_groups) AS mg
          WHERE muscle_groups IS NOT NULL
          GROUP BY mg, 2
          ORDER BY mg, week`,
    );

    const groupMap = new Map<string, MuscleGroupWeekRow[]>();
    for (const row of rows) {
      const weeks = groupMap.get(row.muscle_group) ?? [];
      weeks.push({ week: row.week, sets: row.sets });
      groupMap.set(row.muscle_group, weeks);
    }

    return Array.from(groupMap.entries()).map(
      ([muscleGroup, weeklyData]) => new MuscleGroupVolume(muscleGroup, weeklyData),
    );
  }

  /** Weekly volume per exercise with linear regression slope. */
  async getProgressiveOverload(days: RangeDays): Promise<ProgressiveOverload[]> {
    const rows = await executeWithSchema(
      this.#db,
      overloadRowSchema,
      sql`${this.#dedupedStrengthSets(days)}
          SELECT
            MIN(exercise_name) AS exercise_name,
            date_trunc('week', (started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COALESCE(SUM(weight_kg * reps), 0)::real AS weekly_volume
          FROM deduped_strength_sets
          WHERE weight_kg > 0
            AND set_type = 'working'
          GROUP BY normalized_exercise_name, normalized_equipment, 2
          ORDER BY MIN(exercise_name), week`,
    );

    const exerciseMap = new Map<string, ProgressiveOverloadObservation[]>();
    for (const row of rows) {
      const observations = exerciseMap.get(row.exercise_name) ?? [];
      observations.push({ week: row.week, totalVolumeKg: row.weekly_volume });
      exerciseMap.set(row.exercise_name, observations);
    }

    return Array.from(exerciseMap.entries())
      .filter(([, observations]) => observations.length >= 2)
      .map(([exerciseName, observations]) => new ProgressiveOverload(exerciseName, observations));
  }

  /** Exercises and source-aware deduplicated sets for one resolved activity group. */
  async getExercisesForActivity(activityId: string): Promise<ExerciseWithSets[]> {
    const rows = await executeWithSchema(
      this.#db,
      exerciseSetRowSchema,
      sql`SELECT
            ss.activity_id::text AS member_activity_id,
            member.provider_id AS member_provider_id,
            COALESCE(dp.priority, pp.priority, 100) AS source_priority,
            e.name AS exercise_name,
            e.equipment,
            e.muscle_groups,
            e.exercise_type,
            ss.exercise_index,
            ss.set_index,
            ss.set_type,
            ss.weight_kg,
            ss.reps,
            ss.duration_seconds,
            ss.rpe,
            ss.notes
          FROM fitness.v_activity a
          JOIN fitness.strength_set ss ON ss.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.exercise e ON e.id = ss.exercise_id
          JOIN fitness.activity member ON member.id = ss.activity_id
          LEFT JOIN fitness.provider_priority pp ON pp.provider_id = member.provider_id
          LEFT JOIN LATERAL (
            SELECT dp2.priority
            FROM fitness.device_priority dp2
            WHERE dp2.provider_id = member.provider_id
              AND member.source_name LIKE dp2.source_name_pattern
            ORDER BY
              LENGTH(dp2.source_name_pattern) DESC,
              dp2.priority ASC,
              dp2.source_name_pattern ASC
            LIMIT 1
          ) dp ON true
          WHERE a.id = ${activityId}
            AND a.user_id = ${this.#userId}
          ORDER BY
            LOWER(REGEXP_REPLACE(TRIM(e.name), '[[:space:]]+', ' ', 'g')),
            LOWER(REGEXP_REPLACE(TRIM(COALESCE(e.equipment, '')), '[[:space:]]+', ' ', 'g')),
            COALESCE(dp.priority, pp.priority, 100),
            ss.activity_id,
            ss.exercise_index,
            ss.set_index`,
    );

    const exerciseMap = new Map<
      string,
      {
        identity: string;
        name: string;
        equipment: string | null;
        muscleGroups: string[] | null;
        exerciseType: string | null;
        metadataCompleteness: number;
        metadataSourcePriority: number;
        metadataMemberActivityId: string;
        sets: Map<string, { detail: SetDetail; row: z.infer<typeof exerciseSetRowSchema> }>;
      }
    >();
    for (const row of rows) {
      const identity = exerciseIdentity(row.exercise_name, row.equipment);
      const resolvedMuscleGroups = resolveExerciseMuscleGroups(
        row.exercise_name,
        row.muscle_groups,
      );
      const resolvedExerciseType = resolveExerciseType(
        row.exercise_name,
        row.muscle_groups,
        row.exercise_type,
      );
      const metadataCompleteness =
        (resolvedMuscleGroups && resolvedMuscleGroups.length > 0 ? 1 : 0) +
        (resolvedExerciseType ? 1 : 0);
      let exercise = exerciseMap.get(identity);
      if (!exercise) {
        exercise = {
          identity,
          name: row.exercise_name,
          equipment: row.equipment,
          muscleGroups: resolvedMuscleGroups,
          exerciseType: resolvedExerciseType,
          metadataCompleteness,
          metadataSourcePriority: row.source_priority,
          metadataMemberActivityId: row.member_activity_id,
          sets: new Map(),
        };
        exerciseMap.set(identity, exercise);
      } else if (
        isPreferredSource(
          metadataCompleteness,
          row.source_priority,
          row.member_activity_id,
          exercise.metadataCompleteness,
          exercise.metadataSourcePriority,
          exercise.metadataMemberActivityId,
        )
      ) {
        exercise.name = row.exercise_name;
        exercise.equipment = row.equipment;
        exercise.muscleGroups = resolvedMuscleGroups;
        exercise.exerciseType = resolvedExerciseType;
        exercise.metadataCompleteness = metadataCompleteness;
        exercise.metadataSourcePriority = row.source_priority;
        exercise.metadataMemberActivityId = row.member_activity_id;
      }
      const detail = {
        setIndex: row.set_index,
        setType: row.set_type,
        weightKg: row.weight_kg,
        reps: row.reps,
        durationSeconds: row.duration_seconds,
        rpe: row.rpe,
        notes: row.notes,
      };
      const signature = setSignature(detail);
      const current = exercise.sets.get(signature);
      if (!current || isPreferredSet(row, current.row)) {
        exercise.sets.set(signature, { detail, row });
      }
    }

    return Array.from(exerciseMap.values())
      .sort((left, right) => compareStrings(left.identity, right.identity))
      .map(
        (exercise, exerciseIndex) =>
          new ExerciseWithSets(
            exerciseIndex,
            exercise.name,
            exercise.equipment,
            exercise.muscleGroups,
            exercise.exerciseType,
            Array.from(exercise.sets.values())
              .map(({ detail }) => detail)
              .sort(compareSets),
          ),
      );
  }

  /** Recent workout summaries. */
  async getWorkoutSummaries(days: RangeDays): Promise<WorkoutSummary[]> {
    const rangeFilter = ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`);
    const rows = await executeWithSchema(
      this.#db,
      summaryRowSchema,
      sql`${this.#dedupedStrengthSets(days)}
          SELECT
            (a.started_at AT TIME ZONE ${this.#timezone})::date::text AS date,
            a.name,
            COUNT(DISTINCT (ss.normalized_exercise_name, ss.normalized_equipment))
              FILTER (WHERE ss.set_type = 'working')::int AS exercise_count,
            COUNT(*) FILTER (WHERE ss.set_type = 'working')::int AS total_sets,
            COALESCE(SUM(ss.weight_kg * ss.reps) FILTER (WHERE ss.set_type = 'working'), 0)::real AS total_volume_kg,
            ROUND(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60)::int AS duration_minutes
          FROM fitness.v_activity a
          LEFT JOIN deduped_strength_sets ss ON ss.group_activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.canonical_type = 'strength'
            ${rangeFilter}
            AND a.ended_at IS NOT NULL
          GROUP BY a.id, a.started_at, a.ended_at, a.name
          ORDER BY a.started_at DESC`,
    );

    return rows.map(
      (row) =>
        new WorkoutSummary({
          date: row.date,
          name: row.name,
          exerciseCount: row.exercise_count,
          totalSets: row.total_sets,
          totalVolumeKg: row.total_volume_kg,
          durationMinutes: row.duration_minutes,
        }),
    );
  }
}

type ExerciseSetRow = z.infer<typeof exerciseSetRowSchema>;

function normalizedIdentityPart(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function exerciseIdentity(exerciseName: string, equipment: string | null): string {
  return JSON.stringify([normalizedIdentityPart(exerciseName), normalizedIdentityPart(equipment)]);
}

function setSignature(set: SetDetail): string {
  return JSON.stringify([set.setType, set.setIndex, set.weightKg, set.reps, set.durationSeconds]);
}

function setCompleteness(row: ExerciseSetRow): number {
  return (row.rpe !== null ? 1 : 0) + (row.notes?.trim() ? 1 : 0);
}

function isPreferredSet(candidate: ExerciseSetRow, current: ExerciseSetRow): boolean {
  return isPreferredSource(
    setCompleteness(candidate),
    candidate.source_priority,
    candidate.member_activity_id,
    setCompleteness(current),
    current.source_priority,
    current.member_activity_id,
  );
}

function isPreferredSource(
  candidateCompleteness: number,
  candidatePriority: number,
  candidateMemberActivityId: string,
  currentCompleteness: number,
  currentPriority: number,
  currentMemberActivityId: string,
): boolean {
  if (candidateCompleteness !== currentCompleteness) {
    return candidateCompleteness > currentCompleteness;
  }
  if (candidatePriority !== currentPriority) return candidatePriority < currentPriority;
  return compareStrings(candidateMemberActivityId, currentMemberActivityId) < 0;
}

function compareSets(left: SetDetail, right: SetDetail): number {
  return (
    left.setIndex - right.setIndex ||
    compareStrings(left.setType ?? "", right.setType ?? "") ||
    (left.weightKg ?? Number.NEGATIVE_INFINITY) - (right.weightKg ?? Number.NEGATIVE_INFINITY) ||
    (left.reps ?? Number.NEGATIVE_INFINITY) - (right.reps ?? Number.NEGATIVE_INFINITY) ||
    (left.durationSeconds ?? Number.NEGATIVE_INFINITY) -
      (right.durationSeconds ?? Number.NEGATIVE_INFINITY)
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resolveExerciseMuscleGroups(
  exerciseName: string,
  storedMuscleGroups: string[] | null,
): string[] | null {
  if (storedMuscleGroups && storedMuscleGroups.length > 0 && !isBroadBackOnly(storedMuscleGroups)) {
    return storedMuscleGroups;
  }

  return lookupExerciseMuscleGroups(exerciseName) ?? storedMuscleGroups;
}

function resolveExerciseType(
  exerciseName: string,
  storedMuscleGroups: string[] | null,
  storedExerciseType: string | null,
): string | null {
  if (storedExerciseType) return storedExerciseType;
  const resolvedMuscleGroups = resolveExerciseMuscleGroups(exerciseName, storedMuscleGroups);
  return resolvedMuscleGroups && resolvedMuscleGroups.length > 0 ? "STRENGTH" : null;
}

function isBroadBackOnly(muscleGroups: string[]): boolean {
  return muscleGroups.length === 1 && muscleGroups[0] === "BACK";
}
