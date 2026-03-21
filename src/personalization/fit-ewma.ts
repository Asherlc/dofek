export interface ExponentialMovingAverageInput {
  date: string;
  load: number;
  performance: number;
}

export interface ExponentialMovingAverageFitResult {
  chronicTrainingLoadDays: number;
  acuteTrainingLoadDays: number;
  sampleCount: number;
  /** Absolute Pearson correlation between TSB and next-7-day performance */
  correlation: number;
}

const CHRONIC_LOAD_CANDIDATES = [21, 28, 35, 42, 49, 56, 63];
const ACUTE_LOAD_CANDIDATES = [5, 7, 9, 11, 14];
const MIN_DAYS = 90;
const MIN_CORRELATION = 0.2;

/**
 * Find the EWMA windows (CTL/ATL) that maximize
 * the correlation between TSB and subsequent performance.
 *
 * Grid searches over physiologically reasonable CTL/ATL pairs.
 * Returns null if insufficient data or no candidate passes quality gate.
 */
export function fitExponentialMovingAverage(
  data: ExponentialMovingAverageInput[],
): ExponentialMovingAverageFitResult | null {
  if (data.length < MIN_DAYS) return null;

  let bestCorrelation = 0;
  let bestCtl = 42;
  let bestAtl = 7;

  for (const chronicTrainingLoadDays of CHRONIC_LOAD_CANDIDATES) {
    for (const acuteTrainingLoadDays of ACUTE_LOAD_CANDIDATES) {
      // CTL window must be longer than ATL
      if (chronicTrainingLoadDays <= acuteTrainingLoadDays) continue;

      const correlation = computeTsbPerformanceCorrelation(
        data,
        chronicTrainingLoadDays,
        acuteTrainingLoadDays,
      );
      if (Math.abs(correlation) > Math.abs(bestCorrelation)) {
        bestCorrelation = correlation;
        bestCtl = chronicTrainingLoadDays;
        bestAtl = acuteTrainingLoadDays;
      }
    }
  }

  if (Math.abs(bestCorrelation) < MIN_CORRELATION) return null;

  return {
    chronicTrainingLoadDays: bestCtl,
    acuteTrainingLoadDays: bestAtl,
    sampleCount: data.length,
    correlation: Math.round(bestCorrelation * 1000) / 1000,
  };
}

/**
 * Compute Pearson correlation between TSB (computed with given windows)
 * and the average performance over the next 7 days.
 */
function computeTsbPerformanceCorrelation(
  data: ExponentialMovingAverageInput[],
  chronicTrainingLoadDays: number,
  acuteTrainingLoadDays: number,
): number {
  // Compute TSB for each day
  let ctl = 0;
  let atl = 0;
  const tsbValues: number[] = [];

  for (const point of data) {
    ctl = ctl + (point.load - ctl) / chronicTrainingLoadDays;
    atl = atl + (point.load - atl) / acuteTrainingLoadDays;
    tsbValues.push(ctl - atl);
  }

  // Pair TSB[i] with average performance over days [i+1..i+7]
  const pairs: { tsb: number; performance: number }[] = [];
  for (let i = 0; i < data.length - 7; i++) {
    const tsb = tsbValues[i];
    if (tsb === undefined) continue;

    let perfSum = 0;
    let perfCount = 0;
    for (let j = i + 1; j <= i + 7 && j < data.length; j++) {
      const point = data[j];
      if (point) {
        perfSum += point.performance;
        perfCount++;
      }
    }
    if (perfCount > 0) {
      pairs.push({ tsb, performance: perfSum / perfCount });
    }
  }

  if (pairs.length < 30) return 0;

  return pearsonCorrelation(
    pairs.map((p) => p.tsb),
    pairs.map((p) => p.performance),
  );
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const count = xs.length;
  if (count === 0) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < count; i++) {
    const xValue = xs[i] ?? 0;
    const yValue = ys[i] ?? 0;
    sumX += xValue;
    sumY += yValue;
    sumXY += xValue * yValue;
    sumX2 += xValue * xValue;
    sumY2 += yValue * yValue;
  }

  const numerator = count * sumXY - sumX * sumY;
  const denominator = Math.sqrt((count * sumX2 - sumX * sumX) * (count * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}
