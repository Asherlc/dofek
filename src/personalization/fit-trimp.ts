export interface TrainingImpulseInput {
  durationMin: number;
  avgHr: number;
  maxHr: number;
  restingHr: number;
  /** Power-based TSS (ground truth from power meter) */
  powerTss: number;
}

export interface TrainingImpulseFitResult {
  genderFactor: number;
  exponent: number;
  sampleCount: number;
  /** R² of best TRIMP-to-powerTSS fit */
  r2: number;
}

const MIN_ACTIVITIES = 20;
const MIN_R2 = 0.3;
const GENDER_FACTOR_CANDIDATES = [0.5, 0.55, 0.6, 0.64, 0.65, 0.7, 0.75, 0.8];
const EXPONENT_CANDIDATES = [1.5, 1.6, 1.7, 1.8, 1.92, 2.0, 2.1, 2.2, 2.5];

/**
 * Find TRIMP constants (gender factor and exponent) that minimize
 * the error between TRIMP-based load and power-based TSS.
 *
 * Grid searches over physiologically reasonable values.
 * Returns null if insufficient data or no candidate passes quality gate.
 */
export function fitTrainingImpulseConstants(
  data: TrainingImpulseInput[],
): TrainingImpulseFitResult | null {
  if (data.length < MIN_ACTIVITIES) return null;

  let bestR2 = -Infinity;
  let bestGenderFactor = 0.64;
  let bestExponent = 1.92;

  for (const genderFactor of GENDER_FACTOR_CANDIDATES) {
    for (const exponent of EXPONENT_CANDIDATES) {
      const r2 = computeTrimpR2(data, genderFactor, exponent);
      if (r2 > bestR2) {
        bestR2 = r2;
        bestGenderFactor = genderFactor;
        bestExponent = exponent;
      }
    }
  }

  if (bestR2 < MIN_R2) return null;

  return {
    genderFactor: bestGenderFactor,
    exponent: bestExponent,
    sampleCount: data.length,
    r2: Math.round(bestR2 * 1000) / 1000,
  };
}

/**
 * Compute R² between TRIMP (computed with given constants) and power TSS.
 * Uses a linear model: powerTss = a * trimp + b
 */
function computeTrimpR2(
  data: TrainingImpulseInput[],
  genderFactor: number,
  exponent: number,
): number {
  const trimps: number[] = [];
  const targets: number[] = [];

  for (const act of data) {
    if (act.maxHr <= act.restingHr || act.durationMin <= 0) continue;

    const deltaHrRatio = (act.avgHr - act.restingHr) / (act.maxHr - act.restingHr);
    if (deltaHrRatio <= 0) continue;

    const trimp = act.durationMin * deltaHrRatio * genderFactor * Math.exp(exponent * deltaHrRatio);
    trimps.push(trimp);
    targets.push(act.powerTss);
  }

  if (trimps.length < 10) return -Infinity;

  // Fit linear regression: targets = slope * trimps + intercept
  const n = trimps.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = trimps[i] ?? 0;
    const y = targets[i] ?? 0;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denomX = n * sumX2 - sumX * sumX;
  if (denomX === 0) return -Infinity;

  const slope = (n * sumXY - sumX * sumY) / denomX;
  const intercept = (sumY - slope * sumX) / n;

  // Require positive slope (more HR effort → more load)
  if (slope <= 0) return -Infinity;

  // Compute R²
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const x = trimps[i] ?? 0;
    const y = targets[i] ?? 0;
    const pred = slope * x + intercept;
    ssRes += (y - pred) ** 2;
    ssTot += (y - meanY) ** 2;
  }

  if (ssTot === 0) return -Infinity;
  return 1 - ssRes / ssTot;
}
