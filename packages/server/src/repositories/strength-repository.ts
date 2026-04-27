import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

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

/** An exercise with estimated 1RM history over time. */
export class EstimatedOneRepMax {
  readonly #exerciseName: string;
  readonly #history: OneRepMaxEntryRow[];

  constructor(exerciseName: string, history: OneRepMaxEntryRow[]) {
    this.#exerciseName = exerciseName;
    this.#history = history;
  }

  toDetail() {
    return {
      exerciseName: this.#exerciseName,
      history: this.#history,
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

/** Progressive overload trend for a single exercise. */
export class ProgressiveOverload {
  readonly #exerciseName: string;
  readonly #weeklyVolumes: number[];

  constructor(exerciseName: string, weeklyVolumes: number[]) {
    this.#exerciseName = exerciseName;
    this.#weeklyVolumes = weeklyVolumes;
  }

  get slopeKgPerWeek(): number {
    return Math.round(linearRegressionSlope(this.#weeklyVolumes) * 100) / 100;
  }

  get isProgressing(): boolean {
    return linearRegressionSlope(this.#weeklyVolumes) > 0;
  }

  toDetail() {
    return {
      exerciseName: this.#exerciseName,
      weeklyVolumes: this.#weeklyVolumes,
      slopeKgPerWeek: this.slopeKgPerWeek,
      isProgressing: this.isProgressing,
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

  /** Weekly tonnage: SUM(weight_kg * reps) grouped by week. */
  async getVolumeOverTime(days: number): Promise<VolumeWeek[]> {
    const rows = await executeWithSchema(
      this.#db,
      volumeRowSchema,
      sql`SELECT
            date_trunc('week', (a.started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS total_volume_kg,
            COUNT(ss.id)::int AS set_count,
            COUNT(DISTINCT a.id)::int AS workout_count
          FROM fitness.activity a
          JOIN fitness.strength_set ss ON ss.activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.activity_type = 'strength'
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
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
  async getEstimatedOneRepMax(days: number): Promise<EstimatedOneRepMax[]> {
    const rows = await executeWithSchema(
      this.#db,
      oneRepMaxRowSchema,
      sql`WITH best_per_workout AS (
            SELECT
              e.name AS exercise_name,
              (a.started_at AT TIME ZONE ${this.#timezone})::date::text AS workout_date,
              ss.weight_kg * (1 + ss.reps / 30.0) AS e1rm,
              ss.weight_kg AS actual_weight,
              ss.reps AS actual_reps,
              ROW_NUMBER() OVER (
                PARTITION BY e.id, a.id
                ORDER BY ss.weight_kg * (1 + ss.reps / 30.0) DESC
              ) AS rn
            FROM fitness.strength_set ss
            JOIN fitness.activity a ON a.id = ss.activity_id
            JOIN fitness.exercise e ON e.id = ss.exercise_id
            WHERE a.user_id = ${this.#userId}
              AND a.activity_type = 'strength'
              AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
              AND ss.set_type = 'working'
              AND ss.weight_kg > 0
              AND ss.reps BETWEEN 1 AND 12
          ),
          qualified_exercises AS (
            SELECT exercise_name
            FROM best_per_workout
            WHERE rn = 1
            GROUP BY exercise_name
            HAVING COUNT(*) >= 3
          )
          SELECT
            b.exercise_name,
            b.workout_date,
            ROUND(b.e1rm::numeric, 1)::real AS estimated_max,
            b.actual_weight,
            b.actual_reps
          FROM best_per_workout b
          JOIN qualified_exercises q ON q.exercise_name = b.exercise_name
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
  async getMuscleGroupVolume(days: number): Promise<MuscleGroupVolume[]> {
    const rows = await executeWithSchema(
      this.#db,
      muscleGroupRowSchema,
      sql`SELECT
            mg AS muscle_group,
            date_trunc('week', (a.started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COUNT(ss.id)::int AS sets
          FROM fitness.strength_set ss
          JOIN fitness.activity a ON a.id = ss.activity_id
          JOIN fitness.exercise e ON e.id = ss.exercise_id
          CROSS JOIN LATERAL unnest(e.muscle_groups) AS mg
          WHERE a.user_id = ${this.#userId}
            AND a.activity_type = 'strength'
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND e.muscle_groups IS NOT NULL
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
  async getProgressiveOverload(days: number): Promise<ProgressiveOverload[]> {
    const rows = await executeWithSchema(
      this.#db,
      overloadRowSchema,
      sql`SELECT
            e.name AS exercise_name,
            date_trunc('week', (a.started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS weekly_volume
          FROM fitness.strength_set ss
          JOIN fitness.activity a ON a.id = ss.activity_id
          JOIN fitness.exercise e ON e.id = ss.exercise_id
          WHERE a.user_id = ${this.#userId}
            AND a.activity_type = 'strength'
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ss.weight_kg > 0
          GROUP BY e.name, 2
          ORDER BY e.name, week`,
    );

    const exerciseMap = new Map<string, number[]>();
    for (const row of rows) {
      const volumes = exerciseMap.get(row.exercise_name) ?? [];
      volumes.push(row.weekly_volume);
      exerciseMap.set(row.exercise_name, volumes);
    }

    return Array.from(exerciseMap.entries())
      .filter(([, volumes]) => volumes.length >= 2)
      .map(([exerciseName, weeklyVolumes]) => new ProgressiveOverload(exerciseName, weeklyVolumes));
  }

  /** Exercises and sets for a single activity (joins via source_external_ids). */
  async getExercisesForActivity(activityId: string): Promise<ExerciseWithSets[]> {
    const rows = await executeWithSchema(
      this.#db,
      exerciseSetRowSchema,
      sql`SELECT
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
          WHERE a.id = ${activityId}
            AND a.user_id = ${this.#userId}
          ORDER BY ss.exercise_index, ss.set_index`,
    );

    const exerciseMap = new Map<
      number,
      {
        name: string;
        equipment: string | null;
        muscleGroups: string[] | null;
        exerciseType: string | null;
        sets: SetDetail[];
      }
    >();
    for (const row of rows) {
      let exercise = exerciseMap.get(row.exercise_index);
      if (!exercise) {
        exercise = {
          name: row.exercise_name,
          equipment: row.equipment,
          muscleGroups: row.muscle_groups,
          exerciseType: row.exercise_type,
          sets: [],
        };
        exerciseMap.set(row.exercise_index, exercise);
      }
      exercise.sets.push({
        setIndex: row.set_index,
        setType: row.set_type,
        weightKg: row.weight_kg,
        reps: row.reps,
        durationSeconds: row.duration_seconds,
        rpe: row.rpe,
        notes: row.notes,
      });
    }

    return Array.from(exerciseMap.entries()).map(
      ([exerciseIndex, exercise]) =>
        new ExerciseWithSets(
          exerciseIndex,
          exercise.name,
          exercise.equipment,
          exercise.muscleGroups,
          exercise.exerciseType,
          exercise.sets,
        ),
    );
  }

  /** Recent workout summaries. */
  async getWorkoutSummaries(days: number): Promise<WorkoutSummary[]> {
    const rows = await executeWithSchema(
      this.#db,
      summaryRowSchema,
      sql`SELECT
            (a.started_at AT TIME ZONE ${this.#timezone})::date::text AS date,
            a.name,
            COUNT(DISTINCT ss.exercise_id)::int AS exercise_count,
            COUNT(ss.id)::int AS total_sets,
            COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS total_volume_kg,
            ROUND(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60)::int AS duration_minutes
          FROM fitness.activity a
          LEFT JOIN fitness.strength_set ss ON ss.activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.activity_type = 'strength'
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the slope of a simple linear regression (y = a + b*x)
 * where x is the zero-based index (i.e. week number).
 */
export function linearRegressionSlope(values: number[]): number {
  const valueCount = values.length;
  if (valueCount < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let index = 0; index < valueCount; index++) {
    sumX += index;
    sumY += values[index] ?? 0;
    sumXY += index * (values[index] ?? 0);
    sumX2 += index * index;
  }

  const denominator = valueCount * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (valueCount * sumXY - sumX * sumY) / denominator;
}
