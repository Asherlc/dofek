import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DurationCurvesRepository } from "../repositories/duration-curves-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const daysInput = z.object({ days: z.number().default(90) });

export const durationCurvesRouter = router({
  /**
   * Heart Rate Duration Curve: best sustained HR for standard durations.
   * Uses cumulative sums over metric_stream heart_rate, same approach as power curves.
   */
  hrCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for duration curves. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new DurationCurvesRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getHrCurve(input.days);
    }),

  /**
   * Pace Duration Curve: best sustained pace for standard durations.
   * Uses speed (m/s) from metric_stream, converts to pace (s/km) for output.
   * Higher speed = better pace (lower s/km), so we want MAX average speed.
   */
  paceCurve: cachedProtectedQuery(CacheTTL.LONG)
    .input(daysInput)
    .query(async ({ ctx, input }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for duration curves. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new DurationCurvesRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getPaceCurve(input.days);
    }),
});
