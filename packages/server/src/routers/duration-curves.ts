import { TRPCError } from "@trpc/server";
import { makeTrainingChartAvailability } from "../contracts/training-chart-availability.ts";
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
      const result = await repo.getPaceCurve(range);
      return {
        ...result,
        availability: makeTrainingChartAvailability({
          sourceLabel: "Running pace duration-curve read model",
          observedCount: result.points.length,
          minimumCount: 1,
          message:
            result.points.length === 0
              ? "No running pace duration data is available from the running pace duration-curve read model. Record at least 1 running activity with pace data to show this chart."
              : "Running pace duration data is available from the running pace duration-curve read model.",
        }),
      };
    },
  ),
});
