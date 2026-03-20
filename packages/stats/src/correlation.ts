import { chartColors, textColors } from "@dofek/scoring/colors";

// ── Metric definitions ──────────────────────────────────────────────────

export type MetricDomain = "recovery" | "sleep" | "nutrition" | "activity" | "body";

export interface CorrelationMetric {
  id: string;
  label: string;
  unit: string;
  domain: MetricDomain;
  description: string;
  /** The key in JoinedDay to extract this metric's value */
  joinedDayKey: string;
}

export const CORRELATION_METRICS: CorrelationMetric[] = [
  // Recovery
  {
    id: "resting_hr",
    label: "Resting Heart Rate",
    unit: "bpm",
    domain: "recovery",
    description:
      "Your resting heart rate — lower generally indicates better cardiovascular fitness",
    joinedDayKey: "resting_hr",
  },
  {
    id: "hrv",
    label: "Heart Rate Variability",
    unit: "ms",
    domain: "recovery",
    description: "Variation between heartbeats — higher generally indicates better recovery",
    joinedDayKey: "hrv",
  },
  {
    id: "spo2",
    label: "Blood Oxygen",
    unit: "%",
    domain: "recovery",
    description: "Blood oxygen saturation level",
    joinedDayKey: "spo2_avg",
  },
  {
    id: "skin_temp",
    label: "Skin Temperature",
    unit: "\u00B0C",
    domain: "recovery",
    description: "Skin temperature deviation from baseline",
    joinedDayKey: "skin_temp_c",
  },

  // Sleep
  {
    id: "sleep_duration",
    label: "Sleep Duration",
    unit: "min",
    domain: "sleep",
    description: "Total time asleep (excluding awake periods)",
    joinedDayKey: "sleep_duration_min",
  },
  {
    id: "deep_sleep",
    label: "Deep Sleep",
    unit: "min",
    domain: "sleep",
    description: "Time in deep (slow-wave) sleep — important for physical recovery",
    joinedDayKey: "deep_min",
  },
  {
    id: "rem_sleep",
    label: "REM Sleep",
    unit: "min",
    domain: "sleep",
    description: "Time in REM sleep — important for cognitive recovery and memory",
    joinedDayKey: "rem_min",
  },
  {
    id: "sleep_efficiency",
    label: "Sleep Efficiency",
    unit: "%",
    domain: "sleep",
    description: "Percentage of time in bed actually spent sleeping",
    joinedDayKey: "sleep_efficiency",
  },

  // Nutrition
  {
    id: "calories",
    label: "Calories",
    unit: "kcal",
    domain: "nutrition",
    description: "Total daily calorie intake",
    joinedDayKey: "calories",
  },
  {
    id: "protein",
    label: "Protein",
    unit: "g",
    domain: "nutrition",
    description: "Daily protein intake",
    joinedDayKey: "protein_g",
  },
  {
    id: "carbs",
    label: "Carbohydrates",
    unit: "g",
    domain: "nutrition",
    description: "Daily carbohydrate intake",
    joinedDayKey: "carbs_g",
  },
  {
    id: "fat",
    label: "Dietary Fat",
    unit: "g",
    domain: "nutrition",
    description: "Daily fat intake",
    joinedDayKey: "fat_g",
  },
  {
    id: "fiber",
    label: "Fiber",
    unit: "g",
    domain: "nutrition",
    description: "Daily fiber intake",
    joinedDayKey: "fiber_g",
  },

  // Activity
  {
    id: "steps",
    label: "Steps",
    unit: "steps",
    domain: "activity",
    description: "Total daily step count",
    joinedDayKey: "steps",
  },
  {
    id: "active_calories",
    label: "Active Calories",
    unit: "kcal",
    domain: "activity",
    description: "Calories burned through activity (excluding basal)",
    joinedDayKey: "active_energy_kcal",
  },
  {
    id: "exercise_duration",
    label: "Exercise Duration",
    unit: "min",
    domain: "activity",
    description: "Total exercise time across all activities",
    joinedDayKey: "exercise_minutes",
  },
  {
    id: "cardio_duration",
    label: "Cardio Duration",
    unit: "min",
    domain: "activity",
    description: "Time spent on cardio activities (cycling, running, etc.)",
    joinedDayKey: "cardio_minutes",
  },
  {
    id: "strength_duration",
    label: "Strength Duration",
    unit: "min",
    domain: "activity",
    description: "Time spent on strength training",
    joinedDayKey: "strength_minutes",
  },

  // Body
  {
    id: "weight",
    label: "Weight",
    unit: "kg",
    domain: "body",
    description: "Body weight measurement",
    joinedDayKey: "weight_kg",
  },
  {
    id: "body_fat",
    label: "Body Fat",
    unit: "%",
    domain: "body",
    description: "Body fat percentage",
    joinedDayKey: "body_fat_pct",
  },
  {
    id: "weight_30d",
    label: "30-Day Average Weight",
    unit: "kg",
    domain: "body",
    description: "Rolling 30-day average weight — smooths out daily fluctuations",
    joinedDayKey: "weight_30d_avg",
  },
];

// ── Correlation description ─────────────────────────────────────────────

export function describeCorrelation(rho: number): string {
  const abs = Math.abs(rho);
  let strength: string;
  if (abs >= 0.7) strength = "strong";
  else if (abs >= 0.4) strength = "moderate";
  else if (abs >= 0.2) strength = "weak";
  else return "negligible";

  const direction = rho >= 0 ? "positive" : "negative";
  return `${strength} ${direction}`;
}

// ── Confidence classification ───────────────────────────────────────────

export type ConfidenceLevel = "strong" | "emerging" | "early" | "insufficient";

export function correlationConfidence(rho: number, n: number): ConfidenceLevel {
  const abs = Math.abs(rho);
  if (abs >= 0.5 && n >= 30) return "strong";
  if (abs >= 0.35 && n >= 15) return "emerging";
  if (abs >= 0.2 && n >= 10) return "early";
  return "insufficient";
}

// ── Color ───────────────────────────────────────────────────────────────

const EMERALD = chartColors.emerald;
const ROSE = "#f43f5e";
const NEUTRAL = textColors.neutral;

export function correlationColor(rho: number): string {
  const abs = Math.abs(rho);
  if (abs < 0.2) return NEUTRAL;
  return rho >= 0 ? EMERALD : ROSE;
}

// ── Insight text generation ─────────────────────────────────────────────

interface InsightParams {
  xLabel: string;
  yLabel: string;
  rho: number;
  pValue: number;
  n: number;
  lag: number;
}

export function generateCorrelationInsight(params: InsightParams): string {
  const { xLabel, yLabel, rho, pValue, n, lag } = params;
  const abs = Math.abs(rho);

  if (abs < 0.2) {
    return `No meaningful relationship was found between ${xLabel} and ${yLabel} (rho = ${rho.toFixed(2)}, p = ${pValue.toFixed(2)}, n = ${n}).`;
  }

  let strengthWord: string;
  if (abs >= 0.7) strengthWord = "strongly";
  else if (abs >= 0.4) strengthWord = "moderately";
  else strengthWord = "weakly";

  const direction = rho > 0 ? "higher" : "lower";
  const lagText = lag === 0 ? "" : lag === 1 ? " the next day" : ` ${lag} days later`;

  const pText = pValue < 0.001 ? "p < 0.001" : `p = ${pValue.toFixed(3)}`;

  return `Higher ${xLabel} is ${strengthWord} associated with ${direction} ${yLabel}${lagText} (rho = ${rho.toFixed(2)}, ${pText}, n = ${n}).`;
}

// ── Pearson correlation ─────────────────────────────────────────────────

export interface PearsonResult {
  r: number;
  pValue: number;
  n: number;
}

export function pearsonCorrelation(x: number[], y: number[]): PearsonResult {
  const n = x.length;
  if (n < 3) return { r: 0, pValue: 1, n };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumX2 += xi * xi;
    sumY2 += yi * yi;
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (den === 0) return { r: 0, pValue: 1, n };

  const r = num / den;

  // t-test for significance
  if (Math.abs(r) >= 1) return { r, pValue: 0, n };
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  const df = n - 2;
  const pValue = 2 * tCDF(-Math.abs(t), df);

  return { r, pValue, n };
}

// ── Linear regression ───────────────────────────────────────────────────

export interface RegressionResult {
  slope: number;
  intercept: number;
  rSquared: number;
}

export function linearRegression(x: number[], y: number[]): RegressionResult {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 };

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i] ?? 0;
    sumY += y[i] ?? 0;
  }
  const xMean = sumX / n;
  const yMean = sumY / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - xMean;
    const dy = (y[i] ?? 0) - yMean;
    num += dx * dy;
    den += dx * dx;
  }

  if (den === 0) return { slope: 0, intercept: yMean, rSquared: 0 };

  const slope = num / den;
  const intercept = yMean - slope * xMean;

  // R-squared
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yi = y[i] ?? 0;
    const predicted = slope * (x[i] ?? 0) + intercept;
    ssRes += (yi - predicted) ** 2;
    ssTot += (yi - yMean) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, intercept, rSquared };
}

// ── t-CDF ────────────────────────────────────────────────────────────────

export function tCDF(t: number, df: number): number {
  const x = df / (df + t * t);
  return 0.5 * regularizedBeta(x, df / 2, 0.5);
}

// Stryker disable all : Complex mathematical library function, validated through correlation test suite
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x === 0) return 0;
  if (x === 1) return 1;

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  let f = 1;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

// Stryker disable all : Complex mathematical library function (Lanczos approximation), validated through correlation test suite
export function lgamma(z: number): number {
  const g = 7;
  const coef = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  z -= 1;
  let x = coef[0] ?? 0;
  for (let i = 1; i < g + 2; i++) {
    x += (coef[i] ?? 0) / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
