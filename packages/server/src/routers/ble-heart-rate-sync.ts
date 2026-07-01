import { z } from "zod";
import { logger } from "../logger.ts";
import { BleHeartRateSyncRepository } from "../repositories/ble-heart-rate-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

// ── Zod schemas ──

const bleHeartRateSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  /** Heart rate in bpm from the Heart Rate Measurement characteristic (0x2A37). */
  heartRateBpm: z.number().int().min(0).max(300),
  /** Beat-to-beat (R-R) intervals in milliseconds from the same notification. */
  rrIntervalsMs: z.array(z.number().int().min(0).max(32767)).default([]),
});

const pushSamplesInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(bleHeartRateSampleSchema),
});

// ── Router ──

export const bleHeartRateSyncRouter = router({
  pushSamples: protectedProcedure.input(pushSamplesInput).mutation(async ({ ctx, input }) => {
    const repository = new BleHeartRateSyncRepository(
      ctx.db,
      ctx.userId,
      ctx.metricStreamPublisher,
    );

    if (input.samples.length === 0) {
      await repository.ensureProvider();
      logger.info("BLE heart-rate push with 0 samples", { userId: ctx.userId });
      return { inserted: 0 };
    }

    const now = new Date();
    const validSamples = filterFutureSamples(input.samples, now, "BLE heart rate");
    await repository.ensureProvider();

    const firstTimestamp = validSamples[0]?.timestamp;
    const lastTimestamp = validSamples[validSamples.length - 1]?.timestamp;

    const inserted = await repository.insertSampleBatch(input.deviceId, validSamples);

    logger.info("BLE heart-rate data pushed", {
      userId: ctx.userId,
      deviceId: input.deviceId,
      sampleCount: inserted,
      filteredCount: input.samples.length - validSamples.length,
      firstTimestamp,
      lastTimestamp,
      serverTime: now.toISOString(),
    });

    return { inserted };
  }),
});
