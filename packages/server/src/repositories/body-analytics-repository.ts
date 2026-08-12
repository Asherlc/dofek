import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { type EpistemicStatus, getEpistemicStatus } from "@dofek/scoring/epistemic-status";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateWindowStartString, type RangeDays } from "../lib/date-window.ts";
import {
  type BodyDecisionContext,
  buildBodyDecisionContext,
} from "../services/body-decision-context.ts";
import {
  type BodyClickHouseStore,
  fetchBodyDecisionMeasurements,
  fetchBodyWeightRows,
} from "./body-clickhouse.ts";

// ── Types ───────────────────────────────────────────────────────────

const WEIGHT_RATE_REGRESSION_WINDOW_DAYS = 14;
const MIN_ACTUAL_READINGS_FOR_WEIGHT_RATE = 7;
const MIN_ACTUAL_READINGS_FOR_7_DAY_DELTA = 4;
const MIN_ACTUAL_READINGS_FOR_14_DAY_DELTA = 7;
const MIN_ACTUAL_READINGS_FOR_30_DAY_DELTA = 19;

export interface SmoothedWeightRow {
  date: string;
  /** Raw weight measurement in kg. Null for interpolated days. */
  rawWeight: number | null;
  /** Server-authored epistemic status for the raw measurement, when present. */
  rawWeightStatus: EpistemicStatus | null;
  smoothedWeight: number;
  /** Server-authored epistemic status for the smoothed trend value. */
  smoothedWeightStatus: EpistemicStatus;
  weeklyChange: number | null;
  /** True when this day had no actual measurement and was linearly interpolated. */
  interpolated: boolean;
}

export interface SmoothedBodyFatRow {
  date: string;
  /** Raw body-fat percentage. Null for interpolated days. */
  rawBodyFatPct: number | null;
  /** Server-authored epistemic status for the raw measurement, when present. */
  rawBodyFatStatus: EpistemicStatus | null;
  smoothedBodyFatPct: number;
  /** Server-authored epistemic status for the smoothed trend value. */
  smoothedBodyFatStatus: EpistemicStatus;
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

export interface BodyFatPrediction {
  /** Regression slope: percentage points per week over recent smoothed data. */
  ratePerWeek: number | null;
  /** R-squared of the trend regression (0-1, higher = more consistent). */
  rateConfidence: number | null;
  /** Period deltas: smoothed body-fat percentage-point change. */
  periodDeltas: {
    days7: number | null;
    days14: number | null;
    days30: number | null;
  };
  /** Projection line: future smoothed body-fat points for chart rendering. */
  projectionLine: Array<{ date: string; projectedBodyFatPct: number }>;
}

interface SmoothedMetricPoint {
  date: string;
  rawValue: number | null;
  smoothedValue: number;
  weeklyChange: number | null;
  interpolated: boolean;
}

interface MetricForecast {
  ratePerWeek: number | null;
  rateConfidence: number | null;
  periodDeltas: {
    days7: number | null;
    days14: number | null;
    days30: number | null;
  };
  slopePerDay: number;
  latest: number;
  lastDate: string | null;
}

// ── Least-squares slope ─────────────────────────────────────────────

/**
 * Simple univariate least-squares linear regression.
 * Returns the slope (value change per day index unit) and R-squared.
 */
export function leastSquaresSlope(values: ReadonlyArray<{ dayIndex: number; value: number }>): {
  slopePerDay: number;
  rSquared: number;
} {
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
  const utcDate = new Date(ms);
  const year = utcDate.getUTCFullYear();
  const month = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utcDate.getUTCDate()).padStart(2, "0");
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
  const first = sparse[0];
  if (!first) return [];
  if (sparse.length === 1) {
    return [{ date: first.date, value: first.value, interpolated: false }];
  }

  const result: InterpolatedPoint[] = [];

  for (let index = 0; index < sparse.length; index++) {
    const current = sparse[index];
    if (!current) continue;
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

function countActualWeightReadings(points: ReadonlyArray<Pick<InterpolatedPoint, "interpolated">>) {
  return points.filter((point) => !point.interpolated).length;
}

function roundWeight(value: number): number {
  return Math.round(value * 10) / 10;
}

function isPositiveWeight(value: number): boolean {
  return value > 0;
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
  readonly #bodyStore: BodyClickHouseStore;
  readonly #bodyWeightRowsCache = new Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchBodyWeightRows>>>
  >();

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    accessWindow?: AccessWindow,
    bodyStore?: BodyClickHouseStore,
  ) {
    super(db, userId, timezone, accessWindow);
    if (!bodyStore) {
      throw new Error("body analytics require the ClickHouse body measurement store");
    }
    this.#bodyStore = bodyStore;
  }

  /**
   * TrendWeight-compatible body-weight trend: interpolate missing calendar
   * days, then move 10% from the prior trend toward each day's weight.
   */
  async getSmoothedWeight(days: RangeDays, endDate: string): Promise<SmoothedWeightRow[]> {
    const rows = await this.#fetchBodyWeightRows(null, endDate, false);

    const data = rows
      .map((row) => ({
        date: row.date,
        rawWeight: Number(row.weight_kg),
      }))
      .filter((row) => isPositiveWeight(row.rawWeight));

    const smoothedWeight = this.#computeSmoothedWeight(data);
    if (days === null) return smoothedWeight;

    const resolvedEndDate =
      endDate === "now" ? formatDateYmdInTimeZone(new Date(), this.timezone) : endDate;
    const windowStart = dateWindowStartString(resolvedEndDate, days);
    return smoothedWeight.filter((row) => row.date > windowStart);
  }

  /**
   * Trend body-fat percentage: interpolate missing calendar days, then move
   * 10% from the prior trend toward each day's body-fat percentage.
   */
  async getSmoothedBodyFat(days: RangeDays, endDate: string): Promise<SmoothedBodyFatRow[]> {
    const rows = await this.#fetchBodyWeightRows(null, endDate, true);
    const data = rows
      .map((row) => ({ date: row.date, rawBodyFatPct: Number(row.body_fat_pct) }))
      .filter((row) => Number.isFinite(row.rawBodyFatPct));
    const smoothedBodyFat = this.#computeSmoothedBodyFat(data);
    if (days === null) return smoothedBodyFat;

    const resolvedEndDate =
      endDate === "now" ? formatDateYmdInTimeZone(new Date(), this.timezone) : endDate;
    const windowStart = dateWindowStartString(resolvedEndDate, days);
    return smoothedBodyFat.filter((row) => row.date > windowStart);
  }

  async getBodyDecisionContext(endDate: string): Promise<BodyDecisionContext> {
    const [trendRows, provenanceRows] = await Promise.all([
      this.getSmoothedWeight(null, endDate),
      fetchBodyDecisionMeasurements(
        this.#bodyStore,
        this.userId,
        this.timezone,
        endDate,
        this.accessWindow,
      ),
    ]);

    return buildBodyDecisionContext(
      provenanceRows.map((row) => ({
        date: row.date,
        recordedAt: row.recorded_at,
        recordedAtLocal: row.recorded_at_local,
        weightKg: row.weight_kg,
        providerId: row.provider_id,
        sourceName: row.source_name,
      })),
      trendRows.map((row) => ({ date: row.date, smoothedWeight: row.smoothedWeight })),
    );
  }

  /**
   * Body recomposition: fat mass vs lean mass trends.
   * Derives fat mass (weight * body_fat_pct) and lean mass (weight - fat mass)
   * from measurements that have both weight and body fat data.
   */
  async getRecomposition(days: RangeDays, endDate: string): Promise<BodyRecompositionRow[]> {
    const rows = await this.#fetchBodyWeightRows(days, endDate, true);

    const data = rows
      .map((row) => ({
        date: row.date,
        weightKg: Number(row.weight_kg),
        bodyFatPct: Number(row.body_fat_pct),
      }))
      .filter((row) => isPositiveWeight(row.weightKg));

    return this.#computeRecomposition(data);
  }

  /**
   * Weight rate of change summary.
   * Current weekly and 4-week rates, plus overall trend direction.
   */
  async getWeightTrend(): Promise<WeightRateOfChange> {
    const rows = await this.#fetchBodyWeightRows(35, "now", false);

    const weights = rows.map((row) => Number(row.weight_kg)).filter(isPositiveWeight);
    return this.#computeWeightTrend(weights);
  }

  /**
   * Comprehensive weight prediction: rate, period deltas, goal projection,
   * and a forward projection line for charting.
   */
  async getWeightPrediction(
    _days: RangeDays,
    endDate: string,
    goalWeightKg: number | null,
  ): Promise<WeightPrediction> {
    const rows = await this.#fetchBodyWeightRows(null, endDate, false);

    const data = rows
      .map((row) => ({
        date: row.date,
        rawWeight: Number(row.weight_kg),
      }))
      .filter((row) => isPositiveWeight(row.rawWeight));

    return this.#computeWeightPrediction(data, goalWeightKg);
  }

  /** Comprehensive body-fat prediction for the shared body-composition trend. */
  async getBodyFatPrediction(
    _days: RangeDays,
    endDate: string,
  ): Promise<BodyFatPrediction> {
    const rows = await this.#fetchBodyWeightRows(null, endDate, true);
    const data = rows
      .map((row) => ({ date: row.date, rawBodyFatPct: Number(row.body_fat_pct) }))
      .filter((row) => Number.isFinite(row.rawBodyFatPct));

    return this.#computeBodyFatPrediction(data);
  }

  // ── Private computation methods ─────────────────────────────────

  #fetchBodyWeightRows(
    days: RangeDays,
    endDate: string,
    requireBodyFat: boolean,
  ): Promise<Awaited<ReturnType<typeof fetchBodyWeightRows>>> {
    const cacheKey = JSON.stringify({ days, endDate, requireBodyFat });
    const cachedRows = this.#bodyWeightRowsCache.get(cacheKey);
    if (cachedRows) return cachedRows;

    const rowsPromise = fetchBodyWeightRows(
      this.#bodyStore,
      this.userId,
      this.timezone,
      endDate,
      days,
      { requireBodyFat, accessWindow: this.accessWindow },
    ).catch((error: unknown) => {
      this.#bodyWeightRowsCache.delete(cacheKey);
      captureException(error);
      throw error;
    });
    this.#bodyWeightRowsCache.set(cacheKey, rowsPromise);
    return rowsPromise;
  }

  #computeSmoothedWeight(data: { date: string; rawWeight: number }[]): SmoothedWeightRow[] {
    return this.#computeSmoothedMetric(data.map(({ date, rawWeight }) => ({ date, rawWeight }))).map(
      (row) => ({
        date: row.date,
        rawWeight: row.rawValue == null ? null : roundWeight(row.rawValue),
        rawWeightStatus: row.rawValue == null ? null : getEpistemicStatus("observed"),
        smoothedWeight: roundWeight(row.smoothedValue),
        smoothedWeightStatus: getEpistemicStatus("estimated"),
        weeklyChange: row.weeklyChange,
        interpolated: row.interpolated,
      }),
    );
  }

  #computeSmoothedBodyFat(
    data: { date: string; rawBodyFatPct: number }[],
  ): SmoothedBodyFatRow[] {
    return this.#computeSmoothedMetric(
      data.map(({ date, rawBodyFatPct }) => ({ date, rawWeight: rawBodyFatPct })),
    ).map((row) => ({
      date: row.date,
      rawBodyFatPct: row.rawValue == null ? null : roundWeight(row.rawValue),
      rawBodyFatStatus: row.rawValue == null ? null : getEpistemicStatus("observed"),
      smoothedBodyFatPct: roundWeight(row.smoothedValue),
      smoothedBodyFatStatus: getEpistemicStatus("estimated"),
      weeklyChange: row.weeklyChange,
      interpolated: row.interpolated,
    }));
  }

  #computeSmoothedMetric(data: { date: string; rawWeight: number }[]): SmoothedMetricPoint[] {
    if (data.length === 0) return [];

    const dense = interpolateMissingDays(
      data.map((day) => ({ date: day.date, value: day.rawWeight })),
    );
    const smoothedValues = ewmaSmooth(
      dense.map((point) => point.value),
      0.1,
    );

    const result: SmoothedMetricPoint[] = [];
    for (let index = 0; index < dense.length; index++) {
      const point = dense[index];
      const smoothed = smoothedValues[index];
      if (!point || smoothed === undefined) continue;

      let weeklyChange: number | null = null;
      if (index >= 7) {
        const previousSmoothed = smoothedValues[index - 7];
        const weeklyWindowPoints = dense.slice(index - 7, index + 1);
        if (
          previousSmoothed !== undefined &&
          countActualWeightReadings(weeklyWindowPoints) >= MIN_ACTUAL_READINGS_FOR_7_DAY_DELTA
        ) {
          weeklyChange = Math.round((smoothed - previousSmoothed) * 100) / 100;
        }
      }

      result.push({
        date: point.date,
        rawValue: point.interpolated ? null : point.value,
        smoothedValue: smoothed,
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
        weightKg: roundWeight(day.weightKg),
        bodyFatPct: Math.round(day.bodyFatPct * 10) / 10,
        fatMassKg: roundWeight(fatMass),
        leanMassKg: roundWeight(leanMass),
        smoothedFatMass: roundWeight(smoothedFat),
        smoothedLeanMass: roundWeight(smoothedLean),
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

  #computeMetricForecast(data: { date: string; rawWeight: number }[]): MetricForecast | null {
    if (data.length < 7) return null;

    const interpolated = interpolateMissingDays(
      data.map((day) => ({ date: day.date, value: day.rawWeight })),
    );
    const smoothed = ewmaSmooth(
      interpolated.map((point) => point.value),
      0.1,
    );
    const lastInterpolatedPoint = interpolated.at(-1);
    const latest = smoothed.at(-1);
    if (smoothed.length === 0 || latest === undefined || !lastInterpolatedPoint) return null;

    const regressionWindow = Math.min(WEIGHT_RATE_REGRESSION_WINDOW_DAYS, smoothed.length);
    let ratePerWeek: number | null = null;
    let rateConfidence: number | null = null;
    let slopePerDay = 0;

    const regressionWindowPoints = interpolated.slice(-regressionWindow);
    const regressionWindowValues = smoothed.slice(-regressionWindow);
    if (
      smoothed.length >= 7 &&
      regressionWindowValues.every(Number.isFinite) &&
      countActualWeightReadings(regressionWindowPoints) >= MIN_ACTUAL_READINGS_FOR_WEIGHT_RATE
    ) {
      const regression = leastSquaresSlope(
        regressionWindowValues.map((value, index) => ({ dayIndex: index, value })),
      );
      slopePerDay = regression.slopePerDay;
      ratePerWeek = Math.round(slopePerDay * 7 * 100) / 100;
      rateConfidence = Math.round(regression.rSquared * 1000) / 1000;
    }

    if (ratePerWeek == null && smoothed.length >= 8) {
      const weeklyWindowPoints = interpolated.slice(-8);
      if (countActualWeightReadings(weeklyWindowPoints) >= MIN_ACTUAL_READINGS_FOR_7_DAY_DELTA) {
        const previousSmoothed = smoothed[smoothed.length - 8] ?? 0;
        ratePerWeek = Math.round((latest - previousSmoothed) * 100) / 100;
        slopePerDay = ratePerWeek / 7;
      }
    }

    const computePeriodDelta = (daysBack: number, minimumActualReadings: number) => {
      const requiredPointCount = daysBack + 1;
      if (smoothed.length < requiredPointCount) return null;

      const periodPoints = interpolated.slice(-requiredPointCount);
      if (countActualWeightReadings(periodPoints) < minimumActualReadings) return null;

      return (
        Math.round((latest - (smoothed[smoothed.length - requiredPointCount] ?? 0)) * 100) / 100
      );
    };

    return {
      ratePerWeek,
      rateConfidence,
      periodDeltas: {
        days7: computePeriodDelta(7, MIN_ACTUAL_READINGS_FOR_7_DAY_DELTA),
        days14: computePeriodDelta(14, MIN_ACTUAL_READINGS_FOR_14_DAY_DELTA),
        days30: computePeriodDelta(30, MIN_ACTUAL_READINGS_FOR_30_DAY_DELTA),
      },
      slopePerDay,
      latest,
      lastDate: lastInterpolatedPoint.date,
    };
  }

  #projectMetric(forecast: MetricForecast, maximumDays: number) {
    if (forecast.ratePerWeek == null) return [];
    const lastMs = dateToMs(forecast.lastDate ?? "");
    return Array.from({ length: maximumDays }, (_, index) => {
      const day = index + 1;
      return {
        date: msToDate(lastMs + day * MS_PER_DAY),
        projectedValue: roundWeight(forecast.latest + forecast.slopePerDay * day),
      };
    });
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
      goal:
        goalWeightKg != null
          ? { goalWeightKg, remainingKg: 0, estimatedDate: null, daysRemaining: null }
          : null,
      projectionLine: [],
    };
    const forecast = this.#computeMetricForecast(data);
    if (!forecast) return emptyResult;

    const impliedDailyCalories =
      forecast.ratePerWeek != null && Math.abs(forecast.ratePerWeek) >= 0.01
        ? Math.round((forecast.ratePerWeek / 7) * 7700)
        : null;

    let goal: WeightPrediction["goal"] = null;
    if (goalWeightKg != null) {
      const remainingKg = roundWeight(goalWeightKg - forecast.latest);
      const trendingTowardGoal =
        forecast.ratePerWeek != null &&
        ((remainingKg < 0 && forecast.slopePerDay < 0) ||
          (remainingKg > 0 && forecast.slopePerDay > 0));
      const daysRemaining =
        trendingTowardGoal && Math.abs(forecast.slopePerDay) > 0.001
          ? Math.ceil(Math.abs(remainingKg / forecast.slopePerDay))
          : null;
      goal = {
        goalWeightKg,
        remainingKg,
        daysRemaining,
        estimatedDate:
          daysRemaining == null
            ? null
            : msToDate(dateToMs(forecast.lastDate ?? "") + daysRemaining * MS_PER_DAY),
      };
    }

    const maximumProjectionDays = goal?.daysRemaining != null ? Math.min(goal.daysRemaining, 30) : 30;
    return {
      ratePerWeek: forecast.ratePerWeek,
      rateConfidence: forecast.rateConfidence,
      impliedDailyCalories,
      periodDeltas: forecast.periodDeltas,
      goal,
      projectionLine: this.#projectMetric(forecast, maximumProjectionDays).map((point) => ({
        date: point.date,
        projectedWeight: point.projectedValue,
      })),
    };
  }

  #computeBodyFatPrediction(
    data: { date: string; rawBodyFatPct: number }[],
  ): BodyFatPrediction {
    const emptyResult: BodyFatPrediction = {
      ratePerWeek: null,
      rateConfidence: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      projectionLine: [],
    };
    const forecast = this.#computeMetricForecast(
      data.map(({ date, rawBodyFatPct }) => ({ date, rawWeight: rawBodyFatPct })),
    );
    if (!forecast) return emptyResult;

    return {
      ratePerWeek: forecast.ratePerWeek,
      rateConfidence: forecast.rateConfidence,
      periodDeltas: forecast.periodDeltas,
      projectionLine: this.#projectMetric(forecast, 30).map((point) => ({
        date: point.date,
        projectedBodyFatPct: point.projectedValue,
      })),
    };
  }
}
