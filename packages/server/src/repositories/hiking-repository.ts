import { computeGradeAdjustedPace } from "@dofek/training/grade-adjusted-pace";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

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

export interface RouteInstance {
  date: string;
  durationMinutes: number;
  averagePaceMinPerKm: number;
  avgHeartRate: number | null;
  elevationGainMeters: number;
}

/** A named route (trail, walk) repeated multiple times for comparison. */
export class RepeatedRoute {
  readonly #name: string;
  readonly #instances: RouteInstance[];

  constructor(name: string, instances: RouteInstance[]) {
    this.#name = name;
    this.#instances = instances;
  }

  toDetail() {
    return {
      activityName: this.#name,
      instances: this.#instances,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const gradeRowSchema = z.object({
  activity_id: z.string(),
  date: dateStringSchema,
  activity_name: z.string(),
  activity_type: z.string(),
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
  activity_name: z.string(),
  date: dateStringSchema,
  duration_minutes: z.coerce.number(),
  average_pace_min_per_km: z.coerce.number(),
  avg_heart_rate: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for hiking, walking, and trail running analytics. */
export class HikingRepository {
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

  /** Grade-adjusted pace for walking/hiking/trail running activities. */
  async getGradeAdjustedPaces(days: number): Promise<HikingActivity[]> {
    const rows = await this.#sensorStore.query(
      gradeRowSchema,
      `SELECT
        toString(asum.activity_id) AS activity_id,
        toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
        asum.name AS activity_name,
        asum.activity_type,
        round(asum.total_distance, 1) AS distance_m,
        toFloat64(dateDiff('second', asum.started_at, asum.ended_at)) AS duration_seconds,
        round(asum.elevation_gain_m, 1) AS elevation_gain_m,
        round(asum.elevation_loss_m, 1) AS elevation_loss_m,
        if(asum.total_distance > 0,
           round((asum.elevation_gain_m - asum.elevation_loss_m) / asum.total_distance * 100, 4),
           0) AS avg_grade
      FROM analytics.activity_summary asum
      INNER JOIN analytics.v_activity va
        ON va.id = asum.activity_id
       AND va.user_id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.activity_type IN ('walking', 'hiking', 'trail_running')
        AND asum.total_distance > 0
        AND asum.ended_at IS NOT NULL
        AND dateDiff('second', asum.started_at, asum.ended_at) > 0
      ORDER BY asum.started_at`,
      { userId: this.#userId, timezone: this.#timezone, days },
    );

    return rows.map(
      (row) =>
        new HikingActivity({
          activityId: row.activity_id,
          date: String(row.date),
          activityName: String(row.activity_name),
          activityType: String(row.activity_type),
          distanceMeters: Number(row.distance_m),
          durationSeconds: Number(row.duration_seconds),
          elevationGainMeters: Number(row.elevation_gain_m),
          elevationLossMeters: Number(row.elevation_loss_m),
          averageGradePercent: Number(row.avg_grade),
        }),
    );
  }

  /** Weekly cumulative elevation gain from hiking and walking activities. */
  async getElevationProfile(days: number): Promise<ElevationWeek[]> {
    const rows = await this.#sensorStore.query(
      elevationRowSchema,
      `SELECT
        toString(toMonday(toDate(toTimeZone(asum.started_at, {timezone:String})))) AS week,
        round(sum(asum.elevation_gain_m), 1) AS elevation_gain_m,
        toInt32(count()) AS activity_count,
        round(sum(asum.total_distance / 1000.0), 2) AS total_distance_km
      FROM analytics.activity_summary asum
      INNER JOIN analytics.v_activity va
        ON va.id = asum.activity_id
       AND va.user_id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        AND asum.started_at > now() - INTERVAL {days:Int32} DAY
        AND asum.activity_type IN ('walking', 'hiking')
      GROUP BY week
      ORDER BY week`,
      { userId: this.#userId, timezone: this.#timezone, days },
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
  async getWalkingBiomechanics(days: number): Promise<WalkingBiomechanicsSnapshot[]> {
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
            AND date > NOW() - ${days}::int * INTERVAL '1 day'
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

  /** Named routes (trails, walks) that have been repeated 2+ times. */
  async getRepeatedRoutes(days: number): Promise<RepeatedRoute[]> {
    const rows = await this.#sensorStore.query(
      comparisonRowSchema,
      `WITH activity_data AS (
        SELECT
          asum.name AS activity_name,
          toString(toDate(toTimeZone(asum.started_at, {timezone:String}))) AS date,
          round(dateDiff('second', asum.started_at, asum.ended_at) / 60.0, 1) AS duration_minutes,
          if(asum.total_distance > 0,
             round((dateDiff('second', asum.started_at, asum.ended_at) / 60.0) / (asum.total_distance / 1000.0), 2),
             0) AS average_pace_min_per_km,
          round(asum.avg_hr, 1) AS avg_heart_rate,
          round(asum.elevation_gain_m, 1) AS elevation_gain_m
        FROM analytics.activity_summary asum
        INNER JOIN analytics.v_activity va
          ON va.id = asum.activity_id
         AND va.user_id = asum.user_id
        WHERE asum.user_id = {userId:UUID}
          AND asum.started_at > now() - INTERVAL {days:Int32} DAY
          AND asum.activity_type IN ('walking', 'hiking', 'trail_running')
          AND asum.name IS NOT NULL
          AND asum.ended_at IS NOT NULL
      ),
      repeated_names AS (
        SELECT activity_name
        FROM activity_data
        GROUP BY activity_name
        HAVING count() >= 2
      )
      SELECT
        d.activity_name AS activity_name,
        d.date AS date,
        d.duration_minutes AS duration_minutes,
        d.average_pace_min_per_km AS average_pace_min_per_km,
        d.avg_heart_rate AS avg_heart_rate,
        d.elevation_gain_m AS elevation_gain_m
      FROM activity_data d
      INNER JOIN repeated_names rn ON rn.activity_name = d.activity_name
      ORDER BY d.activity_name, d.date`,
      { userId: this.#userId, timezone: this.#timezone, days },
    );

    const grouped = new Map<string, RouteInstance[]>();
    for (const row of rows) {
      const name = String(row.activity_name);
      let group = grouped.get(name);
      if (!group) {
        group = [];
        grouped.set(name, group);
      }
      group.push({
        date: String(row.date),
        durationMinutes: Number(row.duration_minutes),
        averagePaceMinPerKm: Number(row.average_pace_min_per_km),
        avgHeartRate: row.avg_heart_rate != null ? Number(row.avg_heart_rate) : null,
        elevationGainMeters: Math.round(Number(row.elevation_gain_m)),
      });
    }

    const result: RepeatedRoute[] = [];
    for (const [name, instances] of grouped) {
      result.push(new RepeatedRoute(name, instances));
    }
    return result;
  }
}
