/**
 * Readiness scoring: composite metric from HRV, resting HR, sleep, and workload balance.
 *
 * Pure class with no database dependencies.
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

export interface ReadinessMetrics {
  hrv: number | null;
  restingHr: number | null;
  hrvMean: number | null;
  hrvStddev: number | null;
  rhrMean: number | null;
  rhrStddev: number | null;
  sleepEfficiency: number | null;
  acwr: number | null;
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
      this.components.loadBalanceScore * this.weights.loadBalance;

    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  static fromMetrics(metrics: ReadinessMetrics, weights: ReadinessWeights): ReadinessScore {
    return new ReadinessScore(
      {
        hrvScore: Math.round(ReadinessScore.computeHrvScore(metrics)),
        restingHrScore: Math.round(ReadinessScore.computeRestingHrScore(metrics)),
        sleepScore: ReadinessScore.computeSleepScore(metrics.sleepEfficiency),
        loadBalanceScore: Math.round(ReadinessScore.computeLoadBalanceScore(metrics.acwr)),
      },
      weights,
    );
  }

  private static computeHrvScore(metrics: ReadinessMetrics): number {
    if (
      metrics.hrv == null ||
      metrics.hrvMean == null ||
      metrics.hrvStddev == null ||
      metrics.hrvStddev <= 0
    ) {
      return 50;
    }
    const zScore = (metrics.hrv - metrics.hrvMean) / metrics.hrvStddev;
    return ReadinessScore.zScoreToScore(zScore);
  }

  private static computeRestingHrScore(metrics: ReadinessMetrics): number {
    if (
      metrics.restingHr == null ||
      metrics.rhrMean == null ||
      metrics.rhrStddev == null ||
      metrics.rhrStddev <= 0
    ) {
      return 50;
    }
    const zScore = (metrics.restingHr - metrics.rhrMean) / metrics.rhrStddev;
    return ReadinessScore.zScoreToScore(-zScore);
  }

  private static computeSleepScore(efficiency: number | null): number {
    if (efficiency == null) return 50;
    return Math.max(0, Math.min(100, Math.round(efficiency)));
  }

  private static computeLoadBalanceScore(acwr: number | null): number {
    if (acwr == null) return 50;
    const deviation = Math.abs(acwr - 1.0);
    return Math.max(0, Math.min(100, Math.round((1 - deviation) * 100)));
  }

  /**
   * Map a z-score to a 0-100 score.
   * z=0 → 50 (baseline), positive → higher, negative → lower.
   * Clamped to [0, 100].
   */
  private static zScoreToScore(zScore: number): number {
    const score = 50 + zScore * 15;
    return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
  }
}
