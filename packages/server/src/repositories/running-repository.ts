import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNNING_TYPES = ["running", "trail_running"];

function runningTypeFilter(alias: string) {
  const list = RUNNING_TYPES.map((type) => `'${type}'`).join(", ");
  return sql.raw(`${alias}.activity_type IN (${list})`);
}

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface RunningDynamicsActivityRow {
  activityId: string;
  date: string;
  activityName: string;
  avgCadence: number;
  avgStrideLengthMeters: number | null;
  avgStanceTimeMs: number | null;
  avgVerticalOscillationMm: number | null;
  avgSpeed: number;
  totalDistance: number;
}

/** A running activity with dynamics metrics (cadence, stride, stance, oscillation). */
export class RunningDynamicsActivity {
  readonly #row: RunningDynamicsActivityRow;

  constructor(row: RunningDynamicsActivityRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityId(): string {
    return this.#row.activityId;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  get cadence(): number {
    return this.#row.avgCadence;
  }

  get strideLengthMeters(): number | null {
    return this.#row.avgStrideLengthMeters;
  }

  get stanceTimeMs(): number | null {
    return this.#row.avgStanceTimeMs;
  }

  get verticalOscillationMm(): number | null {
    return this.#row.avgVerticalOscillationMm;
  }

  /** Pace in seconds per kilometer, derived from average speed (m/s). */
  get paceSecondsPerKm(): number {
    return this.#row.avgSpeed > 0 ? Math.round(1000 / this.#row.avgSpeed) : 0;
  }

  /** Distance in kilometers, rounded to 1 decimal. */
  get distanceKm(): number {
    return Math.round((this.#row.totalDistance / 1000) * 10) / 10;
  }

  toDetail() {
    return {
      activityId: this.activityId,
      date: this.date,
      activityName: this.activityName,
      cadence: this.cadence,
      strideLengthMeters: this.strideLengthMeters,
      stanceTimeMs: this.stanceTimeMs,
      verticalOscillationMm: this.verticalOscillationMm,
      paceSecondsPerKm: this.paceSecondsPerKm,
      distanceKm: this.distanceKm,
    };
  }
}

export interface PaceTrendActivityRow {
  date: string;
  activityName: string;
  avgSpeed: number;
  totalDistance: number;
  durationSeconds: number;
}

/** A running activity for pace trend analysis. */
export class PaceTrendActivity {
  readonly #row: PaceTrendActivityRow;

  constructor(row: PaceTrendActivityRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  /** Pace in seconds per kilometer, derived from average speed (m/s). */
  get paceSecondsPerKm(): number {
    return this.#row.avgSpeed > 0 ? Math.round(1000 / this.#row.avgSpeed) : 0;
  }

  /** Distance in kilometers, rounded to 1 decimal. */
  get distanceKm(): number {
    return Math.round((this.#row.totalDistance / 1000) * 10) / 10;
  }

  /** Duration in whole minutes. */
  get durationMinutes(): number {
    return Math.round(this.#row.durationSeconds / 60);
  }

  toDetail() {
    return {
      date: this.date,
      activityName: this.activityName,
      paceSecondsPerKm: this.paceSecondsPerKm,
      distanceKm: this.distanceKm,
      durationMinutes: this.durationMinutes,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const dynamicsRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  name: z.string(),
  avg_cadence: z.coerce.number(),
  avg_stride_length: z.coerce.number().nullable(),
  avg_stance_time: z.coerce.number().nullable(),
  avg_vertical_osc: z.coerce.number().nullable(),
  avg_speed: z.coerce.number(),
  total_distance: z.coerce.number(),
});

const paceTrendRowSchema = z.object({
  date: dateStringSchema,
  name: z.string(),
  avg_speed: z.coerce.number(),
  total_distance: z.coerce.number(),
  duration_seconds: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for running dynamics and pace trend analytics. */
export class RunningRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Running dynamics per activity: cadence, stride length, stance time, vertical oscillation, pace, distance. */
  async getDynamics(days: number): Promise<RunningDynamicsActivity[]> {
    const rows = await executeWithSchema(
      this.#db,
      dynamicsRowSchema,
      sql`SELECT
            asum.activity_id,
            (asum.started_at AT TIME ZONE ${this.#timezone})::date AS date,
            asum.name,
            asum.avg_cadence,
            asum.avg_stride_length,
            asum.avg_stance_time,
            asum.avg_vertical_osc,
            asum.avg_speed,
            asum.total_distance
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${this.#userId}
            AND asum.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ${runningTypeFilter("asum")}
            AND asum.avg_speed > 0
            AND asum.avg_cadence > 0
          ORDER BY asum.started_at`,
    );

    return rows.map(
      (row) =>
        new RunningDynamicsActivity({
          activityId: row.activity_id,
          date: row.date,
          activityName: row.name,
          avgCadence: row.avg_cadence,
          avgStrideLengthMeters: row.avg_stride_length,
          avgStanceTimeMs: row.avg_stance_time,
          avgVerticalOscillationMm: row.avg_vertical_osc,
          avgSpeed: row.avg_speed,
          totalDistance: row.total_distance,
        }),
    );
  }

  /** Pace trend per running activity: average pace, distance, duration. */
  async getPaceTrend(days: number): Promise<PaceTrendActivity[]> {
    const rows = await executeWithSchema(
      this.#db,
      paceTrendRowSchema,
      sql`SELECT
            (asum.started_at AT TIME ZONE ${this.#timezone})::date AS date,
            asum.name,
            asum.avg_speed,
            asum.total_distance,
            EXTRACT(EPOCH FROM (asum.ended_at - asum.started_at))::int AS duration_seconds
          FROM fitness.activity_summary asum
          WHERE asum.user_id = ${this.#userId}
            AND asum.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND ${runningTypeFilter("asum")}
            AND asum.avg_speed > 0
            AND asum.ended_at IS NOT NULL
          ORDER BY asum.started_at`,
    );

    return rows.map(
      (row) =>
        new PaceTrendActivity({
          date: row.date,
          activityName: row.name,
          avgSpeed: row.avg_speed,
          totalDistance: row.total_distance,
          durationSeconds: row.duration_seconds,
        }),
    );
  }
}
