import { DURATION_LABELS, linearRegression } from "@dofek/training/power-analysis";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ── Zod schemas for DB results ───────────────────────────────

const hrCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_hr: z.coerce.number(),
  activity_date: z.string(),
});

const paceCurveRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_pace: z.coerce.number(),
  activity_date: z.string(),
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
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore?: ActivitySensorStore;

  constructor(userId: string, timezone: string, sensorStore?: ActivitySensorStore) {
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  #requireSensorStore(): ActivitySensorStore {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for duration curves");
    }
    return this.#sensorStore;
  }

  /**
   * Heart Rate Duration Curve: best sustained HR for standard durations.
   * Uses cumulative sums over metric_stream heart_rate, same approach as power curves.
   */
  async getHrCurve(days: number): Promise<{
    points: HrCurvePoint[];
    model: CriticalHeartRateModel | null;
  }> {
    const rows = await this.#requireSensorStore()
      .getHeartRateCurveRows(days, this.#userId, this.#timezone)
      .then((curveRows) => curveRows.map((row) => hrCurveRowSchema.parse(row)));

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
    const rows = await this.#requireSensorStore()
      .getPaceCurveRows(days, this.#userId, this.#timezone)
      .then((curveRows) => curveRows.map((row) => paceCurveRowSchema.parse(row)));

    const results = rows.map((r) => ({
      durationSeconds: Number(r.duration_seconds),
      label: DURATION_LABELS[Number(r.duration_seconds)] ?? `${r.duration_seconds}s`,
      bestPaceSecondsPerKm: Number(r.best_pace),
      activityDate: String(r.activity_date),
    }));

    return { points: results };
  }
}
