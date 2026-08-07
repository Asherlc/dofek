import { z } from "zod";
import { logger } from "../logger.ts";
import { WhoopBleSyncRepository } from "../repositories/whoop-ble-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

// ── Zod schemas ──

const realtimeDataSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  /** R-R interval in milliseconds (beat-to-beat timing from PPG). 0 when unavailable. */
  rrIntervalMs: z.number().int().min(0).max(32767).default(0),
  quaternionW: z.number(),
  quaternionX: z.number(),
  quaternionY: z.number(),
  quaternionZ: z.number(),
  /** Raw optical/PPG bytes from payload offsets 23-40, hex-encoded (36 chars = 18 bytes) */
  opticalRawHex: z
    .string()
    .regex(/^[0-9a-f]{36}$/)
    .default("0".repeat(36)),
});

const pushRealtimeDataInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(realtimeDataSampleSchema),
});

// ── Router ──

export const whoopBleSyncRouter = router({
  pushRealtimeData: protectedProcedure
    .input(pushRealtimeDataInput)
    .mutation(async ({ ctx, input }) => {
      const repository = new WhoopBleSyncRepository(ctx.db, ctx.userId, ctx.metricStreamPublisher);

      if (input.samples.length === 0) {
        await repository.ensureProvider();
        logger.info("WHOOP BLE realtime push with 0 samples", { userId: ctx.userId });
        return { inserted: 0 };
      }

      const now = new Date();
      const validSamples = filterFutureSamples(input.samples, now, "WHOOP BLE");
      await repository.ensureProvider();

      const firstTimestamp = validSamples[0]?.timestamp;
      const lastTimestamp = validSamples[validSamples.length - 1]?.timestamp;

      const inserted = await repository.insertRealtimeDataBatch(input.deviceId, validSamples);

      logger.info("WHOOP BLE realtime data pushed", {
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
