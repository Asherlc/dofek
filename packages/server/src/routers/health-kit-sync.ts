import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  aggregateDailyMetricSamples,
  categorize,
  computeBoundsFromIsoTimestamps,
  deriveSleepSessionsFromStages,
  type HealthKitSample,
  HealthKitSyncRepository,
  isSleepStageValue,
  type SleepSample,
} from "../repositories/health-kit-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

// ── Zod input schemas (tRPC input validation) ──

const healthKitSampleSchema = z.object({
  type: z.string(),
  value: z.number(),
  unit: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  sourceName: z.string(),
  sourceBundle: z.string(),
  uuid: z.string(),
});

const workoutSampleSchema = z.object({
  uuid: z.string(),
  workoutType: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  duration: z.number(),
  totalEnergyBurned: z.number().nullish(),
  totalDistance: z.number().nullish(),
  sourceName: z.string(),
  sourceBundle: z.string(),
});

const sleepSampleSchema = z.object({
  uuid: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  value: z.string(),
  sourceName: z.string(),
});

// Re-export types and pure functions that other modules may depend on
export type { HealthKitSample, SleepSample };
export {
  aggregateDailyMetricSamples,
  computeBoundsFromIsoTimestamps,
  deriveSleepSessionsFromStages,
  isSleepStageValue,
};
export type { DailyMetricAccumulator } from "../repositories/health-kit-sync-repository.ts";

// ── Router ──

export const healthKitSyncRouter = router({
  pushQuantitySamples: protectedProcedure
    .input(z.object({ samples: z.array(healthKitSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      const repository = new HealthKitSyncRepository(ctx.db, ctx.userId);
      await repository.ensureProvider();

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
        inserted += await repository.processBodyMeasurements(bodyMeasurements);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Body measurements: ${message}`);
      }

      try {
        inserted += await repository.processDailyMetrics(dailyMetricSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Daily metrics: ${message}`);
      }

      try {
        inserted += await repository.processMetricStream(metricStreamSamples);
        if (metricStreamSamples.length > 0) {
          const bounds = computeBoundsFromIsoTimestamps(
            metricStreamSamples.map((sample) => sample.startDate),
          );
          await repository.linkUnassignedHeartRateToWorkouts(bounds ?? undefined);

          // Aggregate SpO2 and skin temperature from metric_stream into daily_metrics
          let aggregatedDailyMetrics = false;
          if (bounds) {
            const hasSpo2 = metricStreamSamples.some(
              (sample) => sample.type === "HKQuantityTypeIdentifierOxygenSaturation",
            );
            if (hasSpo2) {
              await repository.aggregateSpO2ToDailyMetrics(bounds, ctx.timezone);
              aggregatedDailyMetrics = true;
            }
            const skinTempSamples = metricStreamSamples.filter(
              (sample) => sample.type === "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            );
            if (skinTempSamples.length > 0) {
              logger.info(
                `[apple_health] Received ${skinTempSamples.length} skin temperature samples, aggregating to daily_metrics`,
              );
              await repository.aggregateSkinTempToDailyMetrics(bounds, ctx.timezone);
              aggregatedDailyMetrics = true;
            }
          }

          // Refresh the daily metrics view so the dashboard picks up new data immediately
          if (aggregatedDailyMetrics) {
            await repository.refreshDailyMetricsView();
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Metric stream: ${message}`);
      }

      try {
        inserted += await repository.processHealthEvents(healthEventSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Health events: ${message}`);
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
      const repository = new HealthKitSyncRepository(ctx.db, ctx.userId);
      await repository.ensureProvider();
      const inserted = await repository.processWorkouts(input.workouts);
      healthKitPushTotal.add(1, { endpoint: "pushWorkouts", status: "success" });
      healthKitRecordsTotal.add(input.workouts.length, {
        endpoint: "pushWorkouts",
        category: "workout",
      });
      return { inserted };
    }),

  pushSleepSamples: protectedProcedure
    .input(z.object({ samples: z.array(sleepSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      const repository = new HealthKitSyncRepository(ctx.db, ctx.userId);
      await repository.ensureProvider();
      const inserted = await repository.processSleepSamples(input.samples);
      healthKitPushTotal.add(1, { endpoint: "pushSleepSamples", status: "success" });
      healthKitRecordsTotal.add(input.samples.length, {
        endpoint: "pushSleepSamples",
        category: "sleep",
      });
      return { inserted };
    }),
});
