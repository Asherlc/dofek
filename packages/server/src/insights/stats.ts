import pcorrtest from "@stdlib/stats-pcorrtest";
import ranks from "@stdlib/stats-ranks";
import { mean, median, quantile, standardDeviation } from "simple-statistics";

// ── Descriptive stats ──────────────────────────────────────────────────────

export interface DescriptiveStats {
  mean: number;
  median: number;
  stddev: number;
  p25: number;
  p75: number;
  n: number;
}

export function describe(values: number[]): DescriptiveStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, stddev: 0, p25: 0, p75: 0, n: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: mean(sorted),
    median: median(sorted),
    stddev: values.length > 1 ? standardDeviation(sorted) : 0,
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    n: values.length,
  };
}

// ── Welch's t-test (unequal variance two-sample) ──────────────────────────

export interface TTestResult {
  t: number;
  pValue: number;
  df: number;
}

export function welchTTest(a: number[], b: number[]): TTestResult {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { t: 0, pValue: 1, df: 0 };

  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = variance(a);
  const v2 = variance(b);

  const se = Math.sqrt(v1 / n1 + v2 / n2);
  if (se === 0) return { t: 0, pValue: 1, df: n1 + n2 - 2 };

  const t = (m1 - m2) / se;

  // Welch-Satterthwaite degrees of freedom
  const num = (v1 / n1 + v2 / n2) ** 2;
  const denom = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1);
  const df = num / denom;

  const pValue = 2 * tCDF(-Math.abs(t), df);
  return { t, pValue, df };
}

// ── Cohen's d effect size ─────────────────────────────────────────────────

export function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = variance(a);
  const v2 = variance(b);
  // Pooled standard deviation
  const sp = Math.sqrt(((a.length - 1) * v1 + (b.length - 1) * v2) / (a.length + b.length - 2));
  return sp === 0 ? 0 : (m1 - m2) / sp;
}

// ── Spearman rank correlation with p-value ────────────────────────────────

export interface CorrelationResult {
  rho: number;
  pValue: number;
  n: number;
}

export function spearmanCorrelation(x: number[], y: number[]): CorrelationResult {
  const n = x.length;
  if (n < 5) return { rho: 0, pValue: 1, n };

  const rx = ranks(x, { method: "average" }) as number[];
  const ry = ranks(y, { method: "average" }) as number[];

  const result = pcorrtest(rx, ry);
  return {
    rho: result.pcorr,
    pValue: result.pValue,
    n,
  };
}

// ── Benjamini-Hochberg FDR correction ─────────────────────────────────────

export function benjaminiHochberg(pValues: number[], alpha: number = 0.05): boolean[] {
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  let maxK = -1;
  for (let k = 0; k < m; k++) {
    if (indexed[k].p <= ((k + 1) / m) * alpha) {
      maxK = k;
    }
  }

  const significant = new Array(m).fill(false);
  if (maxK >= 0) {
    for (let k = 0; k <= maxK; k++) {
      significant[indexed[k].i] = true;
    }
  }
  return significant;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function variance(arr: number[]): number {
  const m = mean(arr);
  return arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
}

/** Student's t CDF via regularized incomplete beta function */
function tCDF(t: number, df: number): number {
  const x = df / (df + t * t);
  return 0.5 * regularizedBeta(x, df / 2, 0.5);
}

/** Regularized incomplete beta function I_x(a,b) via continued fraction (Lentz) */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x === 0) return 0;
  if (x === 1) return 1;

  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (Lentz's method)
  let f = 1;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    // Odd step
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

/** Log-gamma via Lanczos approximation */
function lgamma(z: number): number {
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
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) {
    x += coef[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
