export interface StressThresholdsInput {
  hrvZScore: number;
  rhrZScore: number;
}

export interface StressThresholdsFitResult {
  /** HRV z-score thresholds [high, medium, low stress cutoff] in ascending order */
  hrvThresholds: [number, number, number];
  /** RHR z-score thresholds [high, medium, low stress cutoff] in descending order */
  rhrThresholds: [number, number, number];
  sampleCount: number;
}

const MIN_DAYS = 60;

/**
 * Calibrate stress thresholds based on the user's personal z-score distribution.
 *
 * Instead of fixed z-score cutoffs (e.g., -1.5, -1.0, -0.5), uses
 * percentile-based thresholds that target approximately:
 * - High stress: bottom 10% of HRV z-scores (top 10% of RHR)
 * - Medium stress: 10th-30th percentile HRV (70th-90th RHR)
 * - Low stress: 30th-60th percentile HRV (40th-70th RHR)
 * - No stress: above 60th percentile HRV (below 40th RHR)
 *
 * Returns null if fewer than 60 days of data.
 */
export function fitStressThresholds(
  data: StressThresholdsInput[],
): StressThresholdsFitResult | null {
  if (data.length < MIN_DAYS) return null;

  const hrvZScores = data.map((d) => d.hrvZScore).sort((a, b) => a - b);
  const rhrZScores = data.map((d) => d.rhrZScore).sort((a, b) => a - b);

  // HRV thresholds: ascending (most negative = high stress first)
  // p10, p30, p60 of HRV distribution
  const hrvHigh = percentile(hrvZScores, 10);
  const hrvMedium = percentile(hrvZScores, 30);
  const hrvLow = percentile(hrvZScores, 60);

  // RHR thresholds: descending (most positive = high stress first)
  // p90, p70, p40 of RHR distribution
  const rhrHigh = percentile(rhrZScores, 90);
  const rhrMedium = percentile(rhrZScores, 70);
  const rhrLow = percentile(rhrZScores, 40);

  return {
    hrvThresholds: [round2(hrvHigh), round2(hrvMedium), round2(hrvLow)],
    rhrThresholds: [round2(rhrHigh), round2(rhrMedium), round2(rhrLow)],
    sampleCount: data.length,
  };
}

function percentile(sorted: number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? 0;
  const fraction = index - lower;
  return lowerValue + fraction * (upperValue - lowerValue);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
