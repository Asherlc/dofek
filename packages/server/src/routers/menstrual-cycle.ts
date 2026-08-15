import { z } from "zod";
import {
  type CurrentPhaseResult,
  MenstrualCycleRepository,
} from "../repositories/menstrual-cycle-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { CurrentPhaseResult };

const cycleSourceOutputSchema = z.object({
  providerId: z.string(),
  sourceName: z.string().nullable(),
  sourceBundle: z.string().nullable(),
});

const cycleStartOutputSchema = z.object({
  id: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sources: z.array(cycleSourceOutputSchema),
});

const cyclePhaseEstimateOutputSchema = z.object({
  basis: z.literal("personal-cycle-average"),
  completedCycleCount: z.number().int().nonnegative(),
  observedCycleLengthRange: z.object({
    minimumDays: z.number().int(),
    maximumDays: z.number().int(),
  }),
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
  latestCycleStart: cycleStartOutputSchema.nullable(),
  availability: z.object({
    status: z.enum([
      "no-history",
      "sparse-history",
      "irregular-history",
      "conflicting-history",
      "stale-history",
      "estimated",
    ]),
    label: z.string(),
  }),
});

export const menstrualCycleRouter = router({
  currentPhase: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .output(currentPhaseOutputSchema)
    .query(({ ctx }): Promise<CurrentPhaseResult> =>
      new MenstrualCycleRepository(ctx.db, ctx.userId, ctx.timezone).getCurrentPhase(),
    ),

  history: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ months: z.number().int().min(1).max(24).default(6) }))
    .output(z.array(cycleStartOutputSchema))
    .query(({ ctx, input }) =>
      new MenstrualCycleRepository(ctx.db, ctx.userId, ctx.timezone).getHistory(input.months),
    ),
});
