import { z } from "zod";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { rangeDaysSchema } from "../lib/date-window.ts";
import {
  type EstimatedMaxTrendEvidence,
  type ProgressiveOverloadTrend,
  StrengthRepository,
} from "../repositories/strength-repository.ts";
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
  trend: EstimatedMaxTrendEvidence;
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
  trend: ProgressiveOverloadTrend;
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
  volumeOverTime: selectedChartRangeQuery(
    "strength.volumeOverTime",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<VolumeOverTimeRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const weeks = await repo.getVolumeOverTime(range.days);
      return weeks.map((week) => week.toDetail());
    },
  ),

  estimatedOneRepMax: selectedChartRangeQuery(
    "strength.estimatedOneRepMax",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<EstimatedOneRepMaxRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const exercises = await repo.getEstimatedOneRepMax(range.days);
      return exercises.map((exercise) => exercise.toDetail());
    },
  ),

  muscleGroupVolume: selectedChartRangeQuery(
    "strength.muscleGroupVolume",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<MuscleGroupVolumeRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const groups = await repo.getMuscleGroupVolume(range.days);
      return groups.map((group) => group.toDetail());
    },
  ),

  progressiveOverload: selectedChartRangeQuery(
    "strength.progressiveOverload",
    CacheTTL.LONG,
    async ({ ctx, range }): Promise<ProgressiveOverloadRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const overloads = await repo.getProgressiveOverload(range.days);
      return overloads.map((overload) => overload.toDetail());
    },
  ),

  workoutSummary: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.object({ days: rangeDaysSchema(90) }))
    .query(async ({ ctx, input }): Promise<WorkoutSummaryRow[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const summaries = await repo.getWorkoutSummaries(input.days);
      return summaries.map((summary) => summary.toDetail());
    }),
});
