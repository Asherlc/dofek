import { z } from "zod";
import { EfficiencyRepository } from "../repositories/efficiency-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export interface AerobicEfficiencyActivity {
  date: string;
  activityType: string;
  name: string;
  avgPowerZ2: number;
  avgHrZ2: number;
  efficiencyFactor: number;
  z2Samples: number;
}

export interface AerobicEfficiencyResult {
  maxHr: number | null;
  activities: AerobicEfficiencyActivity[];
}

export interface AerobicDecouplingActivity {
  date: string;
  activityType: string;
  name: string;
  firstHalfRatio: number;
  secondHalfRatio: number;
  decouplingPct: number;
  totalSamples: number;
}

export interface PolarizationWeek {
  week: string;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
  polarizationIndex: number | null;
}

export interface PolarizationTrendResult {
  maxHr: number | null;
  weeks: PolarizationWeek[];
}

export const efficiencyRouter = router({
  /**
   * Aerobic Efficiency (Efficiency Factor) per activity.
   * EF = avg power in Z2 / avg HR in Z2, where Z2 = 60-70% HRR (Karvonen).
   * Uses nearest resting HR from daily metrics for each activity's date.
   * Only includes activities with at least 5 minutes (300 samples) of Z2 data.
   */
  aerobicEfficiency: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicEfficiencyResult> => {
      const repo = new EfficiencyRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getAerobicEfficiency(input.days);
    }),

  /**
   * Aerobic Decoupling per activity.
   * Compares power:HR ratio in first half vs second half of each activity.
   * Decoupling < 5% indicates a strong aerobic base.
   */
  aerobicDecoupling: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<AerobicDecouplingActivity[]> => {
      const repo = new EfficiencyRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getAerobicDecoupling(input.days);
    }),

  /**
   * Polarization Index trend per week using Treff 3-zone model.
   * Uses %HRmax zones (simpler and more stable than Karvonen %HRR):
   *
   *   Z1 (easy) = < 80% HRmax
   *   Z2 (threshold) = 80-90% HRmax
   *   Z3 (high intensity) = ≥ 90% HRmax
   *
   * PI = log10((f1 / (f2 * f3)) * 100) where f = fraction of total training time
   * PI > 2.0 indicates a well-polarized training distribution.
   */
  polarizationTrend: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(180) }))
    .query(async ({ ctx, input }): Promise<PolarizationTrendResult> => {
      const repo = new EfficiencyRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getPolarizationTrend(input.days);
    }),
});
