import { z } from "zod";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ---------------------------------------------------------------------------
// API-facing type interfaces (re-exported from types.ts for backward compat)
// ---------------------------------------------------------------------------

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
  volumeOverTime: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<VolumeOverTimeRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const weeks = await repo.getVolumeOverTime(input.days);
      return weeks.map((week) => week.toDetail());
    }),

  estimatedOneRepMax: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<EstimatedOneRepMaxRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const exercises = await repo.getEstimatedOneRepMax(input.days);
      return exercises.map((exercise) => exercise.toDetail());
    }),

  muscleGroupVolume: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<MuscleGroupVolumeRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const groups = await repo.getMuscleGroupVolume(input.days);
      return groups.map((group) => group.toDetail());
    }),

  progressiveOverload: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<ProgressiveOverloadRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const overloads = await repo.getProgressiveOverload(input.days);
      return overloads.map((overload) => overload.toDetail());
    }),

  workoutSummary: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<WorkoutSummaryRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const summaries = await repo.getWorkoutSummaries(input.days);
      return summaries.map((summary) => summary.toDetail());
    }),
});
