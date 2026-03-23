/**
 * Training stress calculator.
 *
 * Encapsulates Bannister TRIMP, hrTSS, power TSS, regression model building,
 * and FTP estimation. Instance methods use personalized gender factor and
 * exponent; static methods are parameter-independent.
 */

import { linearRegression } from "./power-analysis.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface ActivityRow {
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number;
  max_hr: number;
  avg_power: number | null;
  power_samples: number;
  hr_samples: number;
}

export interface TssModelInfo {
  type: "learned" | "generic";
  pairedActivities: number;
  r2: number | null;
  ftp: number | null;
}

// ── TrainingStressCalculator ─────────────────────────────────────────

export class TrainingStressCalculator {
  readonly #genderFactor: number;
  readonly #exponent: number;

  constructor(genderFactor = 0.64, exponent = 1.92) {
    this.#genderFactor = genderFactor;
    this.#exponent = exponent;
  }

  /**
   * Compute Bannister TRIMP for an activity.
   *
   * TRIMP = duration_minutes * deltaHR_ratio * genderFactor * e^(exponent * deltaHR_ratio)
   *   where deltaHR_ratio = (avg_hr - resting_hr) / (max_hr - resting_hr)
   */
  computeTrimp(durationMin: number, avgHr: number, maxHr: number, restingHr: number): number {
    if (maxHr <= restingHr || durationMin <= 0) return 0;
    const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
    if (deltaHrRatio <= 0) return 0;
    return (
      durationMin * deltaHrRatio * this.#genderFactor * Math.exp(this.#exponent * deltaHrRatio)
    );
  }

  /**
   * Compute hrTSS using Bannister TRIMP normalized to 1hr at threshold.
   * This is the fallback when no learned model is available.
   */
  computeHrTss(durationMin: number, avgHr: number, maxHr: number, restingHr: number): number {
    const trimp = this.computeTrimp(durationMin, avgHr, maxHr, restingHr);
    if (trimp === 0) return 0;

    // Threshold HR at 85% of max HR
    const thresholdDeltaRatio = 0.85;
    const trimpOneHourAtThreshold =
      60 *
      thresholdDeltaRatio *
      this.#genderFactor *
      Math.exp(this.#exponent * thresholdDeltaRatio);

    if (trimpOneHourAtThreshold === 0) return 0;
    return (trimp / trimpOneHourAtThreshold) * 100;
  }

  /**
   * Compute power-based TSS.
   * TSS = (NP / FTP)^2 * duration_hours * 100
   */
  static computePowerTss(normalizedPower: number, ftp: number, durationMin: number): number {
    if (ftp <= 0 || durationMin <= 0 || normalizedPower <= 0) return 0;
    const intensityFactor = normalizedPower / ftp;
    return intensityFactor ** 2 * (durationMin / 60) * 100;
  }

  /**
   * Build a linear regression model: powerTss = slope * trimp + intercept.
   * Returns null if insufficient data or poor fit.
   */
  static buildTssModel(
    paired: { trimp: number; powerTss: number }[],
  ): { slope: number; intercept: number; r2: number } | null {
    if (paired.length < 10) return null;

    const xs = paired.map((point) => point.trimp);
    const ys = paired.map((point) => point.powerTss);

    const result = linearRegression(xs, ys);

    if (result.r2 < 0.3 || result.slope <= 0) return null;

    return result;
  }

  /**
   * Estimate FTP from activity data.
   * Uses highest avg_power from activities >= 20 min duration, multiplied by 0.95.
   *
   * Intentionally uses avg_power rather than Normalized Power (NP).
   * NP inflates power for interval workouts via 4th-power averaging,
   * which produces unrealistically high FTP estimates from variable efforts.
   */
  static estimateFtp(activities: ActivityRow[]): number | null {
    const qualifying = activities.filter(
      (act) => act.avg_power != null && act.avg_power > 0 && act.duration_min >= 20,
    );
    if (qualifying.length === 0) return null;
    const bestPower = Math.max(...qualifying.map((act) => Number(act.avg_power)));
    return Math.round(bestPower * 0.95);
  }
}
