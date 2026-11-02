/** Personalized facade over the canonical heart-rate stress and regression functions. */
import { buildTssModel, computeHrTss, computeTrimp } from "./pmc.ts";

export class TrainingStressCalculator {
  readonly #genderFactor: number;
  readonly #exponent: number;
  constructor(genderFactor = 0.64, exponent = 1.92) {
    this.#genderFactor = genderFactor;
    this.#exponent = exponent;
  }
  computeTrimp(durationMin: number, avgHr: number, maxHr: number, restingHr: number): number {
    return computeTrimp(durationMin, avgHr, maxHr, restingHr, this.#genderFactor, this.#exponent);
  }
  computeHrTss(durationMin: number, avgHr: number, maxHr: number, restingHr: number): number {
    return computeHrTss(durationMin, avgHr, maxHr, restingHr, this.#genderFactor, this.#exponent);
  }
  static buildTssModel(
    paired: { trimp: number; powerTss: number }[],
  ): { slope: number; intercept: number; r2: number } | null {
    return buildTssModel(paired);
  }
}
