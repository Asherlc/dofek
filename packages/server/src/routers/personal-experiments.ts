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

export const personalExperimentsRouter = router({
  metrics: cachedProtectedQuery({ maxAge: CacheTTL.LONG }).query(() =>
    CORRELATION_METRICS.map((metric) => ({
      id: metric.id,
      label: metric.label,
      unit: metric.unit,
      domain: metric.domain,
    })),
  ),

  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repository.list();
  }),

  get: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ id: z.guid() }))
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

  create: protectedProcedure.input(createInputSchema).mutation(async ({ ctx, input }) => {
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

  stop: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
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
