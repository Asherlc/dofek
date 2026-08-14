import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const intervalMetadataRowSchema = z.object({
  id: z.string(),
  interval_index: z.coerce.number(),
  label: z.string().nullable(),
  interval_type: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  duration_seconds: z.coerce.number().nullable(),
});

const sensorPointRowSchema = z.object({
  recorded_at: z.string(),
  heart_rate: z.coerce.number().nullable(),
  power: z.coerce.number().nullable(),
  speed: z.coerce.number().nullable(),
  cadence: z.coerce.number().nullable(),
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
  altitude: z.coerce.number().nullable(),
});

const minuteAggRowSchema = z.object({
  minute_start: z.string(),
  avg_power: z.coerce.number().nullable(),
  avg_hr: z.coerce.number().nullable(),
  avg_speed: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  max_speed: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface IntervalRow {
  id: string;
  interval_index: number;
  label: string | null;
  interval_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  distance_meters: number | null;
  elevation_gain: number | null;
}

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

const CHANGE_THRESHOLD = 0.15;

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

const EARTH_RADIUS_METERS = 6_371_000;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const chordSquared =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(chordSquared));
}

type SensorPoint = z.infer<typeof sensorPointRowSchema>;

function aggregateInterval(points: SensorPoint[]): {
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  distance_meters: number | null;
  elevation_gain: number | null;
} {
  const hrs = points.map((p) => p.heart_rate);
  const powers = points.map((p) => p.power).filter((v): v is number => v != null && v > 0);
  const speeds = points.map((p) => p.speed);
  const cadences = points.map((p) => p.cadence).filter((v): v is number => v != null && v > 0);

  const validHrs = hrs.filter((v): v is number => v != null);
  const validSpeeds = speeds.filter((v): v is number => v != null);

  let distance = 0;
  let elevationGain = 0;
  for (let index = 1; index < points.length; index++) {
    const prev = points[index - 1];
    const curr = points[index];
    if (!prev || !curr) continue;
    if (prev.lat != null && prev.lng != null && curr.lat != null && curr.lng != null) {
      distance += haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    }
    if (prev.altitude != null && curr.altitude != null) {
      const delta = curr.altitude - prev.altitude;
      if (delta > 0) elevationGain += delta;
    }
  }

  const avg = (values: number[]) =>
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

  return {
    avg_heart_rate: avg(validHrs),
    max_heart_rate: validHrs.length > 0 ? Math.round(Math.max(...validHrs)) : null,
    avg_power: avg(powers),
    max_power: powers.length > 0 ? Math.round(Math.max(...powers)) : null,
    avg_speed: avg(validSpeeds),
    max_speed: validSpeeds.length > 0 ? Math.max(...validSpeeds) : null,
    avg_cadence: avg(cadences),
    distance_meters: points.length > 1 ? distance : null,
    elevation_gain: points.length > 1 ? elevationGain : null,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for activity intervals and auto-detection from sensor streams. */
export class IntervalsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(db: Pick<Database, "execute">, userId: string, sensorStore: ActivitySensorStore) {
    this.#db = db;
    this.#userId = userId;
    this.#sensorStore = sensorStore;
  }

  /** Get intervals/laps for a specific activity with computed per-interval metrics. */
  async getByActivity(activityId: string): Promise<IntervalRow[]> {
    const intervals = await executeWithSchema(
      this.#db,
      intervalMetadataRowSchema,
      sql`
        SELECT
          ai.id,
          ai.interval_index,
          ai.label,
          ai.interval_type,
          ai.started_at,
          ai.ended_at,
          EXTRACT(EPOCH FROM (ai.ended_at - ai.started_at)) AS duration_seconds
        FROM fitness.activity_interval ai
        WHERE ai.activity_id = ${activityId}::uuid
          AND EXISTS (
            SELECT 1
            FROM fitness.v_activity visible_activity
            WHERE visible_activity.user_id = ${this.#userId}
              AND ${activityId}::uuid = ANY(visible_activity.member_activity_ids)
          )
        ORDER BY ai.interval_index
      `,
    );

    if (intervals.length === 0) return [];

    const samples = await this.#sensorStore.query(
      sensorPointRowSchema,
      `WITH
      scalar_samples AS (
        SELECT
          recorded_at,
          maxIf(scalar, channel = 'heart_rate') AS heart_rate,
          maxIf(scalar, channel = 'power') AS power,
          maxIf(scalar, channel = 'speed') AS speed,
          maxIf(scalar, channel = 'cadence') AS cadence,
          maxIf(scalar, channel = 'altitude') AS altitude
        FROM analytics.deduped_sensor AS sensor_samples
        INNER JOIN analytics.v_activity AS activity
          ON activity.id = {activityId:UUID}
         AND activity.user_id = sensor_samples.user_id
         AND sensor_samples.recorded_at >= activity.started_at
         AND sensor_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
        WHERE sensor_samples.user_id = {userId:UUID}
          AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
          AND is_deleted = 0
        GROUP BY recorded_at
      ),
      location_samples AS (
        SELECT recorded_at, lat, lng
        FROM analytics.deduped_location
        WHERE activity_id = {activityId:UUID}
          AND user_id = {userId:UUID}
      ),
      sample_times AS (
        SELECT recorded_at FROM scalar_samples
        UNION DISTINCT
        SELECT recorded_at FROM location_samples
      )
      SELECT
        formatDateTime(sample_times.recorded_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS recorded_at,
        scalar_samples.heart_rate AS heart_rate,
        scalar_samples.power AS power,
        scalar_samples.speed AS speed,
        scalar_samples.cadence AS cadence,
        location_samples.lat AS lat,
        location_samples.lng AS lng,
        scalar_samples.altitude AS altitude
      FROM sample_times
      LEFT JOIN scalar_samples
        ON scalar_samples.recorded_at = sample_times.recorded_at
      LEFT JOIN location_samples
        ON location_samples.recorded_at = sample_times.recorded_at
      ORDER BY sample_times.recorded_at`,
      { activityId, userId: this.#userId },
    );

    let sampleCursor = 0;
    return intervals.map((interval) => {
      const start = new Date(interval.started_at).getTime();
      const end = interval.ended_at
        ? new Date(interval.ended_at).getTime()
        : Number.POSITIVE_INFINITY;
      while (
        sampleCursor < samples.length &&
        new Date(samples[sampleCursor]?.recorded_at ?? "").getTime() < start
      ) {
        sampleCursor++;
      }
      const points: z.infer<typeof sensorPointRowSchema>[] = [];
      for (let index = sampleCursor; index < samples.length; index++) {
        const point = samples[index];
        if (!point) continue;
        const timestamp = new Date(point.recorded_at).getTime();
        if (timestamp > end) break;
        points.push(point);
      }
      const metrics = aggregateInterval(points);
      return {
        id: interval.id,
        interval_index: interval.interval_index,
        label: interval.label,
        interval_type: interval.interval_type,
        started_at: interval.started_at,
        ended_at: interval.ended_at,
        duration_seconds: interval.duration_seconds,
        ...metrics,
      };
    });
  }

  /**
   * Auto-detect intervals from sensor stream data for an activity.
   * Splits activity into intervals based on significant changes in intensity.
   * Uses per-minute aggregates: when power or HR changes by > 15% from the
   * previous minute, a new interval boundary is created.
   */
  async detect(activityId: string): Promise<DetectedInterval[]> {
    const rows = await this.#sensorStore.query(
      minuteAggRowSchema,
      `WITH pivoted AS (
        SELECT
          recorded_at,
          maxIf(scalar, channel = 'power') AS power,
          maxIf(scalar, channel = 'heart_rate') AS heart_rate,
          maxIf(scalar, channel = 'speed') AS speed,
          maxIf(scalar, channel = 'cadence') AS cadence
        FROM analytics.deduped_sensor AS sensor_samples
        INNER JOIN analytics.v_activity AS activity
          ON activity.id = {activityId:UUID}
         AND activity.user_id = sensor_samples.user_id
         AND sensor_samples.recorded_at >= activity.started_at
         AND sensor_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
        WHERE sensor_samples.user_id = {userId:UUID}
          AND channel IN ('power', 'heart_rate', 'speed', 'cadence')
          AND is_deleted = 0
        GROUP BY recorded_at
      )
      SELECT
        formatDateTime(toStartOfMinute(recorded_at), '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS minute_start,
        round(avgIf(power, power > 0), 1) AS avg_power,
        round(avg(heart_rate), 1) AS avg_hr,
        round(avg(speed), 3) AS avg_speed,
        round(avgIf(cadence, cadence > 0), 1) AS avg_cadence,
        max(power) AS max_power,
        max(heart_rate) AS max_hr,
        max(speed) AS max_speed
      FROM pivoted
      GROUP BY toStartOfMinute(recorded_at)
      ORDER BY minute_start`,
      { activityId, userId: this.#userId },
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
