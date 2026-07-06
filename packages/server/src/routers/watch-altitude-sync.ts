import { z } from "zod";
import { logger } from "../logger.ts";
import { WatchAltitudeSyncRepository } from "../repositories/watch-altitude-sync-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";
import { filterFutureSamples } from "./sample-validation.ts";

const watchAltitudeSampleSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  altitudeM: z.number(),
  pressureKPa: z.number().optional(),
});

const pushSamplesInput = z.object({
  deviceId: z.string().min(1),
  samples: z.array(watchAltitudeSampleSchema),
});

const pushSamplesOutput = z.object({ inserted: z.number().int().min(0) });

export const watchAltitudeSyncRouter = router({
  pushSamples: protectedProcedure
    .input(pushSamplesInput)
    .output(pushSamplesOutput)
    .mutation(async ({ ctx, input }) => {
      const repository = new WatchAltitudeSyncRepository(
        ctx.db,
        ctx.userId,
        ctx.metricStreamPublisher,
      );

      const now = new Date();
      const validSamples = filterFutureSamples(input.samples, now, "Watch altitude");
      await repository.ensureProvider();

      const inserted = await repository.insertSampleBatch(input.deviceId, validSamples);

      logger.info("Watch altitude data pushed", {
        userId: ctx.userId,
        deviceId: input.deviceId,
        sampleCount: validSamples.length,
        rowsInserted: inserted,
        filteredCount: input.samples.length - validSamples.length,
        firstTimestamp: validSamples[0]?.timestamp,
        lastTimestamp: validSamples[validSamples.length - 1]?.timestamp,
        serverTime: now.toISOString(),
      });

      return { inserted };
    }),
});
