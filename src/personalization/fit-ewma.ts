export interface EwmaInput {
  date: string;
  load: number;
  performance: number;
}

export interface EwmaFitResult {
  ctlDays: number;
  atlDays: number;
  sampleCount: number;
  /** Absolute Pearson correlation between TSB and next-7-day performance */
  correlation: number;
}

const CTL_CANDIDATES = [21, 28, 35, 42, 49, 56, 63];
const ATL_CANDIDATES = [5, 7, 9, 11, 14];
const MIN_DAYS = 90;
const MIN_CORRELATION = 0.2;

/**
 * Find the EWMA windows (CTL/ATL) that maximize
 * the correlation between TSB and subsequent performance.
 *
 * Grid searches over physiologically reasonable CTL/ATL pairs.
 * Returns null if insufficient data or no candidate passes quality gate.
 */
export function fitEwma(data: EwmaInput[]): EwmaFitResult | null {
  if (data.length < MIN_DAYS) return null;

  let bestCorrelation = 0;
  let bestCtl = 42;
  let bestAtl = 7;

  for (const ctlDays of CTL_CANDIDATES) {
    for (const atlDays of ATL_CANDIDATES) {
      // CTL window must be longer than ATL
      if (ctlDays <= atlDays) continue;

      const correlation = computeTsbPerformanceCorrelation(data, ctlDays, atlDays);
      if (Math.abs(correlation) > Math.abs(bestCorrelation)) {
        bestCorrelation = correlation;
        bestCtl = ctlDays;
        bestAtl = atlDays;
      }
    }
  }

  if (Math.abs(bestCorrelation) < MIN_CORRELATION) return null;

  return {
    ctlDays: bestCtl,
    atlDays: bestAtl,
    sampleCount: data.length,
    correlation: Math.round(bestCorrelation * 1000) / 1000,
  };
}

/**
 * Compute Pearson correlation between TSB (computed with given windows)
 * and the average performance over the next 7 days.
 */
function computeTsbPerformanceCorrelation(
  data: EwmaInput[],
  ctlDays: number,
  atlDays: number,
): number {
  // Compute TSB for each day
  let ctl = 0;
  let atl = 0;
  const tsbValues: number[] = [];

  for (const point of data) {
    ctl = ctl + (point.load - ctl) / ctlDays;
    atl = atl + (point.load - atl) / atlDays;
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
