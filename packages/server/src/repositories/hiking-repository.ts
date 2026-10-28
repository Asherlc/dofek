import { computeGradeAdjustedPace } from "@dofek/training/grade-adjusted-pace";
import type { RouteComparison } from "@dofek/training/route-comparison";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ChartRange } from "../lib/chart-range.ts";
import {
  clickHouseIntervalDayLowerBound,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { groupEquivalentRoutes } from "./route-equivalence.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface HikingActivityRow {
  activityId: string;
  date: string;
  activityName: string;
  activityType: string;
  distanceMeters: number;
  durationSeconds: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  /** Average grade as a percentage (e.g. 4 = 4%). */
  averageGradePercent: number;
}

/** A walking, hiking, or trail running activity with grade-adjusted pace. */
export class HikingActivity {
  readonly row: HikingActivityRow;

  constructor(row: HikingActivityRow) {
    this.row = row;
  }

  get date(): string {
    return this.row.date;
  }

  get activityId(): string {
    return this.row.activityId;
  }

  get activityName(): string {
    return this.row.activityName;
  }

  get activityType(): string {
    return this.row.activityType;
  }

  get distanceKm(): number {
    return this.row.distanceMeters / 1000;
  }

  get durationMinutes(): number {
    return this.row.durationSeconds / 60;
  }

  get averagePaceMinPerKm(): number {
    return this.distanceKm > 0 ? this.durationMinutes / this.distanceKm : 0;
  }

  get gradeAdjustedPaceMinPerKm(): number {
    const gradeFraction = this.row.averageGradePercent / 100;
    return computeGradeAdjustedPace(this.averagePaceMinPerKm, gradeFraction);
  }

  get elevationGainMeters(): number {
    return this.row.elevationGainMeters;
  }

  get elevationLossMeters(): number {
    return this.row.elevationLossMeters;
  }

  toDetail() {
    return {
      activityId: this.activityId,
      date: this.date,
      activityName: this.activityName,
      activityType: this.activityType,
      distanceKm: Math.round(this.distanceKm * 100) / 100,
      durationMinutes: Math.round(this.durationMinutes * 10) / 10,
      averagePaceMinPerKm: Math.round(this.averagePaceMinPerKm * 100) / 100,
      gradeAdjustedPaceMinPerKm: Math.round(this.gradeAdjustedPaceMinPerKm * 100) / 100,
      elevationGainMeters: Math.round(this.elevationGainMeters),
      elevationLossMeters: Math.round(this.elevationLossMeters),
    };
  }
}

export interface ElevationWeekRow {
  week: string;
  elevationGainMeters: number;
  activityCount: number;
  totalDistanceKm: number;
}

/** Weekly elevation summary for hiking/walking activities. */
export class ElevationWeek {
  readonly #row: ElevationWeekRow;

  constructor(row: ElevationWeekRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      week: this.#row.week,
      elevationGainMeters: this.#row.elevationGainMeters,
      activityCount: this.#row.activityCount,
      totalDistanceKm: this.#row.totalDistanceKm,
    };
  }
}

export interface WalkingBiomechanicsRow {
  date: string;
  /** Walking speed in meters per second (raw from sensor). */
  walkingSpeedMps: number | null;
  stepLengthCm: number | null;
  doubleSupportPct: number | null;
  asymmetryPct: number | null;
  steadiness: number | null;
}

/** Daily walking biomechanics snapshot (gait analysis). */
export class WalkingBiomechanicsSnapshot {
  readonly #row: WalkingBiomechanicsRow;

  constructor(row: WalkingBiomechanicsRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      walkingSpeedKmh:
        this.#row.walkingSpeedMps != null
          ? Math.round(this.#row.walkingSpeedMps * 3.6 * 100) / 100
          : null,
      stepLengthCm: this.#row.stepLengthCm,
      doubleSupportPct: this.#row.doubleSupportPct,
      asymmetryPct: this.#row.asymmetryPct,
      steadiness: this.#row.steadiness,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const gradeRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  activity_name: z.string().nullable(),
  canonical_type: z.string(),
  distance_m: z.coerce.number(),
  duration_seconds: z.coerce.number(),
  elevation_gain_m: z.coerce.number(),
  elevation_loss_m: z.coerce.number(),
  avg_grade: z.coerce.number(),
});

const elevationRowSchema = z.object({
  week: dateStringSchema,
  elevation_gain_m: z.coerce.number(),
  activity_count: z.coerce.number(),
  total_distance_km: z.coerce.number(),
});

const biomechanicsRowSchema = z.object({
  date: dateStringSchema,
  walking_speed: z.coerce.number().nullable(),
  step_length: z.coerce.number().nullable(),
  double_support_pct: z.coerce.number().nullable(),
  asymmetry_pct: z.coerce.number().nullable(),
  steadiness: z.coerce.number().nullable(),
});

const comparisonRowSchema = z.object({
  canonical_activity_id: z.uuid(),
  canonical_type: z.string(),
  modality: z.string().nullable(),
  activity_name: z.string().nullable(),
  started_at: timestampStringSchema,
  date: dateStringSchema,
  distance_m: z.coerce.number(),
  duration_minutes: z.coerce.number(),
  average_pace_min_per_km: z.coerce.number(),
  avg_heart_rate: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number(),
  points: z.array(z.tuple([z.number(), z.number()])).max(64),
  route_distance_meters: z.number().nullable(),
  elevation_profile: z.array(z.number()),
  geometry_status: z.enum(["available", "partial", "unavailable"]),
  coverage_pct: z.number().nullable(),
  largest_gap_seconds: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for hiking, walking, and trail running analytics. */
export class HikingRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /** Grade-adjusted pace for walking/hiking/trail running activities. */
  async getGradeAdjustedPaces(days: RangeDays): Promise<HikingActivity[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "hiking.started_at");
    const rows = await this.#sensorStore.query(
      gradeRowSchema,
      `SELECT
        toString(hiking.activity_id) AS activity_id,
        toString(toDate(toTimeZone(hiking.started_at, {timezone:String}))) AS date,
        hiking.activity_name AS activity_name,
        hiking.canonical_type AS canonical_type,
        hiking.distance_m AS distance_m,
        hiking.duration_seconds AS duration_seconds,
        hiking.elevation_gain_m AS elevation_gain_m,
        hiking.elevation_loss_m AS elevation_loss_m,
        hiking.average_grade_percent AS avg_grade
      FROM analytics.hiking_activity AS hiking FINAL
      WHERE hiking.user_id = {userId:UUID}
        AND hiking.is_deleted = 0
        ${rangeFilter}
        AND hiking.canonical_type IN ('walking', 'hiking', 'running')
        AND hiking.distance_m > 0
        AND hiking.duration_seconds > 0
      ORDER BY hiking.started_at`,
      { userId: this.#userId, timezone: this.#timezone, ...rangeDaysParams(days) },
    );

    return rows.map(
      (row) =>
        new HikingActivity({
          activityId: row.activity_id,
          date: String(row.date),
          activityName: row.activity_name ?? formatActivityTypeLabel(row.canonical_type),
          activityType: String(row.canonical_type),
          distanceMeters: Number(row.distance_m),
          durationSeconds: Number(row.duration_seconds),
          elevationGainMeters: Number(row.elevation_gain_m),
          elevationLossMeters: Number(row.elevation_loss_m),
          averageGradePercent: Number(row.avg_grade),
        }),
    );
  }

  /** Weekly cumulative elevation gain from hiking and walking activities. */
  async getElevationProfile(days: RangeDays): Promise<ElevationWeek[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "hiking.started_at");
    const rows = await this.#sensorStore.query(
      elevationRowSchema,
      `SELECT
        toString(toMonday(toDate(toTimeZone(hiking.started_at, {timezone:String})))) AS week,
        round(sum(hiking.elevation_gain_m), 1) AS elevation_gain_m,
        toInt32(count()) AS activity_count,
        round(sum(hiking.distance_m / 1000.0), 2) AS total_distance_km
      FROM analytics.hiking_activity AS hiking FINAL
      WHERE hiking.user_id = {userId:UUID}
        AND hiking.is_deleted = 0
        ${rangeFilter}
        AND hiking.canonical_type IN ('walking', 'hiking')
      GROUP BY week
      ORDER BY week`,
      { userId: this.#userId, timezone: this.#timezone, ...rangeDaysParams(days) },
    );

    return rows.map(
      (row) =>
        new ElevationWeek({
          week: String(row.week),
          elevationGainMeters: Number(row.elevation_gain_m),
          activityCount: Number(row.activity_count),
          totalDistanceKm: Number(row.total_distance_km),
        }),
    );
  }

  /** Walking biomechanics from daily health metrics. */
  async getWalkingBiomechanics(days: RangeDays): Promise<WalkingBiomechanicsSnapshot[]> {
    const rangeFilter = ChartRange.fromDays(days).postgresTimestampAfterNow(sql`date`);
    const rows = await executeWithSchema(
      this.#db,
      biomechanicsRowSchema,
      sql`SELECT
            date::text,
            walking_speed,
            walking_step_length AS step_length,
            walking_double_support_pct AS double_support_pct,
            walking_asymmetry_pct AS asymmetry_pct,
            walking_steadiness AS steadiness
          FROM fitness.daily_metrics
          WHERE user_id = ${this.#userId}
            ${rangeFilter}
            AND (walking_speed IS NOT NULL
              OR walking_step_length IS NOT NULL
              OR walking_double_support_pct IS NOT NULL
              OR walking_asymmetry_pct IS NOT NULL
              OR walking_steadiness IS NOT NULL)
          ORDER BY date`,
    );

    return rows.map(
      (row) =>
        new WalkingBiomechanicsSnapshot({
          date: String(row.date),
          walkingSpeedMps: row.walking_speed != null ? Number(row.walking_speed) : null,
          stepLengthCm: row.step_length != null ? Number(row.step_length) : null,
          doubleSupportPct: row.double_support_pct != null ? Number(row.double_support_pct) : null,
          asymmetryPct: row.asymmetry_pct != null ? Number(row.asymmetry_pct) : null,
          steadiness: row.steadiness != null ? Number(row.steadiness) : null,
        }),
    );
  }

  /** Repeated GPS routes, using the same bounded matcher as effort discovery. */
  async getRepeatedRoutes(days: RangeDays): Promise<RouteComparison[]> {
    const rangeFilter = clickHouseIntervalDayLowerBound(days, "hiking.started_at");
    const rows = await this.#sensorStore.query(
      comparisonRowSchema,
      `SELECT
        hiking.activity_id AS canonical_activity_id,
        hiking.canonical_type AS canonical_type,
        activity.modality AS modality,
        hiking.activity_name AS activity_name,
        formatDateTime(hiking.started_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        toString(toDate(toTimeZone(hiking.started_at, {timezone:String}))) AS date,
        hiking.distance_m AS distance_m,
        hiking.duration_seconds / 60.0 AS duration_minutes,
        hiking.average_pace_min_per_km AS average_pace_min_per_km,
        hiking.avg_heart_rate AS avg_heart_rate,
        hiking.elevation_gain_m AS elevation_gain_m,
        arrayMap(point -> [point.1, point.2], route.points) AS points,
        route.route_distance_meters AS route_distance_meters,
        route.elevation_profile AS elevation_profile,
        route.geometry_status AS geometry_status,
        route.coverage_pct AS coverage_pct,
        route.largest_gap_seconds AS largest_gap_seconds
      FROM analytics.hiking_activity AS hiking FINAL
      INNER JOIN analytics.deduped_activities AS activity FINAL
        ON activity.user_id = hiking.user_id AND activity.activity_id = hiking.activity_id
      INNER JOIN analytics.activity_route_identity AS route FINAL
        ON route.user_id = hiking.user_id AND route.canonical_activity_id = hiking.activity_id
      WHERE hiking.user_id = {userId:UUID}
        AND hiking.is_deleted = 0 AND activity.is_deleted = 0 AND route.is_deleted = 0
        ${rangeFilter}
        AND hiking.canonical_type IN ('walking', 'hiking', 'running')
        AND hiking.duration_seconds > 0
        AND route.geometry_status = 'available'
      ORDER BY hiking.activity_id
      LIMIT 251`,
      { userId: this.#userId, timezone: this.#timezone, ...rangeDaysParams(days) },
    );

    let groups: (typeof rows)[];
    try {
      groups = await groupEquivalentRoutes(
        rows,
        rows.map((row) => ({
          activity_id: row.canonical_activity_id,
          canonical_type: row.canonical_type,
          modality: row.modality,
        })),
      );
    } catch (error) {
      captureException(error);
      if (
        error instanceof Error &&
        (error.message === "Too many route candidates; narrow the date range or filters." ||
          error.message ===
            "Route grouping sampled-segment work limit exceeded: narrow the date range or filters.")
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "There are too many GPS routes to compare in this period. Choose a shorter date range and retry.",
          cause: error,
        });
      }
      throw error;
    }

    return groups
      .filter((group) => group.length >= 2)
      .map((group) => {
        const anchor = group[0];
        if (!anchor) throw new Error("Repeated GPS route has no anchor activity");
        const instances = group
          .map((row) => ({
            activityId: row.canonical_activity_id,
            activityName: row.activity_name ?? row.canonical_type,
            startedAt: row.started_at,
            date: row.date,
            distanceKm: row.distance_m > 0 ? row.distance_m / 1000 : null,
            durationMinutes: row.duration_minutes,
            averagePaceMinPerKm:
              row.distance_m > 0 && row.average_pace_min_per_km > 0
                ? row.average_pace_min_per_km
                : null,
            avgHeartRate: row.avg_heart_rate,
            elevationGainMeters: Math.round(row.elevation_gain_m),
          }))
          .sort(
            (a, b) =>
              a.startedAt.localeCompare(b.startedAt) || a.activityId.localeCompare(b.activityId),
          );
        return {
          routeId: anchor.canonical_activity_id,
          activityName: anchor.activity_name ?? anchor.canonical_type,
          activityType: anchor.canonical_type,
          attemptCount: instances.length,
          instances,
        };
      });
  }
}
