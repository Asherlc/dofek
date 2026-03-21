/**
 * Power analysis computations.
 *
 * Pure functions for cycling power metrics:
 * - Critical Power (CP) model fitting (Morton's 2-parameter / Monod-Scherrer)
 * - Standard duration constants and labels for power curves
 */

import { linearRegression } from "@dofek/stats/correlation";

// ── Types ────────────────────────────────────────────────────────────

export interface CriticalPowerModel {
  cp: number;
  wPrime: number;
  r2: number;
}

// ── Constants ────────────────────────────────────────────────────────

/** Standard durations (in seconds) for power duration curves. */
export const STANDARD_DURATIONS = [
  5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200,
];

/** Human-readable labels for standard duration curve durations. */
export const DURATION_LABELS: Record<number, string> = {
  5: "5s",
  15: "15s",
  30: "30s",
  60: "1min",
  120: "2min",
  180: "3min",
  300: "5min",
  420: "7min",
  600: "10min",
  1200: "20min",
  1800: "30min",
  3600: "60min",
  5400: "90min",
  7200: "120min",
};

// ── Critical Power ───────────────────────────────────────────────────

/**
 * Fit Morton's 2-parameter Critical Power model (Monod-Scherrer).
 *
 * Model: P(t) = CP + W'/t
 * Linearized: Work = P*t = CP*t + W'
 * Linear regression of Work vs Time gives slope=CP, intercept=W'.
 *
 * Only uses durations 120-600s. This range avoids both anaerobic-dominated
 * efforts (<120s) and long-duration bests that are suppressed by interval
 * training recovery periods (>600s).
 */
export function fitCriticalPower(
  points: { durationSeconds: number; bestPower: number }[],
): CriticalPowerModel | null {
  const valid = points.filter(
    (p) => p.durationSeconds >= 120 && p.durationSeconds <= 600 && p.bestPower > 0,
  );
  if (valid.length < 3) return null;

  const xs = valid.map((p) => p.durationSeconds);
  const ys = valid.map((p) => p.bestPower * p.durationSeconds);

  const { slope: cp, intercept: wPrime, rSquared } = linearRegression(xs, ys);

  if (cp <= 0) return null;

  return {
    cp: Math.round(cp),
    wPrime: Math.round(wPrime),
    r2: Math.round(rSquared * 1000) / 1000,
  };
}
