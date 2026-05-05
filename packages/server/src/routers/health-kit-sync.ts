import * as Sentry from "@sentry/node";
import { refreshMaterializedView } from "dofek/db/materialized-view-refresh";
import { queryCache } from "dofek/lib/cache";
import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";
import {
  aggregateSkinTempToDailyMetrics,
  aggregateSpO2ToDailyMetrics,
  computeBoundsFromIsoTimestamps,
  linkUnassignedHeartRateToWorkouts,
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
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name, user_id)
        VALUES (${PROVIDER_ID}, 'Apple Health', ${userId})
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function refreshIngestView(
  db: Database,
  viewName: "fitness.v_activity" | "fitness.v_sleep",
  source: string,
  userId: string,
): Promise<void> {
  try {
    await refreshMaterializedView(db, viewName, { source });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { userId, context: "healthKitMaterializedViewRefresh", viewName, source },
    });
  }
}

/** Route a sample to its destination category */
function categorize(
  type: string,
):
  | "bodyMeasurement"
  | "additiveDailyMetric"
  | "pointInTimeDailyMetric"
  | "metricStream"
  | "healthEvent" {
  if (type in bodyMeasurementTypes) return "bodyMeasurement";
  if (type in additiveDailyMetricTypes) return "additiveDailyMetric";
  if (type in pointInTimeDailyMetricTypes) return "pointInTimeDailyMetric";
  if (type in metricStreamTypes) return "metricStream";
  return "healthEvent";
}

// ── Router ──

export const healthKitSyncRouter = router({
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
      const errors: string[] = [];

      try {
        inserted += await processBodyMeasurements(ctx.db, ctx.userId, bodyMeasurements);
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
        inserted += await processMetricStream(ctx.db, ctx.userId, metricStreamSamples);
        if (metricStreamSamples.length > 0) {
          const bounds = computeBoundsFromIsoTimestamps(
            metricStreamSamples.map((s) => s.startDate),
          );
          await linkUnassignedHeartRateToWorkouts(ctx.db, ctx.userId, bounds ?? undefined);

          // Aggregate SpO2 and skin temperature from metric_stream into daily_metrics
          if (bounds) {
            const hasSpo2 = metricStreamSamples.some(
              (s) => s.type === "HKQuantityTypeIdentifierOxygenSaturation",
            );
            if (hasSpo2) {
              await aggregateSpO2ToDailyMetrics(ctx.db, ctx.userId, bounds, ctx.timezone);
            }
            const skinTempSamples = metricStreamSamples.filter(
              (s) => s.type === "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            );
            if (skinTempSamples.length > 0) {
              logger.info(
                `[apple_health] Received ${skinTempSamples.length} skin temperature samples, aggregating to daily_metrics`,
              );
              await aggregateSkinTempToDailyMetrics(ctx.db, ctx.userId, bounds, ctx.timezone);
            }
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

      // Invalidate cached data so queries pick up the newly ingested data
      if (inserted > 0) {
        await queryCache.invalidateByPrefix(`${ctx.userId}:`);
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
    .input(z.object({ workouts: z.array(workoutSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db, ctx.userId);
      const inserted = await processWorkouts(ctx.db, ctx.userId, input.workouts);

      // Refresh activity views so dashboard picks up new workouts immediately
      if (inserted > 0) {
        await refreshIngestView(
          ctx.db,
          "fitness.v_activity",
          "apple_health.workout_sync",
          ctx.userId,
        );
        await queryCache.invalidateByPrefix(`${ctx.userId}:`);
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
      const inserted = await processWorkoutRoutes(ctx.db, ctx.userId, input.routes);

      if (inserted > 0) {
        await queryCache.invalidateByPrefix(`${ctx.userId}:`);
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

      // Refresh v_sleep so sleep queries pick up new data immediately
      if (inserted > 0) {
        await refreshIngestView(ctx.db, "fitness.v_sleep", "apple_health.sleep_sync", ctx.userId);
        await queryCache.invalidateByPrefix(`${ctx.userId}:`);
      }

      healthKitPushTotal.add(1, { endpoint: "pushSleepSamples", status: "success" });
      healthKitRecordsTotal.add(input.samples.length, {
        endpoint: "pushSleepSamples",
        category: "sleep",
      });
      return { inserted };
    }),
});
