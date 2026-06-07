import { z } from "zod";
import { logger } from "../logger.ts";
import { InertialMeasurementUnitSyncRepository } from "../repositories/inertial-measurement-unit-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { rejectFutureSamples } from "./sample-validation.ts";

// ── Zod schemas ──

const inertialMeasurementUnitSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
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

// ── Router ──

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

    const now = new Date();
    rejectFutureSamples(input.samples, now, "IMU");
    await repository.ensureProvider();

    // Log timestamp range to detect stale/future data
    const firstTimestamp = input.samples[0]?.timestamp;
    const lastTimestamp = input.samples[input.samples.length - 1]?.timestamp;
    const nowIso = now.toISOString();

    const inserted = await repository.insertBatch(input.deviceId, input.deviceType, input.samples);

    logger.info("IMU samples pushed", {
      userId: ctx.userId,
      deviceId: input.deviceId,
      deviceType: input.deviceType,
      sampleCount: inserted,
      firstTimestamp,
      lastTimestamp,
      serverTime: nowIso,
    });

    return { inserted };
  }),
});
