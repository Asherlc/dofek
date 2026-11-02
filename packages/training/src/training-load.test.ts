import { describe, expect, it } from "vitest";
import { TrainingStressCalculator } from "./training-load.ts";

const calc = new TrainingStressCalculator();

describe("TrainingStressCalculator", () => {
  describe("computeTrimp", () => {
    it("computes Bannister TRIMP from HR data", () => {
      const trimp = calc.computeTrimp(60, 150, 190, 50);
      expect(trimp).toBeGreaterThan(0);
      expect(trimp).toBeCloseTo(107.8, 0);
    });

    it("returns 0 when maxHr <= restingHr", () => {
      expect(calc.computeTrimp(60, 150, 50, 50)).toBe(0);
      expect(calc.computeTrimp(60, 150, 40, 50)).toBe(0);
    });

    it("returns 0 when duration is 0", () => {
      expect(calc.computeTrimp(0, 150, 190, 50)).toBe(0);
    });

    it("returns 0 when avgHr <= restingHr", () => {
      expect(calc.computeTrimp(60, 50, 190, 50)).toBe(0);
      expect(calc.computeTrimp(60, 40, 190, 50)).toBe(0);
    });

    it("uses personalized gender factor and exponent", () => {
      const defaultTrimp = calc.computeTrimp(60, 150, 190, 50);
      const custom = new TrainingStressCalculator(1.0, 1.5);
      const customTrimp = custom.computeTrimp(60, 150, 190, 50);
      expect(customTrimp).not.toBe(defaultTrimp);
      expect(customTrimp).toBeGreaterThan(0);
    });
  });

  describe("computeHrTss", () => {
    it("normalizes TRIMP to 1hr at threshold", () => {
      const tss = calc.computeHrTss(60, 150, 190, 50);
      expect(tss).toBeGreaterThan(0);
      expect(tss).toBeLessThan(300);
    });

    it("returns 0 for invalid inputs", () => {
      expect(calc.computeHrTss(0, 150, 190, 50)).toBe(0);
      expect(calc.computeHrTss(60, 50, 190, 50)).toBe(0);
      expect(calc.computeHrTss(60, 150, 50, 50)).toBe(0);
    });
  });

  describe("buildTssModel", () => {
    it("returns null with fewer than 10 paired activities", () => {
      const paired = Array.from({ length: 9 }, (_, i) => ({
        trimp: 50 + i * 10,
        powerTss: 40 + i * 8,
      }));
      expect(TrainingStressCalculator.buildTssModel(paired)).toBeNull();
    });

    it("builds model from 10+ paired activities with good fit", () => {
      const paired = Array.from({ length: 15 }, (_, i) => ({
        trimp: 50 + i * 10,
        powerTss: 45 + i * 8,
      }));
      const model = TrainingStressCalculator.buildTssModel(paired);
      expect(model).not.toBeNull();
      if (model) {
        expect(model.slope).toBeGreaterThan(0);
        expect(model.r2).toBeGreaterThanOrEqual(0.3);
      }
    });

    it("returns null for poor fit (random data)", () => {
      // Alternating extreme values produce near-zero r2
      const paired = Array.from({ length: 15 }, (_, i) => ({
        trimp: 50 + i * 10,
        powerTss: i % 2 === 0 ? 200 : 10,
      }));
      expect(TrainingStressCalculator.buildTssModel(paired)).toBeNull();
    });

    it("returns null when slope is negative (inverse correlation)", () => {
      // powerTss decreases as trimp increases → negative slope
      const paired = Array.from({ length: 15 }, (_, i) => ({
        trimp: 50 + i * 10,
        powerTss: 200 - i * 12,
      }));
      expect(TrainingStressCalculator.buildTssModel(paired)).toBeNull();
    });

    it("returns null when slope is zero (constant powerTss)", () => {
      // All powerTss values identical → slope = 0
      const paired = Array.from({ length: 15 }, (_, i) => ({
        trimp: 50 + i * 10,
        powerTss: 100,
      }));
      expect(TrainingStressCalculator.buildTssModel(paired)).toBeNull();
    });
  });
});
