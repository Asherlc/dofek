import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const intervalsRouter = router({
  /**
   * Get intervals/laps for a specific activity.
   * Computes per-interval metrics from metric_stream based on interval time ranges.
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
          EXTRACT(EPOCH FROM (ai.ended_at - ai.started_at)) AS duration_seconds,
          im.avg_heart_rate,
          im.max_heart_rate,
          im.avg_power,
          im.max_power,
          im.avg_speed,
          im.max_speed,
          im.avg_cadence,
          im.distance_meters,
          im.elevation_gain
        FROM fitness.activity_interval ai
        JOIN fitness.activity a ON a.id = ai.activity_id
        LEFT JOIN LATERAL (
          SELECT
            AVG(ms.heart_rate)::REAL AS avg_heart_rate,
            MAX(ms.heart_rate)::SMALLINT AS max_heart_rate,
            AVG(ms.power) FILTER (WHERE ms.power > 0)::REAL AS avg_power,
            MAX(ms.power) FILTER (WHERE ms.power > 0)::SMALLINT AS max_power,
            AVG(ms.speed)::REAL AS avg_speed,
            MAX(ms.speed)::REAL AS max_speed,
            AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::REAL AS avg_cadence,
            (SELECT SUM(
              2 * 6371000 * ASIN(SQRT(
                POWER(SIN(RADIANS(g.lat - g.prev_lat) / 2), 2) +
                COS(RADIANS(g.prev_lat)) * COS(RADIANS(g.lat)) *
                POWER(SIN(RADIANS(g.lng - g.prev_lng) / 2), 2)
              ))
            )::REAL
            FROM (
              SELECT lat, lng,
                LAG(lat) OVER (ORDER BY recorded_at) AS prev_lat,
                LAG(lng) OVER (ORDER BY recorded_at) AS prev_lng
              FROM fitness.metric_stream ms2
              WHERE ms2.activity_id = ai.activity_id
                AND ms2.recorded_at >= ai.started_at
                AND (ai.ended_at IS NULL OR ms2.recorded_at <= ai.ended_at)
                AND ms2.lat IS NOT NULL AND ms2.lng IS NOT NULL
            ) g WHERE g.prev_lat IS NOT NULL) AS distance_meters,
            (SELECT SUM(CASE WHEN alt.altitude - alt.prev_alt > 0 THEN alt.altitude - alt.prev_alt ELSE 0 END)::REAL
            FROM (
              SELECT altitude,
                LAG(altitude) OVER (ORDER BY recorded_at) AS prev_alt
              FROM fitness.metric_stream ms3
              WHERE ms3.activity_id = ai.activity_id
                AND ms3.recorded_at >= ai.started_at
                AND (ai.ended_at IS NULL OR ms3.recorded_at <= ai.ended_at)
                AND ms3.altitude IS NOT NULL
            ) alt WHERE alt.prev_alt IS NOT NULL) AS elevation_gain
          FROM fitness.metric_stream ms
          WHERE ms.activity_id = ai.activity_id
            AND ms.recorded_at >= ai.started_at
            AND (ai.ended_at IS NULL OR ms.recorded_at <= ai.ended_at)
        ) im ON true
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
      }>(sql`
        SELECT
          date_trunc('minute', ms.recorded_at) AS minute_start,
          ROUND(AVG(ms.power) FILTER (WHERE ms.power > 0)::numeric, 1) AS avg_power,
          ROUND(AVG(ms.heart_rate)::numeric, 1) AS avg_hr,
          ROUND(AVG(ms.speed)::numeric, 3) AS avg_speed,
          ROUND(AVG(ms.cadence) FILTER (WHERE ms.cadence > 0)::numeric, 1) AS avg_cadence,
          MAX(ms.power) AS max_power,
          MAX(ms.heart_rate) AS max_hr,
          MAX(ms.speed) AS max_speed
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
