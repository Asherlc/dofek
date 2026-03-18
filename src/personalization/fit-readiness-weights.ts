export interface ReadinessWeightsInput {
  hrvScore: number;
  rhrScore: number;
  sleepScore: number;
  loadBalanceScore: number;
  /** Next-day HRV z-score (positive = good recovery) */
  nextDayHrvZScore: number;
}

export interface ReadinessWeightsFitResult {
  hrv: number;
  restingHr: number;
  sleep: number;
  loadBalance: number;
  sampleCount: number;
  /** Pearson correlation between weighted score and next-day HRV z-score */
  correlation: number;
}

const MIN_DAYS = 60;
const MIN_CORRELATION = 0.15;
const MIN_WEIGHT = 0.05;
const STEP = 0.05;

/**
 * Find readiness component weights that maximize correlation with
 * next-day HRV recovery (z-score).
 *
 * Grid searches over all weight combinations summing to 1.0,
 * with each weight >= 0.05, at 5% increments.
 *
 * Returns null if insufficient data or no combination passes quality gate.
 */
export function fitReadinessWeights(
  data: ReadinessWeightsInput[],
): ReadinessWeightsFitResult | null {
  if (data.length < MIN_DAYS) return null;

  let bestCorrelation = 0;
  let bestWeights = { hrv: 0.4, restingHr: 0.2, sleep: 0.2, loadBalance: 0.2 };

  // Grid search: all 4-tuples summing to 1.0, each >= MIN_WEIGHT, step 0.05
  const weightValues: number[] = [];
  for (let w = MIN_WEIGHT; w <= 1 - 3 * MIN_WEIGHT + 0.001; w += STEP) {
    weightValues.push(Math.round(w * 100) / 100);
  }

  for (const wHrv of weightValues) {
    for (const wRhr of weightValues) {
      if (wHrv + wRhr > 1 - 2 * MIN_WEIGHT + 0.001) continue;
      for (const wSleep of weightValues) {
        const wLoad = Math.round((1 - wHrv - wRhr - wSleep) * 100) / 100;
        if (wLoad < MIN_WEIGHT - 0.001) continue;
        if (Math.abs(wHrv + wRhr + wSleep + wLoad - 1.0) > 0.01) continue;

        const correlation = computeWeightedCorrelation(data, wHrv, wRhr, wSleep, wLoad);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestWeights = { hrv: wHrv, restingHr: wRhr, sleep: wSleep, loadBalance: wLoad };
        }
      }
    }
  }

  if (bestCorrelation < MIN_CORRELATION) return null;

  return {
    ...bestWeights,
    sampleCount: data.length,
    correlation: Math.round(bestCorrelation * 1000) / 1000,
  };
}

function computeWeightedCorrelation(
  data: ReadinessWeightsInput[],
  wHrv: number,
  wRhr: number,
  wSleep: number,
  wLoad: number,
): number {
  const scores: number[] = [];
  const outcomes: number[] = [];

  for (const row of data) {
    const weighted =
      wHrv * row.hrvScore +
      wRhr * row.rhrScore +
      wSleep * row.sleepScore +
      wLoad * row.loadBalanceScore;
    scores.push(weighted);
    outcomes.push(row.nextDayHrvZScore);
  }

  return pearsonCorrelation(scores, outcomes);
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}
