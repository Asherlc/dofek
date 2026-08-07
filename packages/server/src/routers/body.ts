import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { BodyRepository } from "../repositories/body-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export type { BodyMeasurementRow } from "../repositories/body-repository.ts";

export const bodyRouter = router({
  list: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ days: z.number().int().nonnegative().default(90) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "body.list requires the ClickHouse body measurement store",
        });
      }
      const repo = new BodyRepository(ctx.sensorStore, ctx.userId, ctx.timezone);
      const measurements = await repo.list(input.days);
      return measurements.map((measurement) => measurement.toDetail());
    }),
});
