import { TRPCError } from "@trpc/server";
import { ensureProvider as ensureProviderConnection } from "dofek/db/tokens";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import { z } from "zod";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import {
  HealthKitDeletionTombstonesUnsupportedError,
  HealthKitSyncRepository,
} from "../repositories/health-kit-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import {
  aggregateSkinTempToDailyMetrics,
  aggregateSpO2ToDailyMetrics,
  processBodyMeasurements,
  processDailyMetrics,
  processHealthEvents,
  processMetricStream,
  processWorkoutRoutes,
  processWorkouts,
} from "./health-kit-sync-processors.ts";
import {
  additiveDailyMetricTypes,
  bodyMeasurementTypes,
  type Database,
  type HealthKitSample,
  healthKitSampleSchema,
  ignoredCalorieExpenditureTypes,
  metricStreamTypes,
  PROVIDER_ID,
  pointInTimeDailyMetricTypes,
  sleepSampleSchema,
  workoutRouteSchema,
  workoutSampleSchema,
} from "./health-kit-sync-schemas.ts";
import { processSleepSamples } from "./health-kit-sync-sleep.ts";

/** Ensure the apple_health provider row exists */
async function ensureProvider(db: Database, userId: string) {
  await ensureProviderConnection(db, PROVIDER_ID, "Apple Health", undefined, userId);
}

/** Route a sample to its destination category */
function categorize(
  type: string,
):
  | "bodyMeasurement"
  | "additiveDailyMetric"
  | "pointInTimeDailyMetric"
  | "metricStream"
  | "ignored"
  | "healthEvent" {
  if (ignoredCalorieExpenditureTypes.has(type)) return "ignored";
  if (type in bodyMeasurementTypes) return "bodyMeasurement";
  if (type in additiveDailyMetricTypes) return "additiveDailyMetric";
  if (type in pointInTimeDailyMetricTypes) return "pointInTimeDailyMetric";
  if (type in metricStreamTypes) return "metricStream";
  return "healthEvent";
}

// ── Router ──

export const healthKitSyncRouter = router({
  deleteQuantitySamples: protectedProcedure
    .input(
      z.object({
        deletedUUIDs: z.array(z.uuid()).max(500),
        typeIdentifier: z.string().min(1),
      }),
    )
    .output(z.object({ deleted: z.number().int().nonnegative() }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);
      const repository = new HealthKitSyncRepository(ctx.db, ctx.userId, ctx.metricStreamPublisher);
      let deleted: number;
      try {
        deleted = await repository.processDeletedQuantitySamples(
          input.typeIdentifier,
          input.deletedUUIDs,
        );
      } catch (error) {
        if (!(error instanceof HealthKitDeletionTombstonesUnsupportedError)) {
          captureException(error, {
            tags: { endpoint: "deleteQuantitySamples" },
            extra: { userId: ctx.userId },
          });
          throw error;
        }
        captureException(error, {
          tags: { endpoint: "deleteQuantitySamples" },
          extra: { userId: ctx.userId },
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "HealthKit deletion sync is unavailable because metric deletion publishing is not configured. Please try again later.",
          cause: error,
        });
      }
      if (deleted > 0) {
        await invalidateAllUserQueries(ctx.userId);
      }
      healthKitPushTotal.add(1, {
        endpoint: "deleteQuantitySamples",
        status: "success",
      });
      healthKitRecordsTotal.add(deleted, {
        endpoint: "deleteQuantitySamples",
        category: "deletedQuantitySample",
      });
      return { deleted };
    }),

  pushQuantitySamples: protectedProcedure
    .input(z.object({ samples: z.array(healthKitSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);

      const bodyMeasurements: HealthKitSample[] = [];
      const dailyMetricSamples: HealthKitSample[] = [];
      const metricStreamSamples: HealthKitSample[] = [];
      const healthEventSamples: HealthKitSample[] = [];

      for (const sample of input.samples) {
        const category = categorize(sample.type);
        switch (category) {
          case "ignored":
            break;
          case "bodyMeasurement":
            bodyMeasurements.push(sample);
            break;
          case "additiveDailyMetric":
          case "pointInTimeDailyMetric":
            dailyMetricSamples.push(sample);
            break;
          case "metricStream":
            metricStreamSamples.push(sample);
            break;
          case "healthEvent":
            healthEventSamples.push(sample);
            break;
        }
      }

      let inserted = 0;
      let bodyInserted = 0;
      const errors: string[] = [];

      try {
        bodyInserted = await processBodyMeasurements(
          ctx.db,
          ctx.userId,
          bodyMeasurements,
          ctx.metricStreamPublisher,
        );
        inserted += bodyInserted;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Body measurements: ${message}`);
      }

      try {
        inserted += await processDailyMetrics(ctx.db, ctx.userId, dailyMetricSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Daily metrics: ${message}`);
      }

      try {
        inserted += await processMetricStream(
          ctx.db,
          ctx.userId,
          metricStreamSamples,
          ctx.metricStreamPublisher,
        );
        if (metricStreamSamples.length > 0) {
          const hasSpo2 = metricStreamSamples.some(
            (s) => s.type === "HKQuantityTypeIdentifierOxygenSaturation",
          );
          if (hasSpo2) {
            await aggregateSpO2ToDailyMetrics(
              ctx.db,
              ctx.userId,
              metricStreamSamples,
              ctx.timezone,
            );
          }
          const skinTempSamples = metricStreamSamples.filter(
            (s) => s.type === "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
          );
          if (skinTempSamples.length > 0) {
            logger.info(
              `[apple_health] Received ${skinTempSamples.length} skin temperature samples, aggregating to daily_metrics`,
            );
            await aggregateSkinTempToDailyMetrics(
              ctx.db,
              ctx.userId,
              metricStreamSamples,
              ctx.timezone,
            );
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Metric stream: ${message}`);
      }

      try {
        inserted += await processHealthEvents(ctx.db, ctx.userId, healthEventSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Health events: ${message}`);
      }

      if (bodyInserted > 0 && ctx.sensorStore) {
        try {
          await ctx.sensorStore.refreshBodyMeasurements();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          captureException(error, {
            tags: { healthKitSyncStep: "refreshBodyMeasurements" },
          });
          errors.push(`Body measurements refresh: ${message}`);
        }
      }

      // Invalidate cached data so queries pick up the newly ingested data
      if (inserted > 0 && errors.length === 0) {
        await invalidateAllUserQueries(ctx.userId);
      }

      healthKitPushTotal.add(1, {
        endpoint: "pushQuantitySamples",
        status: errors.length > 0 ? "error" : "success",
      });
      healthKitRecordsTotal.add(bodyMeasurements.length, {
        endpoint: "pushQuantitySamples",
        category: "bodyMeasurement",
      });
      healthKitRecordsTotal.add(dailyMetricSamples.length, {
        endpoint: "pushQuantitySamples",
        category: "dailyMetric",
      });
      healthKitRecordsTotal.add(metricStreamSamples.length, {
        endpoint: "pushQuantitySamples",
        category: "metricStream",
      });
      healthKitRecordsTotal.add(healthEventSamples.length, {
        endpoint: "pushQuantitySamples",
        category: "healthEvent",
      });

      return { inserted, errors };
    }),

  pushWorkouts: protectedProcedure
    .input(
      z
        .object({
          workouts: z.array(workoutSampleSchema),
          windowStart: timestampStringSchema,
          windowEnd: timestampStringSchema,
        })
        .refine(
          ({ windowStart, windowEnd }) =>
            new Date(windowStart).getTime() < new Date(windowEnd).getTime(),
          {
            message: "windowEnd must be after windowStart",
            path: ["windowEnd"],
          },
        ),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);
      const inserted = await processWorkouts(ctx.db, ctx.userId, input.workouts, {
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      });

      if (inserted > 0) {
        await invalidateAllUserQueries(ctx.userId);
      }

      healthKitPushTotal.add(1, { endpoint: "pushWorkouts", status: "success" });
      healthKitRecordsTotal.add(input.workouts.length, {
        endpoint: "pushWorkouts",
        category: "workout",
      });
      return { inserted };
    }),

  pushWorkoutRoutes: protectedProcedure
    .input(z.object({ routes: z.array(workoutRouteSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);
      const inserted = await processWorkoutRoutes(
        ctx.db,
        ctx.userId,
        input.routes,
        ctx.metricStreamPublisher,
      );

      if (inserted > 0) {
        await invalidateAllUserQueries(ctx.userId);
      }

      healthKitPushTotal.add(1, { endpoint: "pushWorkoutRoutes", status: "success" });
      healthKitRecordsTotal.add(
        input.routes.reduce((sum, route) => sum + route.locations.length, 0),
        { endpoint: "pushWorkoutRoutes", category: "workoutRoute" },
      );
      return { inserted };
    }),

  pushSleepSamples: protectedProcedure
    .input(z.object({ samples: z.array(sleepSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);
      const inserted = await processSleepSamples(ctx.db, ctx.userId, input.samples);

      if (inserted > 0) {
        await invalidateAllUserQueries(ctx.userId);
      }

      healthKitPushTotal.add(1, { endpoint: "pushSleepSamples", status: "success" });
      healthKitRecordsTotal.add(input.samples.length, {
        endpoint: "pushSleepSamples",
        category: "sleep",
      });
      return { inserted };
    }),
});
