import { sql } from "drizzle-orm";
import { z } from "zod";
import { BaseRepository } from "../lib/base-repository.ts";
import { bodyWeightDedupCte } from "../lib/sql-fragments.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
// ── Types ───────────────────────────────────────────────────────────

export interface SmoothedWeightRow {
  date: string;
  /** Raw weight measurement in kg. Null for interpolated days. */
  rawWeight: number | null;
  smoothedWeight: number;
  weeklyChange: number | null;
  /** True when this day had no actual measurement and was linearly interpolated. */
  interpolated: boolean;
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

export interface WeightPrediction {
  /** Regression slope: kg per week over last 14 days of smoothed data */
  ratePerWeek: number | null;
  /** R-squared of the trend regression (0-1, higher = more consistent) */
  rateConfidence: number | null;
  /** Implied daily caloric surplus/deficit (7700 kcal/kg) */
  impliedDailyCalories: number | null;
  /** Period deltas: smoothed weight change over 7, 14, 30 days */
  periodDeltas: {
    days7: number | null;
    days14: number | null;
    days30: number | null;
  };
  /** Goal-related fields (null when no goal set) */
  goal: {
    goalWeightKg: number;
    remainingKg: number;
    estimatedDate: string | null;
    daysRemaining: number | null;
  } | null;
  /** Projection line: future smoothed weight points for chart rendering */
  projectionLine: Array<{ date: string; projectedWeight: number }>;
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

// ── Least-squares slope ─────────────────────────────────────────────

/**
 * Simple univariate least-squares linear regression.
 * Returns the slope (value change per day index unit) and R-squared.
 */
export function leastSquaresSlope(
  values: ReadonlyArray<{ dayIndex: number; value: number }>,
): { slopePerDay: number; rSquared: number } {
  const count = values.length;
  if (count <= 1) return { slopePerDay: 0, rSquared: 1 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of values) {
    sumX += point.dayIndex;
    sumY += point.value;
    sumXY += point.dayIndex * point.value;
    sumXX += point.dayIndex * point.dayIndex;
  }

  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) return { slopePerDay: 0, rSquared: 1 };

  const slope = (count * sumXY - sumX * sumY) / denominator;

  // R-squared
  const meanY = sumY / count;
  let ssTot = 0;
  let ssRes = 0;
  const intercept = (sumY - slope * sumX) / count;
  for (const point of values) {
    const predicted = intercept + slope * point.dayIndex;
    ssRes += (point.value - predicted) ** 2;
    ssTot += (point.value - meanY) ** 2;
  }
  const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return { slopePerDay: slope, rSquared };
}

// ── Interpolation helper ─────────────────────────────────────────────

/** Number of milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/** Parse a YYYY-MM-DD date string to epoch ms (UTC midnight). */
function dateToMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

/** Format epoch ms (UTC midnight) back to YYYY-MM-DD. */
function msToDate(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface InterpolatedPoint {
  date: string;
  value: number;
  interpolated: boolean;
}

/**
 * Fill missing calendar days between known data points using linear interpolation.
 * Does NOT extrapolate beyond the first/last known point.
 * Input must be sorted by date ascending.
 */
export function interpolateMissingDays(
  sparse: ReadonlyArray<{ date: string; value: number }>,
): InterpolatedPoint[] {
  if (sparse.length === 0) return [];
  if (sparse.length === 1) {
    return [{ date: sparse[0]!.date, value: sparse[0]!.value, interpolated: false }];
  }

  const result: InterpolatedPoint[] = [];

  for (let index = 0; index < sparse.length; index++) {
    const current = sparse[index]!;
    result.push({ date: current.date, value: current.value, interpolated: false });

    const next = sparse[index + 1];
    if (!next) break;

    const currentMs = dateToMs(current.date);
    const nextMs = dateToMs(next.date);
    const daysBetween = Math.round((nextMs - currentMs) / MS_PER_DAY);

    // Fill gaps with linearly interpolated values
    for (let gap = 1; gap < daysBetween; gap++) {
      const fraction = gap / daysBetween;
      const interpolatedValue = current.value + fraction * (next.value - current.value);
      result.push({
        date: msToDate(currentMs + gap * MS_PER_DAY),
        value: interpolatedValue,
        interpolated: true,
      });
    }
  }

  return result;
}

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

  /**
   * Comprehensive weight prediction: rate, period deltas, goal projection,
   * and a forward projection line for charting.
   */
  async getWeightPrediction(
    days: number,
    endDate: string,
    goalWeightKg: number | null,
  ): Promise<WeightPrediction> {
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

    return this.#computeWeightPrediction(data, goalWeightKg);
  }

  // ── Private computation methods ─────────────────────────────────

  #computeSmoothedWeight(data: { date: string; rawWeight: number }[]): SmoothedWeightRow[] {
    if (data.length === 0) return [];

    // Interpolate missing days to get a dense daily series
    const dense = interpolateMissingDays(
      data.map((day) => ({ date: day.date, value: day.rawWeight })),
    );

    const alpha = 0.1;
    const smoothedValues = ewmaSmooth(
      dense.map((point) => point.value),
      alpha,
    );

    const result: SmoothedWeightRow[] = [];
    for (let index = 0; index < dense.length; index++) {
      const point = dense[index];
      const smoothed = smoothedValues[index];
      if (!point || smoothed === undefined) continue;

      // Weekly rate of change: compare smoothed weight to 7 days ago
      let weeklyChange: number | null = null;
      if (index >= 7) {
        const previousSmoothed = smoothedValues[index - 7];
        if (previousSmoothed !== undefined) {
          weeklyChange = Math.round((smoothed - previousSmoothed) * 100) / 100;
        }
      }

      result.push({
        date: point.date,
        rawWeight: point.interpolated ? null : Math.round(point.value * 100) / 100,
        smoothedWeight: Math.round(smoothed * 100) / 100,
        weeklyChange,
        interpolated: point.interpolated,
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
    if (smoothed.length === 0) {
      return { currentWeekly: null, current4Week: null, trend: "insufficient" };
    }

    // Weekly rate: regression over last 14 smoothed values (or fewer if not enough)
    const weeklyWindow = Math.min(14, smoothed.length);
    let currentWeekly: number | null = null;
    if (smoothed.length >= 8) {
      const windowValues = smoothed.slice(-weeklyWindow).map((value, index) => ({
        dayIndex: index,
        value,
      }));
      const { slopePerDay } = leastSquaresSlope(windowValues);
      currentWeekly = Math.round(slopePerDay * 7 * 100) / 100;
    }

    // 4-week rate: regression over last 28 smoothed values
    let current4Week: number | null = null;
    if (smoothed.length >= 29) {
      const windowValues = smoothed.slice(-28).map((value, index) => ({
        dayIndex: index,
        value,
      }));
      const { slopePerDay } = leastSquaresSlope(windowValues);
      current4Week = Math.round(slopePerDay * 28 * 100) / 100;
    }

    const changeReference = currentWeekly ?? current4Week;
    let trend: WeightRateOfChange["trend"] = "stable";
    if (changeReference != null) {
      if (changeReference > 0.1) trend = "gaining";
      else if (changeReference < -0.1) trend = "losing";
    }

    return { currentWeekly, current4Week, trend };
  }

  #computeWeightPrediction(
    data: { date: string; rawWeight: number }[],
    goalWeightKg: number | null,
  ): WeightPrediction {
    const emptyResult: WeightPrediction = {
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    };

    if (data.length < 7) return emptyResult;

    // Interpolate missing days, then smooth
    const interpolated = interpolateMissingDays(
      data.map((day) => ({ date: day.date, value: day.rawWeight })),
    );
    const smoothed = ewmaSmooth(
      interpolated.map((point) => point.value),
      0.1,
    );
    if (smoothed.length === 0) return emptyResult;

    // Rate via regression on last 14 smoothed values
    const regressionWindow = Math.min(14, smoothed.length);
    let ratePerWeek: number | null = null;
    let rateConfidence: number | null = null;
    let slopePerDay = 0;

    if (smoothed.length >= 8) {
      const windowValues = smoothed.slice(-regressionWindow).map((value, index) => ({
        dayIndex: index,
        value,
      }));
      const regression = leastSquaresSlope(windowValues);
      slopePerDay = regression.slopePerDay;
      ratePerWeek = Math.round(slopePerDay * 7 * 100) / 100;
      rateConfidence = Math.round(regression.rSquared * 1000) / 1000;
    }

    // Implied daily calories: 7700 kcal/kg
    const impliedDailyCalories =
      ratePerWeek != null ? Math.round(((ratePerWeek / 7) * 7700 * 10) / 10) : null;

    // Period deltas from smoothed values
    const latest = smoothed[smoothed.length - 1]!;
    const days7 =
      smoothed.length >= 8
        ? Math.round((latest - smoothed[smoothed.length - 8]!) * 100) / 100
        : null;
    const days14 =
      smoothed.length >= 15
        ? Math.round((latest - smoothed[smoothed.length - 15]!) * 100) / 100
        : null;
    const days30 =
      smoothed.length >= 31
        ? Math.round((latest - smoothed[smoothed.length - 31]!) * 100) / 100
        : null;

    // Goal projection
    let goal: WeightPrediction["goal"] = null;
    if (goalWeightKg != null && ratePerWeek != null) {
      const remainingKg = Math.round((goalWeightKg - latest) * 100) / 100;
      const trendingTowardGoal =
        (remainingKg < 0 && slopePerDay < 0) || (remainingKg > 0 && slopePerDay > 0);

      let estimatedDate: string | null = null;
      let daysRemaining: number | null = null;

      if (trendingTowardGoal && Math.abs(slopePerDay) > 0.001) {
        daysRemaining = Math.ceil(Math.abs(remainingKg / slopePerDay));
        const lastDate = interpolated[interpolated.length - 1]!.date;
        const lastMs = dateToMs(lastDate);
        estimatedDate = msToDate(lastMs + daysRemaining * MS_PER_DAY);
      }

      goal = { goalWeightKg, remainingKg, estimatedDate, daysRemaining };
    }

    // Projection line: up to 30 days forward (or until goal)
    const projectionLine: WeightPrediction["projectionLine"] = [];
    if (ratePerWeek != null) {
      const lastDate = interpolated[interpolated.length - 1]!.date;
      const lastMs = dateToMs(lastDate);
      const maxDays = goal?.daysRemaining != null ? Math.min(goal.daysRemaining, 30) : 30;

      for (let day = 1; day <= maxDays; day++) {
        projectionLine.push({
          date: msToDate(lastMs + day * MS_PER_DAY),
          projectedWeight: Math.round((latest + slopePerDay * day) * 100) / 100,
        });
      }
    }

    return {
      ratePerWeek,
      rateConfidence,
      impliedDailyCalories,
      periodDeltas: { days7, days14, days30 },
      goal,
      projectionLine,
    };
  }
}
