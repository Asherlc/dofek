import { z } from "zod";
import { AccelerometerRepository } from "../repositories/accelerometer-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const accelerometerRouter = router({
  /** Daily sample counts for the last N days — powers the coverage chart */
  getDailyCounts: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new AccelerometerRepository(ctx.db, ctx.userId);
      return repo.getDailyCounts(input.days);
    }),

  /** Sync status: latest sync time, total samples, device breakdown */
  getSyncStatus: protectedProcedure.query(async ({ ctx }) => {
    const repo = new AccelerometerRepository(ctx.db, ctx.userId);
    return repo.getSyncStatus();
  }),

  /** Raw time series for a short window — for waveform visualization.
   * Limited to 10 minutes (30,000 samples at 50 Hz) to avoid huge responses. */
  getTimeSeries: protectedProcedure
    .input(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new AccelerometerRepository(ctx.db, ctx.userId);
      return repo.getTimeSeries(input.startDate, input.endDate);
    }),
});
