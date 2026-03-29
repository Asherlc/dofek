import { computeGradeAdjustedPace } from "@dofek/training/grade-adjusted-pace";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface HikingActivityRow {
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

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Grade-adjusted pace for walking/hiking/trail running activities. */
  async getGradeAdjustedPaces(days: number): Promise<HikingActivity[]> {
    const rows = await executeWithSchema(
      this.#db,
      gradeRowSchema,
      sql`SELECT
            (a.started_at AT TIME ZONE ${this.#timezone})::date::text AS date,
            a.name AS activity_name,
            a.activity_type,
            ROUND(asum.total_distance::numeric, 1) AS distance_m,
            ROUND(EXTRACT(EPOCH FROM (a.ended_at - a.started_at))::numeric, 1) AS duration_seconds,
            ROUND(asum.elevation_gain_m::numeric, 1) AS elevation_gain_m,
            ROUND(asum.elevation_loss_m::numeric, 1) AS elevation_loss_m,
            CASE WHEN asum.total_distance > 0
              THEN ROUND(((asum.elevation_gain_m - asum.elevation_loss_m) / asum.total_distance * 100)::numeric, 4)
              ELSE 0
            END AS avg_grade
          FROM fitness.v_activity a
          JOIN fitness.activity_summary asum ON asum.activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND a.activity_type IN ('walking', 'hiking', 'trail_running')
            AND asum.total_distance > 0
            AND EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) > 0
          ORDER BY a.started_at`,
    );

    return rows.map(
      (row) =>
        new HikingActivity({
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
    const rows = await executeWithSchema(
      this.#db,
      elevationRowSchema,
      sql`SELECT
            date_trunc('week', (a.started_at AT TIME ZONE ${this.#timezone})::date)::date::text AS week,
            ROUND(SUM(asum.elevation_gain_m)::numeric, 1) AS elevation_gain_m,
            COUNT(*)::int AS activity_count,
            ROUND(SUM(asum.total_distance / 1000.0)::numeric, 2) AS total_distance_km
          FROM fitness.v_activity a
          JOIN fitness.activity_summary asum ON asum.activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
            AND a.activity_type IN ('walking', 'hiking')
          GROUP BY 1
          ORDER BY week`,
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
    const rows = await executeWithSchema(
      this.#db,
      comparisonRowSchema,
      sql`WITH activity_data AS (
            SELECT
              a.name AS activity_name,
              (a.started_at AT TIME ZONE ${this.#timezone})::date AS date,
              ROUND((EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0)::numeric, 1) AS duration_minutes,
              CASE WHEN asum.total_distance > 0
                THEN ROUND(((EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0) / (asum.total_distance / 1000.0))::numeric, 2)
                ELSE 0
              END AS average_pace_min_per_km,
              ROUND(asum.avg_hr::numeric, 1) AS avg_heart_rate,
              ROUND(asum.elevation_gain_m::numeric, 1) AS elevation_gain_m
            FROM fitness.v_activity a
            JOIN fitness.activity_summary asum ON asum.activity_id = a.id
            WHERE a.user_id = ${this.#userId}
              AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
              AND a.activity_type IN ('walking', 'hiking', 'trail_running')
              AND a.name IS NOT NULL
          ),
          repeated_names AS (
            SELECT activity_name
            FROM activity_data
            GROUP BY activity_name
            HAVING COUNT(*) >= 2
          )
          SELECT
            d.activity_name,
            d.date::text,
            d.duration_minutes,
            d.average_pace_min_per_km,
            d.avg_heart_rate,
            d.elevation_gain_m
          FROM activity_data d
          JOIN repeated_names rn ON rn.activity_name = d.activity_name
          ORDER BY d.activity_name, d.date`,
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
