/**
 * Power analysis: duration curves, Critical Power model, Normalized Power.
 *
 * Pure functions with no database or infrastructure dependencies.
 * Shared between web and iOS via @dofek/training.
 */

// ── Standard durations for power/HR/pace curves ─────────────────────

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

// ── Linear regression ───────────────────────────────────────────────

/** Simple linear regression: y = slope * x + intercept */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const pointCount = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * (ys[i] ?? 0), 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = pointCount * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };

  const slope = (pointCount * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / pointCount;

  const yMean = sumY / pointCount;
  const ssTotal = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
  const ssResidual = ys.reduce((a, y, i) => a + (y - (slope * (xs[i] ?? 0) + intercept)) ** 2, 0);
  const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

  return { slope, intercept, r2 };
}

// ── Critical Power Model ────────────────────────────────────────────

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

  const { slope: cp, intercept: wPrime, r2 } = linearRegression(xs, ys);

  if (cp <= 0) return null;

  return {
    cp: Math.round(cp),
    wPrime: Math.round(wPrime),
    r2: Math.round(r2 * 1000) / 1000,
  };
}

// ── Activity grouping ───────────────────────────────────────────────

export interface ActivityGroup<T> {
  rows: T[];
  activityDate: string;
  intervalSeconds: number;
}

/** Group pre-sorted samples by activity_id in a single pass. */
export function groupByActivity<
  T extends { activity_id: string; activity_date: string; interval_s: number },
>(samples: T[]): ActivityGroup<T>[] {
  const groups: ActivityGroup<T>[] = [];
  let current: ActivityGroup<T> | null = null;

  for (const sample of samples) {
    if (!current || current.rows.at(0)?.activity_id !== sample.activity_id) {
      current = {
        rows: [],
        activityDate: sample.activity_date,
        intervalSeconds: sample.interval_s,
      };
      groups.push(current);
    }
    current.rows.push(sample);
  }

  return groups;
}

// ── Power Curve ─────────────────────────────────────────────────────

export interface PowerCurvePoint {
  durationSeconds: number;
  bestPower: number;
  activityDate: string;
}

interface PowerCurveSample {
  activity_id: string;
  activity_date: string;
  power: number;
  interval_s: number;
}

/**
 * Compute best average power for each standard duration across all activities.
 * Uses prefix sums for O(N × D) performance where N = total samples, D = 14 durations.
 */
export function computePowerCurve(samples: PowerCurveSample[]): PowerCurvePoint[] {
  const activities = groupByActivity(samples);
  const bestPerDuration = new Map<number, { power: number; date: string }>();

  for (const { rows, activityDate, intervalSeconds } of activities) {
    const rowCount = rows.length;

    const cumsum = new Float64Array(rowCount + 1);
    for (let i = 0; i < rowCount; i++) {
      cumsum[i + 1] = (cumsum[i] ?? 0) + (rows[i]?.power ?? 0);
    }

    for (const duration of STANDARD_DURATIONS) {
      const windowSize = Math.round(duration / intervalSeconds);
      if (windowSize > rowCount || windowSize < 1) continue;

      let maxAvg = 0;
      for (let i = windowSize; i <= rowCount; i++) {
        const avg = ((cumsum[i] ?? 0) - (cumsum[i - windowSize] ?? 0)) / windowSize;
        if (avg > maxAvg) maxAvg = avg;
      }

      if (maxAvg > 0) {
        const prev = bestPerDuration.get(duration);
        if (!prev || maxAvg > prev.power) {
          bestPerDuration.set(duration, { power: Math.round(maxAvg), date: activityDate });
        }
      }
    }
  }

  return STANDARD_DURATIONS.flatMap((d) => {
    const best = bestPerDuration.get(d);
    if (!best) return [];
    return [{ durationSeconds: d, bestPower: best.power, activityDate: best.date }];
  });
}

// ── Normalized Power ────────────────────────────────────────────────

export interface NormalizedPowerResult {
  activityDate: string;
  activityName: string | null;
  normalizedPower: number;
}

interface NormalizedPowerSample {
  activity_id: string;
  activity_date: string;
  activity_name: string | null;
  power: number;
  interval_s: number;
}

/**
 * Compute Normalized Power per activity using 30-second rolling averages.
 * NP = (mean(rolling_30s_avg^4))^0.25 — accounts for the metabolic cost
 * of variable-intensity efforts.
 */
export function computeNormalizedPower(samples: NormalizedPowerSample[]): NormalizedPowerResult[] {
  const activities = groupByActivity(samples);
  const results: NormalizedPowerResult[] = [];

  for (const { rows, activityDate, intervalSeconds } of activities) {
    const windowSize = Math.max(1, Math.round(30 / intervalSeconds));
    const rowCount = rows.length;

    const cumsum = new Float64Array(rowCount + 1);
    for (let i = 0; i < rowCount; i++) {
      cumsum[i + 1] = (cumsum[i] ?? 0) + (rows[i]?.power ?? 0);
    }

    let sum4thPower = 0;
    let count = 0;
    for (let i = windowSize; i <= rowCount; i++) {
      const avg = ((cumsum[i] ?? 0) - (cumsum[i - windowSize] ?? 0)) / windowSize;
      sum4thPower += avg ** 4;
      count++;
    }

    if (count === 0) continue;
    const normalizedPower = Math.round((sum4thPower / count) ** 0.25 * 10) / 10;

    results.push({
      activityDate,
      activityName: rows[0]?.activity_name ?? null,
      normalizedPower,
    });
  }

  results.sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  return results;
}
