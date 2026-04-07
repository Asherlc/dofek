import type { ConfidenceLevel } from "./types.ts";

// ── Confidence classification ─────────────────────────────────────────────

/** Classify confidence for conditional tests (Cohen's d effect size) */
export function classifyConfidence(d: number, minN: number, pValue?: number): ConfidenceLevel {
  const absD = Math.abs(d);
  // Require statistical significance (p < 0.05) for "strong"
  if (absD >= 0.8 && minN >= 30 && (pValue == null || pValue < 0.05)) return "strong";
  if (absD >= 0.5 && minN >= 15) return "emerging";
  if (absD >= 0.3 && minN >= 10) return "early";
  return "insufficient";
}

/** Window size for monthly-scoped rolling analyses */
export const MONTHLY_WINDOW_SIZE = 30;

/** Classify confidence for correlation-based insights (Spearman rho) */
export function classifyCorrelationConfidence(rho: number, n: number): ConfidenceLevel {
  const absRho = Math.abs(rho);
  if (absRho >= 0.5 && n >= 30) return "strong";
  if (absRho >= 0.35 && n >= 15) return "emerging";
  if (absRho >= 0.2 && n >= 10) return "early";
  return "insufficient";
}

export const MAX_DATA_POINTS = 200;

/** Evenly downsample an array to at most `max` elements */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const result: T[] = [];
  for (let i = 0; i < max; i++) {
    const item = arr[Math.floor(i * step)];
    if (item !== undefined) result.push(item);
  }
  return result;
}
