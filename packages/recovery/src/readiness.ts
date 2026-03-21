/**
 * Readiness scoring: composite metric from HRV, resting HR, sleep, and respiratory rate.
 *
 * Pure class with no database dependencies.
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

// ── ReadinessScore ──────────────────────────────────────────────

export class ReadinessScore {
  constructor(
    readonly components: ReadinessComponents,
    private readonly weights: ReadinessWeights,
  ) {}

  get score(): number {
    const raw =
      this.components.hrvScore * this.weights.hrv +
      this.components.restingHrScore * this.weights.restingHr +
      this.components.sleepScore * this.weights.sleep +
      this.components.respiratoryRateScore * this.weights.respiratoryRate;

    return Math.max(0, Math.min(100, Math.round(raw)));
  }
}
