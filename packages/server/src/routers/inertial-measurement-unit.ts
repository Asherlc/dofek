import { z } from "zod";
import { InertialMeasurementUnitRepository } from "../repositories/inertial-measurement-unit-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const inertialMeasurementUnitRouter = router({
  /** Daily sample counts for the last N days — powers the coverage chart */
  getDailyCounts: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new InertialMeasurementUnitRepository(ctx.db, ctx.userId);
      return repo.getDailyCounts(input.days);
    }),

  /** Sync status: latest sync time, total samples, device breakdown */
  getSyncStatus: protectedProcedure.query(async ({ ctx }) => {
    const repo = new InertialMeasurementUnitRepository(ctx.db, ctx.userId);
    return repo.getSyncStatus();
  }),

  /** 5-minute bucket coverage for a single day — shows connection gaps */
  getCoverageTimeline: protectedProcedure
    .input(z.object({ date: z.string().date() }))
    .query(async ({ ctx, input }) => {
      const repo = new InertialMeasurementUnitRepository(ctx.db, ctx.userId);
      return repo.getCoverageTimeline(input.date);
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
      const repo = new InertialMeasurementUnitRepository(ctx.db, ctx.userId);
      return repo.getTimeSeries(input.startDate, input.endDate);
    }),
});
