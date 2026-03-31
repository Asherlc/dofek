import { z } from "zod";
import {
  type CurrentPhaseResult,
  MenstrualCycleRepository,
} from "../repositories/menstrual-cycle-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export type { CurrentPhaseResult };

export const menstrualCycleRouter = router({
  /** Current cycle phase based on most recent period start */
  currentPhase: cachedProtectedQuery(CacheTTL.SHORT).query(
    async ({ ctx }): Promise<CurrentPhaseResult> => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      return repo.getCurrentPhase();
    },
  ),

  /** Log a new period start/end */
  logPeriod: protectedProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .default(null),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      return repo.logPeriod(input.startDate, input.endDate, input.notes);
    }),

  /** Period history for the past N months */
  history: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      return repo.getHistory(input.months);
    }),
});
