import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryCache } from "../lib/cache.ts";
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

/** Refresh a single materialized view (CONCURRENTLY if possible). */
async function refreshView(db: Database, view: string): Promise<void> {
  try {
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
  } catch {
    await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
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
      let needsDailyMetricsRefresh = false;

      try {
        inserted += await processBodyMeasurements(ctx.db, ctx.userId, bodyMeasurements);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Body measurements: ${message}`);
      }

      try {
        const dailyInserted = await processDailyMetrics(ctx.db, ctx.userId, dailyMetricSamples);
        inserted += dailyInserted;
        if (dailyInserted > 0) {
          needsDailyMetricsRefresh = true;
        }
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
          let aggregatedDailyMetrics = false;
          if (bounds) {
            const hasSpo2 = metricStreamSamples.some(
              (s) => s.type === "HKQuantityTypeIdentifierOxygenSaturation",
            );
            if (hasSpo2) {
              await aggregateSpO2ToDailyMetrics(ctx.db, ctx.userId, bounds, ctx.timezone);
              aggregatedDailyMetrics = true;
            }
            const skinTempSamples = metricStreamSamples.filter(
              (s) => s.type === "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            );
            if (skinTempSamples.length > 0) {
              logger.info(
                `[apple_health] Received ${skinTempSamples.length} skin temperature samples, aggregating to daily_metrics`,
              );
              await aggregateSkinTempToDailyMetrics(ctx.db, ctx.userId, bounds, ctx.timezone);
              aggregatedDailyMetrics = true;
            }
          }

          // Refresh the daily metrics view so the dashboard picks up new data immediately
          if (aggregatedDailyMetrics) {
            needsDailyMetricsRefresh = true;
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

      // Refresh materialized views so the dashboard picks up new data immediately
      if (needsDailyMetricsRefresh) {
        try {
          await refreshView(ctx.db, "fitness.v_daily_metrics");
        } catch (error) {
          logger.error(`[apple_health] Failed to refresh v_daily_metrics: ${error}`);
        }
      }
      if (bodyMeasurements.length > 0) {
        try {
          await refreshView(ctx.db, "fitness.v_body_measurement");
        } catch (error) {
          logger.error(`[apple_health] Failed to refresh v_body_measurement: ${error}`);
        }
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
        try {
          await refreshView(ctx.db, "fitness.v_activity");
          await refreshView(ctx.db, "fitness.activity_summary");
        } catch (error) {
          logger.error(`[apple_health] Failed to refresh activity views: ${error}`);
        }
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
        try {
          await refreshView(ctx.db, "fitness.v_sleep");
        } catch (error) {
          logger.error(`[apple_health] Failed to refresh v_sleep: ${error}`);
        }
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
