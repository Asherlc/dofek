import { z } from "zod";
import {
  HeartRateRepository,
  type HeartRateSourceSeries,
} from "../repositories/heart-rate-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const dateInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date"),
});

export type { HeartRateSourceSeries };

export const heartRateRouter = router({
  /**
   * Per-minute heart rate samples for a single day, grouped by source, read
   * from the Redpanda-fed ClickHouse metric-stream mirror.
   */
  dailyBySource: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(dateInputSchema)
    .query(async ({ ctx, input }): Promise<HeartRateSourceSeries[]> => {
      const repo = new HeartRateRepository(ctx.sensorStore, ctx.userId, ctx.timezone);
      return repo.dailyBySource(input.date);
    }),
});
