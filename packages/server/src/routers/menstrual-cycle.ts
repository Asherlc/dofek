import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import {
  type CurrentPhaseResult,
  MenstrualCycleRepository,
  type MenstrualPeriod,
  PeriodStartDateConflictError,
} from "../repositories/menstrual-cycle-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export type { CurrentPhaseResult };

const periodDateFields = {
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  notes: z.string().nullable().default(null),
};

const periodInputSchema = z
  .object(periodDateFields)
  .refine(({ startDate, endDate }) => endDate === null || endDate >= startDate, {
    message: "Period end date cannot be before start date.",
    path: ["endDate"],
  });

const periodUpdateInputSchema = z
  .object({
    id: z.string().uuid(),
    ...periodDateFields,
  })
  .refine(({ startDate, endDate }) => endDate === null || endDate >= startDate, {
    message: "Period end date cannot be before start date.",
    path: ["endDate"],
  });

const periodIdInputSchema = z.object({
  id: z.string().uuid(),
});

const cyclePhaseEstimateOutputSchema = z.object({
  basis: z.literal("personal-cycle-average"),
  completedCycleCount: z.number().int().nonnegative(),
  observedCycleLengthRange: z
    .object({
      minimumDays: z.number().int(),
      maximumDays: z.number().int(),
    })
    .nullable(),
  phaseLabel: z.string(),
  cycleDayLabel: z.string(),
  dayBasisLabel: z.string(),
  methodLabel: z.string(),
  uncertaintyLabel: z.string(),
  limitationLabel: z.string(),
});

const currentPhaseOutputSchema = z.object({
  phase: z.enum(["menstrual", "follicular", "ovulatory", "luteal"]).nullable(),
  dayOfCycle: z.number().int().nullable(),
  cycleLength: z.number().int().nullable(),
  estimate: cyclePhaseEstimateOutputSchema.nullable(),
  availability: z.object({
    status: z.enum([
      "no-history",
      "sparse-history",
      "irregular-history",
      "stale-history",
      "estimated",
    ]),
    label: z.string(),
  }),
});

const periodOutputSchema = z.object({
  id: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  durationDays: z.number().int().positive().nullable(),
  durationLabel: z.string().nullable(),
  notes: z.string().nullable(),
});

function periodNotFoundError(): TRPCError {
  return new TRPCError({
    code: "NOT_FOUND",
    message: "Period entry was not found. Refresh the history and try again.",
  });
}

export const menstrualCycleRouter = router({
  /** Current cycle phase based on most recent period start */
  currentPhase: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .output(currentPhaseOutputSchema)
    .query(async ({ ctx }): Promise<CurrentPhaseResult> => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      return repo.getCurrentPhase();
    }),

  /** Log a new period start/end */
  logPeriod: protectedProcedure
    .input(periodInputSchema)
    .output(periodOutputSchema.nullable())
    .mutation(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      const period = await repo.logPeriod(input.startDate, input.endDate, input.notes);
      if (period !== null) {
        await invalidateUserQueryDomains(ctx.userId, ["menstrualCycle"]);
      }
      return period;
    }),

  /** Correct an existing period by its stable ID. */
  updatePeriod: protectedProcedure
    .input(periodUpdateInputSchema)
    .output(periodOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      let period: MenstrualPeriod | null;
      try {
        period = await repo.updatePeriod(input.id, input.startDate, input.endDate, input.notes);
      } catch (error: unknown) {
        if (error instanceof PeriodStartDateConflictError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: error.message,
            cause: error,
          });
        }
        throw error;
      }
      if (period === null) {
        throw periodNotFoundError();
      }
      await invalidateUserQueryDomains(ctx.userId, ["menstrualCycle"]);
      return period;
    }),

  /** Delete an erroneous period by its stable ID. */
  deletePeriod: protectedProcedure
    .input(periodIdInputSchema)
    .output(z.object({ deleted: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      const deleted = await repo.deletePeriod(input.id);
      if (!deleted) {
        throw periodNotFoundError();
      }
      await invalidateUserQueryDomains(ctx.userId, ["menstrualCycle"]);
      return { deleted: true };
    }),

  /** Period history for the past N months */
  history: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .output(z.array(periodOutputSchema))
    .query(async ({ ctx, input }) => {
      const repo = new MenstrualCycleRepository(ctx.db, ctx.userId);
      return repo.getHistory(input.months);
    }),
});
