/**
 * Readiness scoring: composite metric from HRV, resting HR, sleep, and respiratory rate.
 *
 * Pure functions with no database dependencies.
 * Shared between web and iOS via @dofek/recovery.
 */

// ── Types ────────────────────────────────────────────────────────

export interface ReadinessComponents {
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  respiratoryRateScore: number;
}

export interface ReadinessWeights {
  hrv: number;
  restingHr: number;
  sleep: number;
  respiratoryRate: number;
}

// ── Default weights ─────────────────────────────────────────────

export function defaultReadinessWeights(): ReadinessWeights {
  return {
    hrv: 0.5,
    restingHr: 0.2,
    sleep: 0.15,
    respiratoryRate: 0.15,
  };
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
    components.respiratoryRateScore * weights.respiratoryRate;

  return Math.max(0, Math.min(100, Math.round(raw)));
}
