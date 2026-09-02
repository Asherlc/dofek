import { z } from "zod";
import { logger } from "../logger.ts";
import { BleHeartRateSyncRepository } from "../repositories/ble-heart-rate-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

// ── Zod schemas ──

const bleHeartRateSampleSchema = z.object({
  // Reject non-ISO strings at the boundary so a malformed mobile payload returns
  // an input-validation error instead of failing later as an internal insert
  // error. The mobile buffer serializes UTC timestamps with fractional seconds;
  // `offset: true` also tolerates zoned forms.
  timestamp: z.string().datetime({ offset: true }),
  /** Heart rate in bpm from the Heart Rate Measurement characteristic (0x2A37). */
  heartRateBpm: z.number().int().min(0).max(300),
  /** Beat-to-beat (R-R) intervals in milliseconds from the same notification. */
  rrIntervalsMs: z.array(z.number().int().min(0).max(32767)).default([]),
});

const pushSamplesInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(bleHeartRateSampleSchema),
});

const pushSamplesOutput = z.object({ inserted: z.number().int().min(0) });

// ── Router ──

export const bleHeartRateSyncRouter = router({
  pushSamples: protectedProcedure
    .input(pushSamplesInput)
    .output(pushSamplesOutput)
    .mutation(async ({ ctx, input }) => {
      const repository = new BleHeartRateSyncRepository(
        ctx.db,
        ctx.userId,
        ctx.metricStreamPublisher,
      );

      // Empty / all-filtered input flows through the same path: ensureProvider
      // still runs and insertSampleBatch([]) returns 0.
      const now = new Date();
      const validSamples = filterFutureSamples(input.samples, now, "BLE heart rate");
      await repository.ensureProvider();

      const firstTimestamp = validSamples[0]?.timestamp;
      const lastTimestamp = validSamples[validSamples.length - 1]?.timestamp;

      const inserted = await repository.insertSampleBatch(input.deviceId, validSamples);

      logger.info("BLE heart-rate data pushed", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        sampleCount: validSamples.length,
        rowsInserted: inserted,
        filteredCount: input.samples.length - validSamples.length,
        firstTimestamp,
        lastTimestamp,
        serverTime: now.toISOString(),
      });

      return { inserted };
    }),
});
