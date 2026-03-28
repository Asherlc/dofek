import type { ReadinessComponents } from "@dofek/recovery/readiness";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { computeWorkloadResult, RecoveryRepository } from "../repositories/recovery-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { ReadinessComponents };

export interface HrvVariabilityRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

export interface WorkloadRatioRow {
  date: string;
  dailyLoad: number;
  strain: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export interface WorkloadRatioResult {
  timeSeries: WorkloadRatioRow[];
  displayedStrain: number;
  displayedDate: string | null;
}

export interface SleepNightlyRow {
  date: string;
  /** Time in bed (includes awake time). Use for stage-percentage math. */
  durationMinutes: number;
  /** Actual time asleep (deep + REM + light). Use for display and sleep debt. */
  sleepMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
  rollingAvgDuration: number | null;
}

export interface SleepAnalyticsResult {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
}

export interface SleepConsistencyRow {
  date: string;
  bedtimeHour: number;
  waketimeHour: number;
  rollingBedtimeStddev: number | null;
  rollingWaketimeStddev: number | null;
  consistencyScore: number | null;
}

export interface ReadinessRow {
  date: string;
  readinessScore: number;
  components: ReadinessComponents;
}

export interface StrainTargetResult {
  targetStrain: number;
  currentStrain: number;
  progressPercent: number;
  zone: "Push" | "Maintain" | "Recovery";
  explanation: string;
}

export const recoveryRouter = router({
  sleepConsistency: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SleepConsistencyRow[]> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getSleepConsistency(input.days);
      return days.map((day) => day.toDetail());
    }),

  hrvVariability: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<HrvVariabilityRow[]> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getHrvVariability(input.days);
      return days.map((day) => day.toDetail());
    }),

  workloadRatio: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<WorkloadRatioResult> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      const days = await repo.getWorkloadRatio(input.days, input.endDate);
      return computeWorkloadResult(days);
    }),

  sleepAnalytics: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }): Promise<SleepAnalyticsResult> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getSleepAnalytics(input.days);
    }),

  readinessScore: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<ReadinessRow[]> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getReadinessScores(input.days, input.endDate);
    }),

  strainTarget: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(30), endDate: endDateSchema }))
    .query(async ({ ctx, input }): Promise<StrainTargetResult> => {
      const repo = new RecoveryRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getStrainTarget(input.days, input.endDate);
    }),
});
