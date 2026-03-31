import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { bodyWeightDedupCte } from "../lib/sql-fragments.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
// ── Types ───────────────────────────────────────────────────────────

export interface SmoothedWeightRow {
  date: string;
  rawWeight: number;
  smoothedWeight: number;
  weeklyChange: number | null;
}

export interface BodyRecompositionRow {
  date: string;
  weightKg: number;
  bodyFatPct: number;
  fatMassKg: number;
  leanMassKg: number;
  smoothedFatMass: number;
  smoothedLeanMass: number;
}

export interface WeightRateOfChange {
  currentWeekly: number | null;
  current4Week: number | null;
  trend: "gaining" | "losing" | "stable" | "insufficient";
}

// ── Zod schemas for raw DB rows ─────────────────────────────────────

const weightRowSchema = z.object({
  date: dateStringSchema,
  weight_kg: z.coerce.number(),
});

const recompositionRowSchema = z.object({
  date: dateStringSchema,
  weight_kg: z.coerce.number(),
  body_fat_pct: z.coerce.number(),
});

// ── EWMA helper ─────────────────────────────────────────────────────

/** Apply exponentially-weighted moving average to a series of values. */
export function ewmaSmooth(values: number[], alpha: number): number[] {
  const smoothed: number[] = [];
  let current = values[0];
  if (current === undefined) return [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === undefined) continue;
    if (index === 0) {
      current = value;
    } else {
      current = alpha * value + (1 - alpha) * current;
    }
    smoothed.push(current);
  }
  return smoothed;
}

// ── Repository ──────────────────────────────────────────────────────

/** Data access and analytics for body weight/composition trends. */
export class BodyAnalyticsRepository extends BaseRepository {
  /**
   * Smoothed weight trend using exponentially-weighted moving average.
   * Filters out daily fluctuations (water, food timing) to show the
   * real trend. Similar to MacroFactor / Happy Scale approach.
   */
  async getSmoothedWeight(days: number, endDate: string): Promise<SmoothedWeightRow[]> {
    const rows = await this.query(
      weightRowSchema,
      sql`WITH ${bodyWeightDedupCte(this.userId, this.timezone, endDate, days)}
          SELECT date, weight_kg
          FROM weight_deduped
          ORDER BY date ASC`,
    );

    const data = rows.map((row) => ({
      date: row.date,
      rawWeight: Number(row.weight_kg),
    }));

    return this.#computeSmoothedWeight(data);
  }

  /**
   * Body recomposition: fat mass vs lean mass trends.
   * Derives fat mass (weight * body_fat_pct) and lean mass (weight - fat mass)
   * from measurements that have both weight and body fat data.
   */
  async getRecomposition(days: number, endDate: string): Promise<BodyRecompositionRow[]> {
    const rows = await this.query(
      recompositionRowSchema,
      sql`WITH ${bodyWeightDedupCte(this.userId, this.timezone, endDate, days, sql`AND body_fat_pct IS NOT NULL`)}
          SELECT date, weight_kg, body_fat_pct
          FROM weight_deduped
          ORDER BY date ASC`,
    );

    const data = rows.map((row) => ({
      date: row.date,
      weightKg: Number(row.weight_kg),
      bodyFatPct: Number(row.body_fat_pct),
    }));

    return this.#computeRecomposition(data);
  }

  /**
   * Weight rate of change summary.
   * Current weekly and 4-week rates, plus overall trend direction.
   */
  async getWeightTrend(): Promise<WeightRateOfChange> {
    const rows = await this.query(
      weightRowSchema,
      sql`WITH ${bodyWeightDedupCte(this.userId, this.timezone, "now", 35)}
          SELECT date, weight_kg
          FROM weight_deduped
          ORDER BY date ASC`,
    );

    const weights = rows.map((row) => Number(row.weight_kg));
    return this.#computeWeightTrend(weights);
  }

  // ── Private computation methods ─────────────────────────────────

  #computeSmoothedWeight(data: { date: string; rawWeight: number }[]): SmoothedWeightRow[] {
    if (data.length === 0) return [];

    const alpha = 0.1;
    const smoothedValues = ewmaSmooth(
      data.map((day) => day.rawWeight),
      alpha,
    );

    const result: SmoothedWeightRow[] = [];
    for (let index = 0; index < data.length; index++) {
      const day = data[index];
      const smoothed = smoothedValues[index];
      if (!day || smoothed === undefined) continue;

      // Weekly rate of change: compare smoothed weight to 7 days ago
      let weeklyChange: number | null = null;
      if (index >= 7) {
        const previousSmoothed = smoothedValues[index - 7];
        if (previousSmoothed !== undefined) {
          weeklyChange = Math.round((smoothed - previousSmoothed) * 100) / 100;
        }
      }

      result.push({
        date: day.date,
        rawWeight: Math.round(day.rawWeight * 100) / 100,
        smoothedWeight: Math.round(smoothed * 100) / 100,
        weeklyChange,
      });
    }

    return result;
  }

  #computeRecomposition(
    data: { date: string; weightKg: number; bodyFatPct: number }[],
  ): BodyRecompositionRow[] {
    if (data.length === 0) return [];

    const alpha = 0.15;
    const fatMasses = data.map((day) => day.weightKg * (day.bodyFatPct / 100));
    const leanMasses = data.map((day, index) => day.weightKg - (fatMasses[index] ?? 0));

    const smoothedFatValues = ewmaSmooth(fatMasses, alpha);
    const smoothedLeanValues = ewmaSmooth(leanMasses, alpha);

    const result: BodyRecompositionRow[] = [];
    for (let index = 0; index < data.length; index++) {
      const day = data[index];
      const fatMass = fatMasses[index];
      const leanMass = leanMasses[index];
      const smoothedFat = smoothedFatValues[index];
      const smoothedLean = smoothedLeanValues[index];
      if (
        !day ||
        fatMass === undefined ||
        leanMass === undefined ||
        smoothedFat === undefined ||
        smoothedLean === undefined
      )
        continue;

      result.push({
        date: day.date,
        weightKg: Math.round(day.weightKg * 100) / 100,
        bodyFatPct: Math.round(day.bodyFatPct * 10) / 10,
        fatMassKg: Math.round(fatMass * 100) / 100,
        leanMassKg: Math.round(leanMass * 100) / 100,
        smoothedFatMass: Math.round(smoothedFat * 100) / 100,
        smoothedLeanMass: Math.round(smoothedLean * 100) / 100,
      });
    }

    return result;
  }

  #computeWeightTrend(weights: number[]): WeightRateOfChange {
    if (weights.length < 7) {
      return { currentWeekly: null, current4Week: null, trend: "insufficient" };
    }

    const smoothed = ewmaSmooth(weights, 0.1);
    const latest = smoothed[smoothed.length - 1];
    if (latest === undefined) {
      return { currentWeekly: null, current4Week: null, trend: "insufficient" };
    }

    const oneWeekAgo = smoothed.length >= 8 ? (smoothed[smoothed.length - 8] ?? null) : null;
    const fourWeeksAgo = smoothed.length >= 29 ? (smoothed[smoothed.length - 29] ?? null) : null;

    const currentWeekly = oneWeekAgo != null ? Math.round((latest - oneWeekAgo) * 100) / 100 : null;
    const current4Week =
      fourWeeksAgo != null ? Math.round((latest - fourWeeksAgo) * 100) / 100 : null;

    const changeReference = currentWeekly ?? current4Week;
    let trend: WeightRateOfChange["trend"] = "stable";
    if (changeReference != null) {
      if (changeReference > 0.1) trend = "gaining";
      else if (changeReference < -0.1) trend = "losing";
    }

    return { currentWeekly, current4Week, trend };
  }
}
