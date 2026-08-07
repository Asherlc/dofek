import { CORRELATION_METRICS } from "@dofek/stats/correlation";
import { TRPCError } from "@trpc/server";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { z } from "zod";
import { dateStringSchema } from "../lib/typed-sql.ts";
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

const adherenceSchema = z.enum(["adherent", "partial", "not_adherent", "unknown"]);

const checkInInputSchema = z.object({
  id: z.guid(),
  date: dateStringSchema,
  adherence: adherenceSchema,
  confounder: z.string().trim().min(1).nullable().default(null),
  note: z.string().trim().min(1).nullable().default(null),
});

const checkInViewSchema = z.object({
  id: z.string(),
  date: dateStringSchema,
  adherence: adherenceSchema,
  confounder: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

const outcomeObservationSchema = z.object({
  phase: z.enum(["baseline", "intervention"]),
  phaseDate: dateStringSchema,
  outcomeDate: dateStringSchema,
  value: z.number().nullable(),
  adherence: adherenceSchema.nullable(),
  confounder: z.string().nullable(),
  note: z.string().nullable(),
  sourceProviderIds: z.array(z.string()),
});

const phaseCoverageSchema = z.object({
  expectedDayCount: z.number().int().nonnegative(),
  observedOutcomeDayCount: z.number().int().nonnegative(),
  missingOutcomeDayCount: z.number().int().nonnegative(),
  checkInCount: z.number().int().nonnegative(),
  adherenceCounts: z.object({
    adherent: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    not_adherent: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
});

const uncertaintySchema = z.union([
  z.object({
    availability: z.literal("available"),
    method: z.literal("circular_moving_block_bootstrap"),
    level: z.literal(0.95),
    blockLength: z.number().int().positive(),
    requestedReplicateCount: z.literal(2_000),
    attemptedReplicateCount: z.number().int().nonnegative(),
    validReplicateCount: z.number().int().nonnegative(),
    lower: z.number(),
    upper: z.number(),
  }),
  z.object({
    availability: z.literal("unavailable"),
    method: z.literal("circular_moving_block_bootstrap"),
    level: z.literal(0.95),
    blockLength: z.number().int().nonnegative(),
    requestedReplicateCount: z.literal(2_000),
    attemptedReplicateCount: z.number().int().nonnegative(),
    validReplicateCount: z.number().int().nonnegative(),
    reason: z.enum([
      "empty_input",
      "degenerate_input",
      "insufficient_valid_replicates",
      "insufficient_outcomes",
    ]),
  }),
]);

const experimentAnalysisSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("available"),
    observations: z.array(outcomeObservationSchema),
    coverage: z.object({ baseline: phaseCoverageSchema, intervention: phaseCoverageSchema }),
    effect: z.object({
      baselineMean: z.number(),
      interventionMean: z.number(),
      differenceInMeans: z.number(),
      baselineSampleCount: z.number().int().min(5),
      interventionSampleCount: z.number().int().min(5),
    }),
    uncertainty: uncertaintySchema,
    limitations: z.array(z.string()),
  }),
  z.object({
    availability: z.literal("insufficient"),
    observations: z.array(outcomeObservationSchema),
    coverage: z.object({ baseline: phaseCoverageSchema, intervention: phaseCoverageSchema }),
    effect: z.null(),
    uncertainty: uncertaintySchema,
    limitations: z.array(z.string()),
  }),
]);

const personalExperimentAnalysisViewSchema = z.object({
  outcomeMetricId: z.string(),
  outcomeMetricLabel: z.string(),
  checkIns: z.array(checkInViewSchema),
  annotations: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      startedAt: dateStringSchema,
      endedAt: dateStringSchema.nullable(),
      category: z.string().nullable(),
      ongoing: z.boolean(),
      notes: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  analysis: experimentAnalysisSchema,
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

  analysis: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ id: z.guid() }))
    .output(personalExperimentAnalysisViewSchema)
    .query(async ({ ctx, input }) => {
      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      const analysis = await repository.analyze(input.id, ctx.sensorStore);
      if (!analysis) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That experiment was not found. It may have been deleted.",
        });
      }
      return analysis;
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

  checkIn: protectedProcedure
    .input(checkInInputSchema)
    .output(checkInViewSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone);
      const checkIn = await repository.upsertCheckIn(input.id, input);
      if (!checkIn) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That experiment was not found. It may have been deleted.",
        });
      }
      await invalidateUserQueryDomains(ctx.userId, ["personalExperiments"]);
      return checkIn;
    }),
});
