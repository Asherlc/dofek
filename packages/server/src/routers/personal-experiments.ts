import { CORRELATION_METRICS } from "@dofek/stats/correlation";
import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { isKnownOutcomeMetricId } from "../personal-experiments/experiment-schedule.ts";
import { PersonalExperimentsRepository } from "../repositories/personal-experiments-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const createInputSchema = z.object({
  hypothesis: z.string().trim().min(1),
  intervention: z.string().trim().min(1),
  outcomeMetricId: z.string().min(1),
  lagDays: z.number().int().min(0).max(7).default(0),
  baselineDays: z.number().int().min(1).max(90).default(7),
  interventionDays: z.number().int().min(1).max(90).default(14),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const experimentScheduleSchema = z.object({
  phase: z.enum(["upcoming", "baseline", "intervention", "complete", "stopped"]),
  phaseLabel: z.string(),
  baselineStartDate: z.string(),
  baselineEndDate: z.string(),
  interventionStartDate: z.string(),
  interventionEndDate: z.string(),
  dayInPhase: z.number().int().nullable(),
  daysRemainingInPhase: z.number().int().nullable(),
  scheduleSummary: z.string(),
});

const personalExperimentViewSchema = z.object({
  id: z.string(),
  hypothesis: z.string(),
  intervention: z.string(),
  outcomeMetricId: z.string(),
  outcomeMetricLabel: z.string(),
  lagDays: z.number().int(),
  baselineDays: z.number().int(),
  interventionDays: z.number().int(),
  startDate: z.string(),
  status: z.enum(["active", "stopped"]),
  stoppedAt: z.string().nullable(),
  createdAt: z.string(),
  phase: z.enum(["upcoming", "baseline", "intervention", "complete", "stopped"]),
  phaseLabel: z.string(),
  schedule: experimentScheduleSchema,
});

const metricOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  domain: z.string(),
});

export const personalExperimentsRouter = router({
  metrics: cachedProtectedQuery({ maxAge: CacheTTL.LONG })
    .input(z.void())
    .output(z.array(metricOptionSchema))
    .query(() =>
      CORRELATION_METRICS.map((metric) => ({
        id: metric.id,
        label: metric.label,
        unit: metric.unit,
        domain: metric.domain,
      })),
    ),

  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.void())
    .output(z.array(personalExperimentViewSchema))
    .query(async ({ ctx }) => {
      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.list();
    }),

  get: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ id: z.guid() }))
    .output(personalExperimentViewSchema)
    .query(async ({ ctx, input }) => {
      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      const experiment = await repository.get(input.id);
      if (!experiment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That experiment was not found. It may have been deleted.",
        });
      }
      return experiment;
    }),

  create: protectedProcedure
    .input(createInputSchema)
    .output(personalExperimentViewSchema)
    .mutation(async ({ ctx, input }) => {
      if (!isKnownOutcomeMetricId(input.outcomeMetricId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Choose an outcome metric from the correlation catalog. That metric id is not supported.",
        });
      }

      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      const experiment = await repository.create(input);
      await invalidateUserQueryDomains(ctx.userId, ["personalExperiments"]);
      return experiment;
    }),

  stop: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .output(personalExperimentViewSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      const experiment = await repository.stop(input.id);
      if (!experiment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "That experiment could not be stopped. It may already be stopped or does not exist.",
        });
      }
      await invalidateUserQueryDomains(ctx.userId, ["personalExperiments"]);
      return experiment;
    }),
});
