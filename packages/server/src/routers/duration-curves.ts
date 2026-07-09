import { TRPCError } from "@trpc/server";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { DurationCurvesRepository } from "../repositories/duration-curves-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

export const durationCurvesRouter = router({
  /**
   * Heart Rate Duration Curve: best sustained HR for standard durations.
   * Uses cumulative sums over metric_stream heart_rate, same approach as power curves.
   */
  hrCurve: selectedChartRangeQuery(
    "durationCurves.hrCurve",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for duration curves. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new DurationCurvesRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getHrCurve(range);
    },
  ),

  /**
   * Pace Duration Curve: best sustained pace for standard durations.
   * Uses speed (m/s) from metric_stream, converts to pace (s/km) for output.
   * Higher speed = better pace (lower s/km), so we want MAX average speed.
   */
  paceCurve: selectedChartRangeQuery(
    "durationCurves.paceCurve",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for duration curves. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new DurationCurvesRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      return repo.getPaceCurve(range);
    },
  ),
});
