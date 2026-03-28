import { z } from "zod";
import { logger } from "../logger.ts";
import { AccelerometerSyncRepository } from "../repositories/accelerometer-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export type { AccelerometerSample } from "../repositories/accelerometer-sync-repository.ts";

// ── Zod schemas ──

const accelerometerSampleSchema = z.object({
  timestamp: z.string(), // ISO 8601 with millisecond precision
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const pushAccelerometerInput = z.object({
  deviceId: z.string().min(1),
  deviceType: z.string().min(1),
  samples: z.array(accelerometerSampleSchema),
});

// ── Router ──

export const accelerometerSyncRouter = router({
  pushAccelerometerSamples: protectedProcedure
    .input(pushAccelerometerInput)
    .mutation(async ({ ctx, input }) => {
      const repository = new AccelerometerSyncRepository(ctx.db, ctx.userId);

      await repository.ensureProvider();

      if (input.samples.length === 0) {
        return { inserted: 0 };
      }

      const inserted = await repository.insertBatch(
        input.deviceId,
        input.deviceType,
        input.samples,
      );

      logger.info("Accelerometer samples pushed", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        deviceType: input.deviceType,
        sampleCount: inserted,
      });

      return { inserted };
    }),
});
