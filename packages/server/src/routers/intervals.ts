import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const intervalsRouter = router({
  /**
   * Get intervals/laps for a specific activity.
   * Returns structured breakdown with per-interval metrics.
   */
  byActivity: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ activityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.execute(sql`
        SELECT
          ai.id,
          ai.interval_index,
          ai.label,
          ai.interval_type,
          ai.started_at,
          ai.ended_at,
          ai.avg_heart_rate,
          ai.max_heart_rate,
          ai.avg_power,
          ai.max_power,
          ai.avg_speed,
          ai.max_speed,
          ai.avg_cadence,
          ai.distance_meters,
          ai.elevation_gain,
          EXTRACT(EPOCH FROM (ai.ended_at - ai.started_at)) AS duration_seconds
        FROM fitness.activity_interval ai
        JOIN fitness.activity a ON a.id = ai.activity_id
        WHERE ai.activity_id = ${input.activityId}::uuid
          AND a.user_id = ${ctx.userId}
        ORDER BY ai.interval_index
      `);
      return rows;
    }),

  /**
   * Auto-detect intervals from metric_stream data for an activity.
   * Splits activity into intervals based on significant changes in intensity.
   * Uses a simple approach: segments where power or HR changes by > 15% from
   * a rolling baseline indicate a new interval.
   *
   * Returns computed intervals without saving them — caller decides whether to persist.
   */
  detect: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ activityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Get per-minute aggregates for the activity
      const rows = await ctx.db.execute<{
        minute_start: string;
        avg_power: number | null;
        avg_hr: number | null;
        avg_speed: number | null;
        avg_cadence: number | null;
        max_power: number | null;
        max_hr: number | null;
        max_speed: number | null;
        distance: number | null;
      }>(sql`
        SELECT
          date_trunc('minute', ms.recorded_at) AS minute_start,
          ROUND(AVG(ms.power) FILTER (WHERE ms.power > 0)::numeric, 1) AS avg_power,
          ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr,
          ROUND(AVG(ms.speed)::numeric, 3) AS avg_speed,
          ROUND(AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::numeric, 1) AS avg_cadence,
          MAX(ms.power) AS max_power,
          MAX(ms.heart_rate) AS max_hr,
          MAX(ms.speed) AS max_speed,
          MAX(ms.distance) AS distance
        FROM fitness.metric_stream ms
        JOIN fitness.activity a ON a.id = ms.activity_id
        WHERE ms.activity_id = ${input.activityId}::uuid
          AND a.user_id = ${ctx.userId}
        GROUP BY date_trunc('minute', ms.recorded_at)
        ORDER BY minute_start
      `);

      if (rows.length === 0) return [];

      // Detect interval boundaries using intensity changes
      const intervals: {
        startedAt: string;
        endedAt: string;
        avgPower: number | null;
        maxPower: number | null;
        avgHeartRate: number | null;
        maxHeartRate: number | null;
        avgSpeed: number | null;
        maxSpeed: number | null;
        avgCadence: number | null;
        distanceMeters: number | null;
      }[] = [];

      let segmentStart = 0;
      const CHANGE_THRESHOLD = 0.15; // 15% change triggers new interval

      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const curr = rows[i];
        if (!prev || !curr) continue;

        // Check for significant intensity change using whichever metric is available
        const metric = prev.avg_power != null ? "power" : prev.avg_hr != null ? "hr" : null;
        if (!metric) continue;

        const prevVal = metric === "power" ? Number(prev.avg_power) : Number(prev.avg_hr);
        const currVal = metric === "power" ? Number(curr.avg_power) : Number(curr.avg_hr);

        if (prevVal > 0 && Math.abs(currVal - prevVal) / prevVal > CHANGE_THRESHOLD) {
          // End current segment, start new one
          const segmentRows = rows.slice(segmentStart, i);
          if (segmentRows.length > 0) {
            const first = segmentRows[0];
            const last = segmentRows[segmentRows.length - 1];
            if (first && last) {
              intervals.push(summarizeSegment(segmentRows, first, last));
            }
          }
          segmentStart = i;
        }
      }

      // Final segment
      const remaining = rows.slice(segmentStart);
      if (remaining.length > 0) {
        const first = remaining[0];
        const last = remaining[remaining.length - 1];
        if (first && last) {
          intervals.push(summarizeSegment(remaining, first, last));
        }
      }

      return intervals.map((interval, idx) => ({
        intervalIndex: idx,
        ...interval,
      }));
    }),
});

function summarizeSegment(
  segmentRows: {
    avg_power: number | null;
    avg_hr: number | null;
    avg_speed: number | null;
    avg_cadence: number | null;
    max_power: number | null;
    max_hr: number | null;
    max_speed: number | null;
    distance: number | null;
  }[],
  first: { minute_start: string },
  last: { minute_start: string },
) {
  const avgPower = average(segmentRows.map((r) => r.avg_power));
  const avgHr = average(segmentRows.map((r) => r.avg_hr));
  const avgSpeed = average(segmentRows.map((r) => r.avg_speed));
  const avgCadence = average(segmentRows.map((r) => r.avg_cadence));

  const maxPower = maxVal(segmentRows.map((r) => r.max_power));
  const maxHr = maxVal(segmentRows.map((r) => r.max_hr));
  const maxSpeed = maxVal(segmentRows.map((r) => r.max_speed));

  const distances = segmentRows.map((r) => r.distance).filter((d): d is number => d != null);
  const distanceMeters =
    distances.length >= 2 ? (distances[distances.length - 1] ?? 0) - (distances[0] ?? 0) : null;

  return {
    startedAt: String(first.minute_start),
    endedAt: String(last.minute_start),
    avgPower,
    maxPower,
    avgHeartRate: avgHr,
    maxHeartRate: maxHr != null ? Math.round(maxHr) : null,
    avgSpeed,
    maxSpeed,
    avgCadence,
    distanceMeters,
  };
}

function average(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && v > 0);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

function maxVal(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}
