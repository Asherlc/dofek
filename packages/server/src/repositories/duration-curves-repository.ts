import { DURATION_LABELS, linearRegression } from "@dofek/training/power-analysis";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { enduranceTypeFilter } from "../lib/endurance-types.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ── Zod schemas for DB results ───────────────────────────────

const hrCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_hr: z.coerce.number(),
  activity_date: dateStringSchema,
});

const paceCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_pace: z.coerce.number(),
  activity_date: dateStringSchema,
});

// ── Domain types ─────────────────────────────────────────────

export interface CriticalHeartRateModel {
  thresholdHr: number;
  r2: number;
}

export interface HrCurvePoint {
  durationSeconds: number;
  label: string;
  bestHeartRate: number;
  activityDate: string;
}

export interface PaceCurvePoint {
  durationSeconds: number;
  label: string;
  bestPaceSecondsPerKm: number;
  activityDate: string;
}

// ── Critical Heart Rate fitting ──────────────────────────────

/**
 * Fit a Critical Heart Rate model from HR duration curve data.
 *
 * Model: HR(t) = thresholdHr + reserve / t
 * Analogous to Critical Power: longer durations converge on threshold HR.
 * Linearized: HR * t = thresholdHr * t + reserve
 * Linear regression of (HR*t) vs t gives slope = thresholdHr.
 *
 * Only uses durations >= 120s where the aerobic system dominates.
 */
export function fitCriticalHeartRate(
  points: { durationSeconds: number; bestHeartRate: number }[],
): CriticalHeartRateModel | null {
  const valid = points.filter((p) => p.durationSeconds >= 120 && p.bestHeartRate > 0);
  if (valid.length < 3) return null;

  const xs = valid.map((p) => p.durationSeconds);
  const ys = valid.map((p) => p.bestHeartRate * p.durationSeconds);

  const { slope: thresholdHr, r2 } = linearRegression(xs, ys);

  if (thresholdHr <= 0) return null;

  return {
    thresholdHr: Math.round(thresholdHr),
    r2: Math.round(r2 * 1000) / 1000,
  };
}

// ── Repository ───────────────────────────────────────────────

export class DurationCurvesRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /**
   * Heart Rate Duration Curve: best sustained HR for standard durations.
   * Uses cumulative sums over metric_stream heart_rate, same approach as power curves.
   */
  async getHrCurve(days: number): Promise<{
    points: HrCurvePoint[];
    model: CriticalHeartRateModel | null;
  }> {
    const rows = await executeWithSchema(
      this.#db,
      hrCurveRowSchema,
      sql`
			WITH activity_hr AS (
			  SELECT ms.activity_id, ms.recorded_at, ms.heart_rate,
			         (a.started_at AT TIME ZONE ${this.#timezone})::date AS activity_date,
			         ROW_NUMBER() OVER (
			           PARTITION BY ms.activity_id ORDER BY ms.recorded_at
			         ) AS rn,
			         SUM(ms.heart_rate) OVER (
			           PARTITION BY ms.activity_id ORDER BY ms.recorded_at
			           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			         ) AS cumsum
			  FROM fitness.metric_stream ms
			  JOIN fitness.v_activity a ON a.id = ms.activity_id
			  WHERE a.user_id = ${this.#userId}
			    AND ms.heart_rate IS NOT NULL
			    AND ms.heart_rate > 0
			    AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
			    AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
			    AND ${enduranceTypeFilter("a")}
			),
			sample_rate AS (
			  SELECT activity_id,
			         GREATEST(ROUND(
			           EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
			           / NULLIF(COUNT(*) - 1, 0)
			         )::int, 1) AS interval_s
			  FROM activity_hr
			  GROUP BY activity_id
			  HAVING COUNT(*) > 1
			),
			durations AS (
			  SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
			),
			best_per_duration AS (
			  SELECT
			    d.duration_s AS duration_seconds,
			    MAX(
			      (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s)
			    )::int AS best_hr,
			    (ARRAY_AGG(
			      ap.activity_date::text ORDER BY
			      (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s) DESC
			    ))[1] AS activity_date
			  FROM durations d
			  CROSS JOIN activity_hr ap
			  JOIN sample_rate sr ON sr.activity_id = ap.activity_id
			  LEFT JOIN activity_hr prev
			    ON prev.activity_id = ap.activity_id
			    AND prev.rn = ap.rn - ROUND(d.duration_s::numeric / sr.interval_s)::int
			  WHERE ap.rn >= ROUND(d.duration_s::numeric / sr.interval_s)::int
			  GROUP BY d.duration_s
			)
			SELECT duration_seconds, best_hr, activity_date
			FROM best_per_duration
			WHERE best_hr > 0
			ORDER BY duration_seconds
		`,
    );

    const results = rows.map((r) => ({
      durationSeconds: Number(r.duration_seconds),
      label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
      bestHeartRate: Number(r.best_hr),
      activityDate: String(r.activity_date),
    }));

    return {
      points: results,
      model: fitCriticalHeartRate(results),
    };
  }

  /**
   * Pace Duration Curve: best sustained pace for standard durations.
   * Uses speed (m/s) from metric_stream, converts to pace (s/km) for output.
   * Higher speed = better pace (lower s/km), so we want MAX average speed.
   */
  async getPaceCurve(days: number): Promise<{ points: PaceCurvePoint[] }> {
    const rows = await executeWithSchema(
      this.#db,
      paceCurveRowSchema,
      sql`
			WITH activity_speed AS (
			  SELECT ms.activity_id, ms.recorded_at, ms.speed,
			         (a.started_at AT TIME ZONE ${this.#timezone})::date AS activity_date,
			         ROW_NUMBER() OVER (
			           PARTITION BY ms.activity_id ORDER BY ms.recorded_at
			         ) AS rn,
			         SUM(ms.speed) OVER (
			           PARTITION BY ms.activity_id ORDER BY ms.recorded_at
			           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			         ) AS cumsum
			  FROM fitness.metric_stream ms
			  JOIN fitness.v_activity a ON a.id = ms.activity_id
			  WHERE a.user_id = ${this.#userId}
			    AND ms.speed IS NOT NULL
			    AND ms.speed > 0
			    AND a.started_at > NOW() - ${days}::int * INTERVAL '1 day'
			    AND ms.recorded_at > NOW() - (${days} + 1)::int * INTERVAL '1 day'
			    AND ${enduranceTypeFilter("a")}
			),
			sample_rate AS (
			  SELECT activity_id,
			         GREATEST(ROUND(
			           EXTRACT(EPOCH FROM MAX(recorded_at) - MIN(recorded_at))::numeric
			           / NULLIF(COUNT(*) - 1, 0)
			         )::int, 1) AS interval_s
			  FROM activity_speed
			  GROUP BY activity_id
			  HAVING COUNT(*) > 1
			),
			durations AS (
			  SELECT unnest(ARRAY[5,15,30,60,120,300,600,1200,1800,3600,5400,7200]) AS duration_s
			),
			best_per_duration AS (
			  SELECT
			    d.duration_s AS duration_seconds,
			    MAX(
			      (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s)
			    ) AS best_speed_ms,
			    (ARRAY_AGG(
			      ap.activity_date::text ORDER BY
			      (ap.cumsum - COALESCE(prev.cumsum, 0))::numeric / ROUND(d.duration_s::numeric / sr.interval_s) DESC
			    ))[1] AS activity_date
			  FROM durations d
			  CROSS JOIN activity_speed ap
			  JOIN sample_rate sr ON sr.activity_id = ap.activity_id
			  LEFT JOIN activity_speed prev
			    ON prev.activity_id = ap.activity_id
			    AND prev.rn = ap.rn - ROUND(d.duration_s::numeric / sr.interval_s)::int
			  WHERE ap.rn >= ROUND(d.duration_s::numeric / sr.interval_s)::int
			  GROUP BY d.duration_s
			)
			SELECT
			  duration_seconds,
			  ROUND((1000.0 / NULLIF(best_speed_ms, 0))::numeric, 1) AS best_pace,
			  activity_date
			FROM best_per_duration
			WHERE best_speed_ms > 0
			ORDER BY duration_seconds
		`,
    );

    const results = rows.map((r) => ({
      durationSeconds: Number(r.duration_seconds),
      label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
      bestPaceSecondsPerKm: Number(r.best_pace),
      activityDate: String(r.activity_date),
    }));

    return { points: results };
  }
}
