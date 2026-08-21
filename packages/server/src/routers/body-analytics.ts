import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { bodyDecisionContextOutputSchema } from "../contracts/body-decision-context.ts";
import { epistemicStatusSchema } from "../contracts/epistemic-status-contract.ts";
import { selectedChartDateRangeQuery } from "../lib/chart-range.ts";
import { selectedDateRangeInput } from "../lib/date-window.ts";
import { BodyAnalyticsRepository } from "../repositories/body-analytics-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import {
  buildHealthStatusFromValues,
  buildWeightHealthStatus,
  HEALTH_STATUS_CACHE_KEY_VERSION,
  healthStatusMetricSchema,
} from "../services/health-status.ts";
import {
  type AuthenticatedContext,
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  router,
} from "../trpc.ts";

async function readGoalWeightKg(db: Pick<Database, "execute" | "transaction">, userId: string) {
  try {
    const settingsRepo = new SettingsRepository(db, userId);
    const goalSetting = await settingsRepo.get("goalWeight");
    const parsedGoalWeightKg = goalSetting?.value != null ? Number(goalSetting.value) : null;
    return parsedGoalWeightKg != null && Number.isFinite(parsedGoalWeightKg)
      ? parsedGoalWeightKg
      : null;
  } catch (error) {
    captureException(error);
    return null;
  }
}

export type {
  BodyFatPrediction,
  BodyRecompositionRow,
  SmoothedBodyFatRow,
  SmoothedWeightRow,
  WeightPrediction,
} from "../repositories/body-analytics-repository.ts";

const dateWindowInput = selectedDateRangeInput(90);

const smoothedWeightOutputSchema = z.object({
  date: z.string(),
  rawWeight: z.number().nullable(),
  rawWeightStatus: epistemicStatusSchema.nullable(),
  smoothedWeight: z.number(),
  smoothedWeightStatus: epistemicStatusSchema,
  weeklyChange: z.number().nullable(),
  interpolated: z.boolean(),
});

const smoothedBodyFatOutputSchema = z.object({
  date: z.string(),
  rawBodyFatPct: z.number().nullable(),
  rawBodyFatStatus: epistemicStatusSchema.nullable(),
  smoothedBodyFatPct: z.number(),
  smoothedBodyFatStatus: epistemicStatusSchema,
  weeklyChange: z.number().nullable(),
  interpolated: z.boolean(),
});

const bodyRecompositionOutputSchema = z.object({
  date: z.string(),
  weightKg: z.number(),
  bodyFatPct: z.number(),
  fatMassKg: z.number(),
  leanMassKg: z.number(),
  smoothedFatMass: z.number(),
  smoothedLeanMass: z.number(),
});

const weightPredictionOutputSchema = z.object({
  ratePerWeek: z.number().nullable(),
  rateConfidence: z.number().nullable(),
  impliedDailyCalories: z.number().nullable(),
  periodDeltas: z.object({
    days7: z.number().nullable(),
    days14: z.number().nullable(),
    days30: z.number().nullable(),
  }),
  goal: z
    .object({
      goalWeightKg: z.number(),
      remainingKg: z.number(),
      estimatedDate: z.string().nullable(),
      daysRemaining: z.number().nullable(),
    })
    .nullable(),
  projectionLine: z.array(z.object({ date: z.string(), projectedWeight: z.number() })),
});

const bodyFatPredictionOutputSchema = z.object({
  ratePerWeek: z.number().nullable(),
  rateConfidence: z.number().nullable(),
  periodDeltas: z.object({
    days7: z.number().nullable(),
    days14: z.number().nullable(),
    days30: z.number().nullable(),
  }),
  projectionLine: z.array(z.object({ date: z.string(), projectedBodyFatPct: z.number() })),
});

function createBodyAnalyticsRepository(ctx: AuthenticatedContext) {
  return new BodyAnalyticsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    ctx.accessWindow,
    ctx.sensorStore,
  );
}

// ── Router ───────────────────────────────────────────────────────────

export const bodyAnalyticsRouter = router({
  smoothedWeight: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: HEALTH_STATUS_CACHE_KEY_VERSION,
  })
    .input(dateWindowInput)
    .output(z.array(smoothedWeightOutputSchema))
    .query(({ ctx, input }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getSmoothedWeight(input.days, input.endDate);
    }),

  weightOverview: selectedChartDateRangeQuery(
    "bodyAnalytics.weightOverview",
    CacheTTL.MEDIUM,
    async ({ ctx, input, range }) => {
      const goalWeightKg = await readGoalWeightKg(ctx.db, ctx.userId);
      const repo = createBodyAnalyticsRepository(ctx);
      const predictionDays = range.days == null ? null : Math.max(range.days, 90);
      const [
        smoothedWeightResult,
        predictionResult,
        recompositionResult,
        bodyFatTrendResult,
        bodyFatPredictionResult,
        decisionContextResult,
      ] = await Promise.allSettled([
        repo.getSmoothedWeight(range.days, input.endDate),
        repo.getWeightPrediction(predictionDays, input.endDate, goalWeightKg),
        repo.getRecomposition(range.days, input.endDate),
        repo.getSmoothedBodyFat(range.days, input.endDate),
        repo.getBodyFatPrediction(predictionDays, input.endDate),
        repo.getBodyDecisionContext(input.endDate),
      ]);

      if (smoothedWeightResult.status === "rejected") {
        throw smoothedWeightResult.reason;
      }

      if (predictionResult.status === "rejected") {
        captureException(predictionResult.reason);
      }
      if (recompositionResult.status === "rejected") {
        captureException(recompositionResult.reason);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Body composition data is temporarily unavailable. Please try again.",
          cause: recompositionResult.reason,
        });
      }
      if (bodyFatTrendResult.status === "rejected") {
        captureException(bodyFatTrendResult.reason);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Body composition data is temporarily unavailable. Please try again.",
          cause: bodyFatTrendResult.reason,
        });
      }
      if (bodyFatPredictionResult.status === "rejected") {
        captureException(bodyFatPredictionResult.reason);
      }
      if (decisionContextResult.status === "rejected") {
        captureException(decisionContextResult.reason, {
          tags: { procedure: "bodyAnalytics.weightOverview" },
          extra: { endDate: input.endDate, userId: ctx.userId },
        });
      }

      const smoothedWeight = smoothedWeightResult.value;
      const recomposition = recompositionResult.value;
      return {
        smoothedWeight,
        prediction: predictionResult.status === "fulfilled" ? predictionResult.value : null,
        bodyFatTrend: bodyFatTrendResult.value,
        bodyFatPrediction:
          bodyFatPredictionResult.status === "fulfilled" ? bodyFatPredictionResult.value : null,
        decisionContext:
          decisionContextResult.status === "fulfilled" ? decisionContextResult.value : null,
        recomposition,
        healthStatus: [
          buildWeightHealthStatus(
            smoothedWeight.map((row) => row.smoothedWeight),
            goalWeightKg,
          ),
          buildHealthStatusFromValues({
            metric: "body_fat_percentage",
            label: "Body Fat %",
            values: recomposition.flatMap((row) =>
              row.bodyFatPct == null ? [] : [row.bodyFatPct],
            ),
            intent: "neutral",
            processingStatus: null,
          }),
        ],
      };
    },
    {
      keyVersion: HEALTH_STATUS_CACHE_KEY_VERSION,
      outputSchema: z.object({
        smoothedWeight: z.array(smoothedWeightOutputSchema),
        prediction: weightPredictionOutputSchema.nullable(),
        bodyFatTrend: z.array(smoothedBodyFatOutputSchema),
        bodyFatPrediction: bodyFatPredictionOutputSchema.nullable(),
        decisionContext: bodyDecisionContextOutputSchema.nullable(),
        recomposition: z.array(bodyRecompositionOutputSchema),
        healthStatus: z.array(healthStatusMetricSchema),
      }),
    },
  ),

  recomposition: selectedChartDateRangeQuery(
    "bodyAnalytics.recomposition",
    CacheTTL.MEDIUM,
    ({ ctx, input, range }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getRecomposition(range.days, input.endDate);
    },
  ),

  weightTrend: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({}).default({}))
    .query(({ ctx }) => {
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getWeightTrend();
    }),

  weightPrediction: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      const goalWeightKg = await readGoalWeightKg(ctx.db, ctx.userId);
      const repo = createBodyAnalyticsRepository(ctx);
      return repo.getWeightPrediction(input.days, input.endDate, goalWeightKg);
    }),

  setGoalWeight: protectedProcedure
    .input(z.object({ weightKg: z.number().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new SettingsRepository(ctx.db, ctx.userId);
      await repo.set("goalWeight", input.weightKg);
      await queryCache.invalidateByPrefix(`${ctx.userId}:bodyAnalytics.`);
      await queryCache.invalidateByPrefix(`${ctx.userId}:settings.`);
      return { goalWeightKg: input.weightKg };
    }),
});
