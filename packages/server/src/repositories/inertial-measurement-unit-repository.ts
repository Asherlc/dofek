import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const dailyCountRowSchema = z.object({
  date: z.string(),
  sample_count: z.coerce.number(),
  hours_covered: z.coerce.number(),
});

const syncStatusRowSchema = z.object({
  device_id: z.string(),
  device_type: z.string(),
  sample_count: z.coerce.number(),
  latest_sample: z.string().nullable(),
  earliest_sample: z.string().nullable(),
});

const dailyHeatmapRowSchema = z.object({
  date: z.string(),
  hour: z.coerce.number(),
  sample_count: z.coerce.number(),
  coverage_percent: z.coerce.number(),
});

const coverageBucketRowSchema = z.object({
  bucket: z.string(),
  sample_count: z.coerce.number(),
});

const timeSeriesRowSchema = z.object({
  recorded_at: z.string(),
  x: z.coerce.number(),
  y: z.coerce.number(),
  z: z.coerce.number(),
  gyroscope_x: z.coerce.number().nullable(),
  gyroscope_y: z.coerce.number().nullable(),
  gyroscope_z: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface DailyCount {
  date: string;
  sampleCount: number;
  hoursCovered: number;
}

export interface DeviceSyncStatus {
  deviceId: string;
  deviceType: string;
  sampleCount: number;
  latestSample: string | null;
  earliestSample: string | null;
}

export interface DailyHeatmapCell {
  date: string;
  hour: number;
  sampleCount: number;
  coveragePercent: number;
}

export interface CoverageBucket {
  bucket: string;
  sampleCount: number;
}

export interface InertialMeasurementUnitSample {
  recordedAt: string;
  x: number;
  y: number;
  z: number;
  gyroscopeX: number | null;
  gyroscopeY: number | null;
  gyroscopeZ: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time series window in milliseconds (10 minutes). */
const MAX_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for inertial measurement unit sample records. */
export class InertialMeasurementUnitRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Daily sample counts for the last N days — powers the coverage chart. */
  async getDailyCounts(days: number): Promise<DailyCount[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyCountRowSchema,
      sql`SELECT
          date_trunc('day', recorded_at)::date::text AS date,
          count(*)::int AS sample_count,
          (count(*)::float / (50.0 * 3600))::numeric(6,2)::float AS hours_covered
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${this.#userId}::uuid
          AND recorded_at > now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY 1 DESC`,
    );

    return rows.map((row) => ({
      date: row.date,
      sampleCount: row.sample_count,
      hoursCovered: row.hours_covered,
    }));
  }

  /** Hourly coverage heatmap for the last N days — one row per (date, hour). */
  async getDailyHeatmap(days: number): Promise<DailyHeatmapCell[]> {
    const rows = await executeWithSchema(
      this.#db,
      dailyHeatmapRowSchema,
      sql`SELECT
          date_trunc('day', recorded_at)::date::text AS date,
          extract(hour FROM recorded_at)::int AS hour,
          count(*)::int AS sample_count,
          least(count(*)::float / 180000.0 * 100, 100)::numeric(5,1)::float AS coverage_percent
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${this.#userId}::uuid
          AND recorded_at > now() - make_interval(days => ${days})
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2 ASC`,
    );

    return rows.map((row) => ({
      date: row.date,
      hour: row.hour,
      sampleCount: row.sample_count,
      coveragePercent: row.coverage_percent,
    }));
  }

  /** Sync status: latest sync time, total samples, device breakdown. */
  async getSyncStatus(): Promise<DeviceSyncStatus[]> {
    const rows = await executeWithSchema(
      this.#db,
      syncStatusRowSchema,
      sql`SELECT
          device_id,
          device_type,
          count(*)::int AS sample_count,
          max(recorded_at)::text AS latest_sample,
          min(recorded_at)::text AS earliest_sample
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${this.#userId}::uuid
        GROUP BY device_id, device_type`,
    );

    return rows.map((row) => ({
      deviceId: row.device_id,
      deviceType: row.device_type,
      sampleCount: row.sample_count,
      latestSample: row.latest_sample,
      earliestSample: row.earliest_sample,
    }));
  }

  /** 5-minute bucket coverage for a single day — shows connection gaps. */
  async getCoverageTimeline(date: string): Promise<CoverageBucket[]> {
    const rows = await executeWithSchema(
      this.#db,
      coverageBucketRowSchema,
      sql`SELECT
          time_bucket('5 minutes', recorded_at)::text AS bucket,
          count(*)::int AS sample_count
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${this.#userId}::uuid
          AND recorded_at >= ${date}::date
          AND recorded_at < ${date}::date + interval '1 day'
        GROUP BY 1
        ORDER BY 1 ASC`,
    );

    return rows.map((row) => ({
      bucket: row.bucket,
      sampleCount: row.sample_count,
    }));
  }

  /**
   * Raw time series for a short window — for waveform visualization.
   * Clamps the window to a maximum of 10 minutes (30,000 samples at 50 Hz).
   */
  async getTimeSeries(
    startDate: string,
    endDate: string,
  ): Promise<InertialMeasurementUnitSample[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const maxEnd = new Date(start.getTime() + MAX_WINDOW_MS);
    const clampedEnd = end < maxEnd ? end : maxEnd;

    const rows = await executeWithSchema(
      this.#db,
      timeSeriesRowSchema,
      sql`SELECT
          recorded_at::text,
          x, y, z,
          gyroscope_x, gyroscope_y, gyroscope_z
        FROM fitness.inertial_measurement_unit_sample
        WHERE user_id = ${this.#userId}::uuid
          AND recorded_at >= ${start.toISOString()}::timestamptz
          AND recorded_at < ${clampedEnd.toISOString()}::timestamptz
        ORDER BY recorded_at ASC`,
    );

    return rows.map((row) => ({
      recordedAt: row.recorded_at,
      x: row.x,
      y: row.y,
      z: row.z,
      gyroscopeX: row.gyroscope_x,
      gyroscopeY: row.gyroscope_y,
      gyroscopeZ: row.gyroscope_z,
    }));
  }
}
