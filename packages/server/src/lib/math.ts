/** Simple linear regression: y = slope * x + intercept */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const yMean = sumY / n;
  const ssTotal = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssResidual = ys.reduce((a, y, i) => a + (y - (slope * (xs[i] ?? 0) + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

  return { slope, intercept, r2 };
}

export interface CriticalPowerModel {
  cp: number;
  wPrime: number;
  r2: number;
}

/**
 * Fit Morton's 2-parameter Critical Power model (Monod-Scherrer).
 *
 * Model: P(t) = CP + W'/t
 * Linearized: Work = P*t = CP*t + W'
 * Linear regression of Work vs Time gives slope=CP, intercept=W'.
 *
 * Only uses durations 120–600s. This range avoids both anaerobic-dominated
 * efforts (<120s) and long-duration bests that are suppressed by interval
 * training recovery periods (>600s). For athletes who train primarily with
 * intervals, long-duration "bests" don't represent true maximal sustained
 * efforts and pull the CP estimate below the actual threshold power.
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

  const { slope: cp, intercept: wPrime, r2 } = linearRegression(xs, ys);

  if (cp <= 0) return null;

  return {
    cp: Math.round(cp),
    wPrime: Math.round(wPrime),
    r2: Math.round(r2 * 1000) / 1000,
  };
}
