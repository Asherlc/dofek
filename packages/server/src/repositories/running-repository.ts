import { formatActivityTypeLabel } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { z } from "zod";
import {
  clickHouseIntervalDayLowerBound,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNNING_TYPES = ["running"] as const;

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface RunningDynamicsActivityRow {
  activityId: string;
  date: string;
  activityName: string | null;
  avgCadence: number | null;
  cadenceBasis: "cadence_samples" | "step_intervals" | "unknown";
  cadenceObservedSeconds: number | null;
  cadenceCoveragePercent: number | null;
  avgStrideLengthMeters: number | null;
  avgStanceTimeMs: number | null;
  avgVerticalOscillationMm: number | null;
  avgSpeed: number | null;
  totalDistance: number | null;
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
    return this.#row.activityName?.trim() || formatActivityTypeLabel("running");
  }

  get cadence(): number | null {
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
  get paceSecondsPerKm(): number | null {
    return this.#row.avgSpeed != null && this.#row.avgSpeed > 0
      ? Math.round(1000 / this.#row.avgSpeed)
      : null;
  }

  /** Distance in kilometers, rounded to 1 decimal. */
  get distanceKm(): number | null {
    return this.#row.totalDistance != null
      ? Math.round((this.#row.totalDistance / 1000) * 10) / 10
      : null;
  }

  toDetail() {
    return {
      activityId: this.activityId,
      date: this.date,
      activityName: this.activityName,
      cadence: this.cadence,
      cadenceBasis: this.#row.cadenceBasis,
      cadenceObservedSeconds: this.#row.cadenceObservedSeconds,
      cadenceCoveragePercent: this.#row.cadenceCoveragePercent,
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
  name: z.string().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  cadence_basis: z.enum(["cadence_samples", "step_intervals", "unknown"]),
  cadence_observed_seconds: z.coerce.number().nullable(),
  cadence_coverage_percent: z.coerce.number().nullable(),
  avg_stride_length: z.coerce.number().nullable(),
  avg_stance_time: z.coerce.number().nullable(),
  avg_vertical_osc: z.coerce.number().nullable(),
  avg_speed: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
});

const paceTrendRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  name: z.string().nullable(),
  avg_speed: z.coerce.number(),
  total_distance: z.coerce.number(),
  duration_seconds: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Data access for running dynamics and pace trend analytics.
 *
 * Reads from analytics.activity_summary in ClickHouse via the sensor store.
 */
export class RunningRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Running dynamics per activity: cadence, stride length, stance time, vertical oscillation, pace, distance. */
  async getDynamics(days: RangeDays): Promise<RunningDynamicsActivity[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "started_at");
    const rows = await this.#sensorStore.query(
      dynamicsRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
        name,
        avg_cadence,
        cadence_basis,
        cadence_observed_seconds,
        cadence_coverage_percent,
        avg_stride_length,
        coalesce(avg_ground_contact_time, avg_stance_time) AS avg_stance_time,
        avg_vertical_osc,
        avg_speed,
        total_distance
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        ${rangeFilter}
        AND canonical_type IN {runningTypes:Array(String)}
        AND (avg_cadence IS NOT NULL OR avg_stride_length IS NOT NULL
          OR avg_ground_contact_time IS NOT NULL OR avg_stance_time IS NOT NULL OR avg_vertical_osc IS NOT NULL)
      ORDER BY started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        runningTypes: [...RUNNING_TYPES],
      },
    );

    const visibleRows = await activityRepositoryFor(
      this.#db,
      this.#userId,
    ).filterToVisibleActivities(rows, (row) => row.activity_id);

    return visibleRows.map(
      (row) =>
        new RunningDynamicsActivity({
          activityId: row.activity_id,
          date: row.date,
          activityName: row.name ?? formatActivityTypeLabel("running"),
          avgCadence: row.avg_cadence,
          cadenceBasis: row.cadence_basis,
          cadenceObservedSeconds: row.cadence_observed_seconds,
          cadenceCoveragePercent: row.cadence_coverage_percent,
          avgStrideLengthMeters: row.avg_stride_length,
          avgStanceTimeMs: row.avg_stance_time,
          avgVerticalOscillationMm: row.avg_vertical_osc,
          avgSpeed: row.avg_speed,
          totalDistance: row.total_distance,
        }),
    );
  }

  /** Pace trend per running activity: average pace, distance, duration. */
  async getPaceTrend(days: RangeDays): Promise<PaceTrendActivity[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "started_at");
    const rows = await this.#sensorStore.query(
      paceTrendRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS date,
        name,
        avg_speed,
        total_distance,
        toInt32(dateDiff('second', started_at, ended_at)) AS duration_seconds
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        ${rangeFilter}
        AND canonical_type IN {runningTypes:Array(String)}
        AND avg_speed > 0
        AND ended_at IS NOT NULL
      ORDER BY started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...rangeDaysParams(days),
        runningTypes: [...RUNNING_TYPES],
      },
    );

    const visibleRows = await activityRepositoryFor(
      this.#db,
      this.#userId,
    ).filterToVisibleActivities(rows, (row) => row.activity_id);

    return visibleRows.map(
      (row) =>
        new PaceTrendActivity({
          date: row.date,
          activityName: row.name?.trim() || formatActivityTypeLabel("running"),
          avgSpeed: row.avg_speed,
          totalDistance: row.total_distance,
          durationSeconds: row.duration_seconds,
        }),
    );
  }
}
