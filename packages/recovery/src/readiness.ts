/**
 * Readiness scoring: composite metric from HRV, resting HR, sleep, and workload balance.
 *
 * Pure functions with no database dependencies.
 * Shared between web and iOS via @dofek/recovery.
 */

// ── Types ────────────────────────────────────────────────────────

export interface ReadinessComponents {
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  loadBalanceScore: number;
}

export interface ReadinessWeights {
  hrv: number;
  restingHr: number;
  sleep: number;
  loadBalance: number;
}

// ── Default weights ─────────────────────────────────────────────

export function defaultReadinessWeights(): ReadinessWeights {
  return {
    hrv: 0.4,
    restingHr: 0.2,
    sleep: 0.2,
    loadBalance: 0.2,
  };
}

// ── Score helpers ───────────────────────────────────────────────

/**
 * Map a z-score to a 0-100 score.
 * z=0 → 50 (baseline), positive → higher (better for HRV), negative → lower.
 * Clamped to [0, 100].
 */
export function zScoreToScore(zScore: number): number {
  const score = 50 + zScore * 15;
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/**
 * Map ACWR (Acute:Chronic Workload Ratio) to a 0-100 score.
 * Optimal is 1.0. Deviation in either direction is penalized.
 * null → 50 (neutral, insufficient data).
 */
export function acwrToScore(acwr: number | null): number {
  if (acwr == null) return 50;
  const deviation = Math.abs(acwr - 1.0);
  return Math.max(0, Math.min(100, Math.round((1 - deviation) * 100)));
}

// ── Composite readiness ─────────────────────────────────────────

/**
 * Compute a composite readiness score (0-100) from weighted components.
 */
export function computeReadinessScore(
  components: ReadinessComponents,
  weights: ReadinessWeights,
): number {
  const raw =
    components.hrvScore * weights.hrv +
    components.restingHrScore * weights.restingHr +
    components.sleepScore * weights.sleep +
    components.loadBalanceScore * weights.loadBalance;

  return Math.max(0, Math.min(100, Math.round(raw)));
}
