import { describe, expect, it } from "vitest";
import { computeStrainTarget } from "./strain-target.ts";

describe("computeStrainTarget", () => {
  // ── Zone assignment boundary tests ──

  describe("zone boundaries", () => {
    it("assigns Push zone at exactly readiness=70", () => {
      const result = computeStrainTarget(70);
      expect(result.zone).toBe("Push");
    });

    it("assigns Maintain zone at exactly readiness=69", () => {
      const result = computeStrainTarget(69);
      expect(result.zone).toBe("Maintain");
    });

    it("assigns Maintain zone at exactly readiness=50", () => {
      const result = computeStrainTarget(50);
      expect(result.zone).toBe("Maintain");
    });

    it("assigns Recovery zone at exactly readiness=49", () => {
      const result = computeStrainTarget(49);
      expect(result.zone).toBe("Recovery");
    });

    it("assigns Recovery zone at readiness=0", () => {
      const result = computeStrainTarget(0);
      expect(result.zone).toBe("Recovery");
    });

    it("assigns Push zone at readiness=100", () => {
      const result = computeStrainTarget(100);
      expect(result.zone).toBe("Push");
    });
  });

  // ── Strain range tests ──

  describe("strain ranges within zones", () => {
    it("Push zone: min strain at readiness=70 is exactly 14", () => {
      const result = computeStrainTarget(70);
      expect(result.targetStrain).toBe(14);
    });

    it("Push zone: max strain at readiness=100 is exactly 18", () => {
      const result = computeStrainTarget(100);
      expect(result.targetStrain).toBe(18);
    });

    it("Maintain zone: min strain at readiness=50 is exactly 10", () => {
      const result = computeStrainTarget(50);
      expect(result.targetStrain).toBe(10);
    });

    it("Maintain zone: max strain at readiness=69 is close to 14", () => {
      const result = computeStrainTarget(69);
      // fraction = (69 - 50) / (69 - 50) = 1, so targetStrain = 10 + 1 * 4 = 14
      expect(result.targetStrain).toBe(14);
    });

    it("Recovery zone: min strain at readiness=0 is exactly 4", () => {
      const result = computeStrainTarget(0);
      expect(result.targetStrain).toBe(4);
    });

    it("Recovery zone: max strain at readiness=49 is exactly 10", () => {
      const result = computeStrainTarget(49);
      // fraction = (49 - 0) / (49 - 0) = 1, so targetStrain = 4 + 1 * 6 = 10
      expect(result.targetStrain).toBe(10);
    });

    it("interpolates within Push zone correctly for readiness=85", () => {
      // fraction = (85 - 70) / (100 - 70) = 15/30 = 0.5
      // targetStrain = 14 + 0.5 * (18 - 14) = 14 + 2 = 16
      const result = computeStrainTarget(85);
      expect(result.targetStrain).toBe(16);
    });

    it("interpolates within Maintain zone correctly for readiness=60", () => {
      // fraction = (60 - 50) / (69 - 50) = 10/19 ≈ 0.5263
      // targetStrain = 10 + 0.5263 * (14 - 10) = 10 + 2.105 ≈ 12.1
      const result = computeStrainTarget(60);
      expect(result.targetStrain).toBe(12.1);
    });

    it("interpolates within Recovery zone correctly for readiness=25", () => {
      // fraction = (25 - 0) / (49 - 0) = 25/49 ≈ 0.5102
      // targetStrain = 4 + 0.5102 * (10 - 4) = 4 + 3.061 ≈ 7.1
      const result = computeStrainTarget(25);
      expect(result.targetStrain).toBe(7.1);
    });
  });

  // ── Fraction clamping tests ──

  describe("fraction clamping", () => {
    it("clamps fraction to 0 when readiness is below zone min (negative readiness)", () => {
      const result = computeStrainTarget(-10);
      // zone = Recovery, zoneReadinessMin = 0, fraction = max(0, (-10 - 0)/(49-0)) = 0
      // targetStrain = 4 + 0 * 6 = 4
      expect(result.targetStrain).toBe(4);
      expect(result.zone).toBe("Recovery");
    });

    it("clamps fraction to 1 when readiness exceeds zone max", () => {
      // Very high readiness in Push zone
      const result = computeStrainTarget(120);
      // fraction = min(1, (120 - 70) / (100 - 70)) = min(1, 50/30) = 1
      // targetStrain = 14 + 1 * 4 = 18
      expect(result.targetStrain).toBe(18);
      expect(result.zone).toBe("Push");
    });
  });

  // ── Explanation string tests ──

  describe("explanations", () => {
    it("Push zone explanation includes readiness score", () => {
      const result = computeStrainTarget(85);
      expect(result.explanation).toContain("85");
      expect(result.explanation).toContain("strong");
      expect(result.explanation).toContain("Push");
    });

    it("Maintain zone explanation includes readiness score", () => {
      const result = computeStrainTarget(60);
      expect(result.explanation).toContain("60");
      expect(result.explanation).toContain("Moderate");
    });

    it("Recovery zone explanation includes readiness score", () => {
      const result = computeStrainTarget(30);
      expect(result.explanation).toContain("30");
      expect(result.explanation).toContain("low");
    });
  });

  // ── Return value rounding ──

  describe("rounding", () => {
    it("rounds targetStrain to one decimal place", () => {
      const result = computeStrainTarget(55);
      const decimals = result.targetStrain.toString().split(".")[1];
      expect(!decimals || decimals.length <= 1).toBe(true);
    });

    it("returns exact integer when interpolation yields integer", () => {
      // readiness = 70 -> fraction=0, target = 14
      const result = computeStrainTarget(70);
      expect(result.targetStrain).toBe(14);
      expect(Number.isInteger(result.targetStrain)).toBe(true);
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("handles very high readiness (>100)", () => {
      const result = computeStrainTarget(200);
      // Clamped fraction to 1 -> max strain
      expect(result.targetStrain).toBe(18);
      expect(result.zone).toBe("Push");
    });

    it("handles very negative readiness", () => {
      const result = computeStrainTarget(-100);
      expect(result.targetStrain).toBe(4);
      expect(result.zone).toBe("Recovery");
    });

    it("all three return fields are always present", () => {
      const result = computeStrainTarget(50);
      expect(result).toHaveProperty("targetStrain");
      expect(result).toHaveProperty("zone");
      expect(result).toHaveProperty("explanation");
      expect(typeof result.targetStrain).toBe("number");
      expect(typeof result.zone).toBe("string");
      expect(typeof result.explanation).toBe("string");
    });
  });
});
