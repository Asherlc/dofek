import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const intervalRowSchema = z.object({
  id: z.string(),
  interval_index: z.coerce.number(),
  label: z.string().nullable(),
  interval_type: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  duration_seconds: z.coerce.number().nullable(),
  avg_heart_rate: z.number().nullable(),
  max_heart_rate: z.number().nullable(),
  avg_power: z.number().nullable(),
  max_power: z.number().nullable(),
  avg_speed: z.number().nullable(),
  max_speed: z.number().nullable(),
  avg_cadence: z.number().nullable(),
  distance_meters: z.number().nullable(),
  elevation_gain: z.number().nullable(),
});

const minuteAggRowSchema = z.object({
  minute_start: timestampStringSchema,
  avg_power: z.coerce.number().nullable(),
  avg_hr: z.coerce.number().nullable(),
  avg_speed: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  max_power: z.number().nullable(),
  max_hr: z.number().nullable(),
  max_speed: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type IntervalRow = z.infer<typeof intervalRowSchema>;

export type MinuteAggRow = z.infer<typeof minuteAggRowSchema>;

export interface DetectedInterval {
  intervalIndex: number;
  startedAt: string;
  endedAt: string;
  avgPower: number | null;
  maxPower: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgCadence: number | null;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

const CHANGE_THRESHOLD = 0.15; // 15% change triggers new interval

export function average(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && v > 0);
  if (valid.length === 0) return null;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}

export function maxVal(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

export function summarizeSegment(
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
  const avgPower = average(segmentRows.map((row) => row.avg_power));
  const avgHr = average(segmentRows.map((row) => row.avg_hr));
  const avgSpeed = average(segmentRows.map((row) => row.avg_speed));
  const avgCadence = average(segmentRows.map((row) => row.avg_cadence));

  const maxPower = maxVal(segmentRows.map((row) => row.max_power));
  const maxHr = maxVal(segmentRows.map((row) => row.max_hr));
  const maxSpeed = maxVal(segmentRows.map((row) => row.max_speed));

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

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for activity intervals and auto-detection from metric streams. */
export class IntervalsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Get intervals/laps for a specific activity with computed per-interval metrics. */
  async getByActivity(activityId: string): Promise<IntervalRow[]> {
    return executeWithSchema(
      this.#db,
      intervalRowSchema,
      sql`
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
            AVG(d.heart_rate)::REAL AS avg_heart_rate,
            MAX(d.heart_rate)::SMALLINT AS max_heart_rate,
            AVG(d.power) FILTER (WHERE d.power > 0)::REAL AS avg_power,
            MAX(d.power) FILTER (WHERE d.power > 0)::SMALLINT AS max_power,
            AVG(d.speed)::REAL AS avg_speed,
            MAX(d.speed)::REAL AS max_speed,
            AVG(d.cadence) FILTER (WHERE d.cadence > 0)::REAL AS avg_cadence,
            SUM(CASE WHEN d.prev_lat IS NOT NULL THEN
              2 * 6371000 * ASIN(SQRT(
                POWER(SIN(RADIANS(d.lat - d.prev_lat) / 2), 2) +
                COS(RADIANS(d.prev_lat)) * COS(RADIANS(d.lat)) *
                POWER(SIN(RADIANS(d.lng - d.prev_lng) / 2), 2)
              ))
            ELSE 0 END)::REAL AS distance_meters,
            SUM(CASE WHEN d.prev_alt IS NOT NULL AND d.altitude - d.prev_alt > 0
              THEN d.altitude - d.prev_alt ELSE 0 END)::REAL AS elevation_gain
          FROM (
            SELECT
              ms.heart_rate, ms.power, ms.speed, ms.cadence,
              ms.lat, ms.lng, ms.altitude,
              LAG(ms.lat) OVER w AS prev_lat,
              LAG(ms.lng) OVER w AS prev_lng,
              LAG(ms.altitude) OVER w AS prev_alt
            FROM fitness.metric_stream ms
            WHERE ms.activity_id = ai.activity_id
              AND ms.recorded_at >= ai.started_at
              AND (ai.ended_at IS NULL OR ms.recorded_at <= ai.ended_at)
            WINDOW w AS (ORDER BY ms.recorded_at)
          ) d
        ) im ON true
        WHERE ai.activity_id = ${activityId}::uuid
          AND a.user_id = ${this.#userId}
        ORDER BY ai.interval_index
      `,
    );
  }

  /**
   * Auto-detect intervals from metric_stream data for an activity.
   * Splits activity into intervals based on significant changes in intensity.
   * Uses per-minute aggregates: when power or HR changes by > 15% from the
   * previous minute, a new interval boundary is created.
   *
   * Returns computed intervals without saving them.
   */
  async detect(activityId: string): Promise<DetectedInterval[]> {
    const rows = await executeWithSchema(
      this.#db,
      minuteAggRowSchema,
      sql`
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
        WHERE ms.activity_id = ${activityId}::uuid
          AND a.user_id = ${this.#userId}
        GROUP BY date_trunc('minute', ms.recorded_at)
        ORDER BY minute_start
      `,
    );

    if (rows.length === 0) return [];

    const segments: {
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

    for (let index = 1; index < rows.length; index++) {
      const prev = rows[index - 1];
      const curr = rows[index];
      if (!prev || !curr) continue;

      const metric = prev.avg_power != null ? "power" : prev.avg_hr != null ? "hr" : null;
      if (!metric) continue;

      const prevVal = metric === "power" ? Number(prev.avg_power) : Number(prev.avg_hr);
      const currVal = metric === "power" ? Number(curr.avg_power) : Number(curr.avg_hr);

      if (prevVal > 0 && Math.abs(currVal - prevVal) / prevVal > CHANGE_THRESHOLD) {
        const segmentRows = rows.slice(segmentStart, index);
        if (segmentRows.length > 0) {
          const first = segmentRows[0];
          const last = segmentRows[segmentRows.length - 1];
          if (first && last) {
            segments.push(summarizeSegment(segmentRows, first, last));
          }
        }
        segmentStart = index;
      }
    }

    // Final segment
    const remaining = rows.slice(segmentStart);
    if (remaining.length > 0) {
      const first = remaining[0];
      const last = remaining[remaining.length - 1];
      if (first && last) {
        segments.push(summarizeSegment(remaining, first, last));
      }
    }

    return segments.map((segment, idx) => ({
      intervalIndex: idx,
      ...segment,
    }));
  }
}
