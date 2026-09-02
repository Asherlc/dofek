import { SpanStatusCode, trace } from "@opentelemetry/api";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { logger } from "../logger.ts";
import { InertialMeasurementUnitSyncRepository } from "../repositories/inertial-measurement-unit-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

const tracer = trace.getTracer("dofek-server");

const inertialMeasurementUnitSampleSchema = z.object({
  timestamp: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  gyroscopeX: z.number().optional(),
  gyroscopeY: z.number().optional(),
  gyroscopeZ: z.number().optional(),
});

const pushSamplesInput = z.object({
  deviceId: z.string().min(1),
  deviceType: z.string().min(1),
  samples: z.array(inertialMeasurementUnitSampleSchema),
});

export const inertialMeasurementUnitSyncRouter = router({
  pushSamples: protectedProcedure.input(pushSamplesInput).mutation(async ({ ctx, input }) => {
    const repository = new InertialMeasurementUnitSyncRepository(
      ctx.db,
      ctx.userId,
      ctx.metricStreamPublisher,
    );

    if (input.samples.length === 0) {
      await repository.ensureProvider();
      logger.info("IMU push with 0 samples", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        deviceType: input.deviceType,
      });
      return { inserted: 0 };
    }

    return tracer.startActiveSpan(
      "imu.pushSamples",
      {
        attributes: {
          "imu.sampleCount": input.samples.length,
          "imu.deviceId": input.deviceId,
        },
      },
      async (span) => {
        const now = new Date();
        const validSamples = filterFutureSamples(input.samples, now, "IMU");

        const firstTimestamp = validSamples[0]?.timestamp;
        const lastTimestamp = validSamples[validSamples.length - 1]?.timestamp;
        const nowIso = now.toISOString();

        try {
          const t0 = performance.now();
          await repository.ensureProvider();
          const ensureProviderMs = performance.now() - t0;

          const t1 = performance.now();
          const inserted = await repository.insertBatch(
            input.deviceId,
            input.deviceType,
            validSamples,
          );
          const insertBatchMs = performance.now() - t1;
          const totalMs = ensureProviderMs + insertBatchMs;

          span.setAttributes({
            "imu.ensureProviderMs": ensureProviderMs,
            "imu.insertBatchMs": insertBatchMs,
            "imu.totalMs": totalMs,
            "imu.sampleCount": inserted,
            "imu.filteredCount": input.samples.length - validSamples.length,
          });

          logger.info("IMU samples pushed", {
            userId: ctx.userId,
            deviceId: input.deviceId,
            deviceType: input.deviceType,
            sampleCount: inserted,
            filteredCount: input.samples.length - validSamples.length,
            firstTimestamp,
            lastTimestamp,
            serverTime: nowIso,
            ensureProviderMs,
            insertBatchMs,
            totalMs,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return { inserted };
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof Error) {
            span.recordException(error);
          }
          captureException(error, { tags: { source: "imu-push-samples" } });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }),
});
