/**
 * Performance Management Chart (PMC) domain logic.
 *
 * Pure functions for heart-rate Training Stress Score, TRIMP,
 * and learned stress-model regression. No database or infrastructure dependencies.
 * Shared between web and iOS via @dofek/training.
 */

import { linearRegression } from "@dofek/cycling-power/regression";

export interface PmcDataPoint {
  date: string;
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface TssModelInfo {
  type: "learned" | "generic";
  pairedActivities: number;
  r2: number | null;
  ftp: number | null;
}

export interface PmcChartResult {
  data: PmcDataPoint[];
  model: TssModelInfo;
}

/**
 * Compute Bannister TRIMP for an activity.
 *
 * TRIMP = duration_minutes * deltaHR_ratio * genderFactor * e^(exponent * deltaHR_ratio)
 *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
 *
 * genderFactor and exponent default to 0.64 and 1.92 (Bannister generic)
 * but can be personalized per user.
 */
export function computeTrimp(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
  genderFactor = 0.64,
  exponent = 1.92,
): number {
  if (maxHr <= restingHr || durationMin <= 0) return 0;
  const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
  if (deltaHrRatio <= 0) return 0;
  return durationMin * deltaHrRatio * genderFactor * Math.exp(exponent * deltaHrRatio);
}

/**
 * Compute hrTSS using Bannister TRIMP normalized to 1hr at threshold.
 * This is the fallback when no learned model is available.
 */
export function computeHrTss(
  durationMin: number,
  avgHr: number,
  maxHr: number,
  restingHr: number,
  genderFactor = 0.64,
  exponent = 1.92,
): number {
  const trimp = computeTrimp(durationMin, avgHr, maxHr, restingHr, genderFactor, exponent);
  if (trimp === 0) return 0;

  // Threshold HR at 85% of max HR
  const thresholdDeltaRatio = 0.85;
  const trimpOneHourAtThreshold =
    60 * thresholdDeltaRatio * genderFactor * Math.exp(exponent * thresholdDeltaRatio);

  if (trimpOneHourAtThreshold === 0) return 0;
  return (trimp / trimpOneHourAtThreshold) * 100;
}

/**
 * Build a linear regression model: powerTss = slope * trimp + intercept.
 * Returns null if insufficient data or poor fit.
 */
export function buildTssModel(
  paired: { trimp: number; powerTss: number }[],
): { slope: number; intercept: number; r2: number } | null {
  // Require at least 10 paired activities
  if (paired.length < 10) return null;

  const xs = paired.map((point) => point.trimp);
  const ys = paired.map((point) => point.powerTss);

  const result = linearRegression(xs, ys);

  // Require a reasonable fit (R² >= 0.3) and positive slope
  if (result.r2 < 0.3 || result.slope <= 0) return null;

  return result;
}
