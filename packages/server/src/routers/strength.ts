import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface VolumeOverTimeRow {
  week: string;
  totalVolumeKg: number;
  setCount: number;
  workoutCount: number;
}

export interface EstimatedOneRepMaxEntry {
  date: string;
  estimatedMax: number;
  actualWeight: number;
  actualReps: number;
}

export interface EstimatedOneRepMaxRow {
  exerciseName: string;
  history: EstimatedOneRepMaxEntry[];
}

export interface MuscleGroupWeek {
  week: string;
  sets: number;
}

export interface MuscleGroupVolumeRow {
  muscleGroup: string;
  weeklyData: MuscleGroupWeek[];
}

export interface ProgressiveOverloadRow {
  exerciseName: string;
  weeklyVolumes: number[];
  slopeKgPerWeek: number;
  isProgressing: boolean;
}

export interface WorkoutSummaryRow {
  date: string;
  name: string;
  exerciseCount: number;
  totalSets: number;
  totalVolumeKg: number;
  durationMinutes: number;
}

export const strengthRouter = router({
  /**
   * Weekly tonnage: SUM(weight_kg * reps) grouped by week.
   */
  volumeOverTime: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const volumeRowSchema = z.object({
        week: dateStringSchema,
        total_volume_kg: z.coerce.number(),
        set_count: z.coerce.number(),
        workout_count: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        volumeRowSchema,
        sql`SELECT
              date_trunc('week', sw.started_at)::date::text AS week,
              COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS total_volume_kg,
              COUNT(ss.id)::int AS set_count,
              COUNT(DISTINCT sw.id)::int AS workout_count
            FROM fitness.strength_workout sw
            JOIN fitness.strength_set ss ON ss.workout_id = sw.id
            WHERE sw.user_id = ${ctx.userId}
              AND sw.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            GROUP BY date_trunc('week', sw.started_at)
            ORDER BY week`,
      );
      return rows.map((r) => ({
        week: r.week,
        totalVolumeKg: r.total_volume_kg,
        setCount: r.set_count,
        workoutCount: r.workout_count,
      }));
    }),

  /**
   * Estimated 1RM using Epley formula: weight * (1 + reps/30).
   * Best e1RM per workout per exercise. Only working sets, weight > 0, reps 1-12,
   * exercises with 3+ appearances.
   */
  estimatedOneRepMax: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const oneRepMaxRowSchema = z.object({
        exercise_name: z.string(),
        workout_date: dateStringSchema,
        estimated_max: z.coerce.number(),
        actual_weight: z.coerce.number(),
        actual_reps: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        oneRepMaxRowSchema,
        sql`WITH best_per_workout AS (
              SELECT
                e.name AS exercise_name,
                sw.started_at::date::text AS workout_date,
                ss.weight_kg * (1 + ss.reps / 30.0) AS e1rm,
                ss.weight_kg AS actual_weight,
                ss.reps AS actual_reps,
                ROW_NUMBER() OVER (
                  PARTITION BY e.id, sw.id
                  ORDER BY ss.weight_kg * (1 + ss.reps / 30.0) DESC
                ) AS rn
              FROM fitness.strength_set ss
              JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
              JOIN fitness.exercise e ON e.id = ss.exercise_id
              WHERE sw.user_id = ${ctx.userId}
                AND sw.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
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

      const exerciseMap = new Map<string, EstimatedOneRepMaxEntry[]>();
      for (const r of rows) {
        const entries = exerciseMap.get(r.exercise_name) ?? [];
        entries.push({
          date: r.workout_date,
          estimatedMax: r.estimated_max,
          actualWeight: r.actual_weight,
          actualReps: r.actual_reps,
        });
        exerciseMap.set(r.exercise_name, entries);
      }

      return Array.from(exerciseMap.entries()).map(([exerciseName, history]) => ({
        exerciseName,
        history,
      }));
    }),

  /**
   * Weekly sets per muscle group.
   */
  muscleGroupVolume: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const muscleGroupRowSchema = z.object({
        muscle_group: z.string(),
        week: dateStringSchema,
        sets: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        muscleGroupRowSchema,
        sql`SELECT
              e.muscle_group,
              date_trunc('week', sw.started_at)::date::text AS week,
              COUNT(ss.id)::int AS sets
            FROM fitness.strength_set ss
            JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
            JOIN fitness.exercise e ON e.id = ss.exercise_id
            WHERE sw.user_id = ${ctx.userId}
              AND sw.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND e.muscle_group IS NOT NULL
            GROUP BY e.muscle_group, date_trunc('week', sw.started_at)
            ORDER BY e.muscle_group, week`,
      );

      const groupMap = new Map<string, MuscleGroupWeek[]>();
      for (const r of rows) {
        const weeks = groupMap.get(r.muscle_group) ?? [];
        weeks.push({ week: r.week, sets: r.sets });
        groupMap.set(r.muscle_group, weeks);
      }

      return Array.from(groupMap.entries()).map(([muscleGroup, weeklyData]) => ({
        muscleGroup,
        weeklyData,
      }));
    }),

  /**
   * Weekly volume per exercise with linear regression slope.
   */
  progressiveOverload: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const overloadRowSchema = z.object({
        exercise_name: z.string(),
        week: dateStringSchema,
        weekly_volume: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        overloadRowSchema,
        sql`SELECT
              e.name AS exercise_name,
              date_trunc('week', sw.started_at)::date::text AS week,
              COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS weekly_volume
            FROM fitness.strength_set ss
            JOIN fitness.strength_workout sw ON sw.id = ss.workout_id
            JOIN fitness.exercise e ON e.id = ss.exercise_id
            WHERE sw.user_id = ${ctx.userId}
              AND sw.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND ss.weight_kg > 0
            GROUP BY e.name, date_trunc('week', sw.started_at)
            ORDER BY e.name, week`,
      );

      const exerciseMap = new Map<string, number[]>();
      for (const r of rows) {
        const volumes = exerciseMap.get(r.exercise_name) ?? [];
        volumes.push(r.weekly_volume);
        exerciseMap.set(r.exercise_name, volumes);
      }

      return Array.from(exerciseMap.entries())
        .filter(([, volumes]) => volumes.length >= 2)
        .map(([exerciseName, weeklyVolumes]) => {
          const slope = linearRegressionSlope(weeklyVolumes);
          return {
            exerciseName,
            weeklyVolumes,
            slopeKgPerWeek: Math.round(slope * 100) / 100,
            isProgressing: slope > 0,
          };
        });
    }),

  /**
   * Recent workout summaries.
   */
  workoutSummary: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const summaryRowSchema = z.object({
        date: dateStringSchema,
        name: z.string(),
        exercise_count: z.coerce.number(),
        total_sets: z.coerce.number(),
        total_volume_kg: z.coerce.number(),
        duration_minutes: z.coerce.number(),
      });
      const rows = await executeWithSchema(
        ctx.db,
        summaryRowSchema,
        sql`SELECT
              sw.started_at::date::text AS date,
              sw.name,
              COUNT(DISTINCT ss.exercise_id)::int AS exercise_count,
              COUNT(ss.id)::int AS total_sets,
              COALESCE(SUM(ss.weight_kg * ss.reps), 0)::real AS total_volume_kg,
              ROUND(EXTRACT(EPOCH FROM (sw.ended_at - sw.started_at)) / 60)::int AS duration_minutes
            FROM fitness.strength_workout sw
            LEFT JOIN fitness.strength_set ss ON ss.workout_id = sw.id
            WHERE sw.user_id = ${ctx.userId}
              AND sw.started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
              AND sw.ended_at IS NOT NULL
            GROUP BY sw.id, sw.started_at, sw.ended_at, sw.name
            ORDER BY sw.started_at DESC`,
      );

      return rows.map((r) => ({
        date: r.date,
        name: r.name,
        exerciseCount: r.exercise_count,
        totalSets: r.total_sets,
        totalVolumeKg: r.total_volume_kg,
        durationMinutes: r.duration_minutes,
      }));
    }),
});

/**
 * Compute the slope of a simple linear regression (y = a + b*x)
 * where x is the zero-based index (i.e. week number).
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i] ?? 0;
    sumXY += i * (values[i] ?? 0);
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}
