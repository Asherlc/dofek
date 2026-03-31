import { z } from "zod";
import { BodyRepository } from "../repositories/body-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { BodyMeasurementRow } from "../repositories/body-repository.ts";

export const bodyRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new BodyRepository(ctx.db, ctx.userId, ctx.timezone);
      const measurements = await repo.list(input.days);
      return measurements.map((measurement) => measurement.toDetail());
    }),
});
