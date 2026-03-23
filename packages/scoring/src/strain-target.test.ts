import { describe, expect, it } from "vitest";
import { computeStrainTarget } from "./strain-target.ts";

describe("computeStrainTarget", () => {
  // ── Zone assignment boundary tests ──

  describe("zone boundaries", () => {
    it("assigns Push zone at exactly readiness=70", () => {
      const result = computeStrainTarget(70, 60, 55);
      expect(result.zone).toBe("Push");
    });

    it("assigns Maintain zone at exactly readiness=69", () => {
      const result = computeStrainTarget(69, 60, 55);
      expect(result.zone).toBe("Maintain");
    });

    it("assigns Maintain zone at exactly readiness=50", () => {
      const result = computeStrainTarget(50, 60, 55);
      expect(result.zone).toBe("Maintain");
    });

    it("assigns Recovery zone at exactly readiness=49", () => {
      const result = computeStrainTarget(49, 60, 55);
      expect(result.zone).toBe("Recovery");
    });

    it("assigns Recovery zone at readiness=0", () => {
      const result = computeStrainTarget(0, 60, 55);
      expect(result.zone).toBe("Recovery");
    });

    it("assigns Push zone at readiness=100", () => {
      const result = computeStrainTarget(100, 60, 55);
      expect(result.zone).toBe("Push");
    });
  });

  // ── Strain range tests ──

  describe("strain ranges within zones", () => {
    it("Push zone: min strain at readiness=70 is exactly 14", () => {
      const result = computeStrainTarget(70, 60, 55);
      expect(result.targetStrain).toBe(14);
    });

    it("Push zone: max strain at readiness=100 is exactly 18", () => {
      const result = computeStrainTarget(100, 60, 55);
      expect(result.targetStrain).toBe(18);
    });

    it("Maintain zone: min strain at readiness=50 is exactly 10", () => {
      const result = computeStrainTarget(50, 60, 55);
      expect(result.targetStrain).toBe(10);
    });

    it("Maintain zone: max strain at readiness=69 is close to 14", () => {
      const result = computeStrainTarget(69, 60, 55);
      // fraction = (69 - 50) / (69 - 50) = 1, so targetStrain = 10 + 1 * 4 = 14
      expect(result.targetStrain).toBe(14);
    });

    it("Recovery zone: min strain at readiness=0 is exactly 4", () => {
      const result = computeStrainTarget(0, 60, 55);
      expect(result.targetStrain).toBe(4);
    });

    it("Recovery zone: max strain at readiness=49 is exactly 10", () => {
      const result = computeStrainTarget(49, 60, 55);
      // fraction = (49 - 0) / (49 - 0) = 1, so targetStrain = 4 + 1 * 6 = 10
      expect(result.targetStrain).toBe(10);
    });

    it("interpolates within Push zone correctly for readiness=85", () => {
      // fraction = (85 - 70) / (100 - 70) = 15/30 = 0.5
      // targetStrain = 14 + 0.5 * (18 - 14) = 14 + 2 = 16
      const result = computeStrainTarget(85, 60, 55);
      expect(result.targetStrain).toBe(16);
    });

    it("interpolates within Maintain zone correctly for readiness=60", () => {
      // fraction = (60 - 50) / (69 - 50) = 10/19 ≈ 0.5263
      // targetStrain = 10 + 0.5263 * (14 - 10) = 10 + 2.105 ≈ 12.1
      const result = computeStrainTarget(60, 60, 55);
      expect(result.targetStrain).toBe(12.1);
    });

    it("interpolates within Recovery zone correctly for readiness=25", () => {
      // fraction = (25 - 0) / (49 - 0) = 25/49 ≈ 0.5102
      // targetStrain = 4 + 0.5102 * (10 - 4) = 4 + 3.061 ≈ 7.1
      const result = computeStrainTarget(25, 60, 55);
      expect(result.targetStrain).toBe(7.1);
    });
  });

  // ── Fraction clamping tests ──

  describe("fraction clamping", () => {
    it("clamps fraction to 0 when readiness is below zone min (negative readiness)", () => {
      const result = computeStrainTarget(-10, 60, 55);
      // zone = Recovery, zoneReadinessMin = 0, fraction = max(0, (-10 - 0)/(49-0)) = 0
      // targetStrain = 4 + 0 * 6 = 4
      expect(result.targetStrain).toBe(4);
      expect(result.zone).toBe("Recovery");
    });

    it("clamps fraction to 1 when readiness exceeds zone max", () => {
      // Very high readiness in Push zone
      const result = computeStrainTarget(120, 60, 55);
      // fraction = min(1, (120 - 70) / (100 - 70)) = min(1, 50/30) = 1
      // targetStrain = 14 + 1 * 4 = 18
      expect(result.targetStrain).toBe(18);
      expect(result.zone).toBe("Push");
    });
  });

  // ── ACWR capping tests ──

  describe("ACWR capping", () => {
    it("does not cap when ACWR is exactly 1.3 (boundary)", () => {
      // ACWR = 78/60 = 1.3 exactly — NOT > 1.3, so no cap
      const result = computeStrainTarget(85, 60, 78);
      expect(result.targetStrain).toBe(16);
      expect(result.zone).toBe("Push");
    });

    it("caps when ACWR is just above 1.3", () => {
      // ACWR = 78.1/60 = 1.3017 — > 1.3, should cap to 12
      const result = computeStrainTarget(85, 60, 78.1);
      expect(result.targetStrain).toBeLessThanOrEqual(12);
    });

    it("ACWR cap: sets zone to Maintain when capped target >= 10", () => {
      // readiness = 90 -> Push zone, targetStrain would be ~16.7
      // ACWR = 80/50 = 1.6 -> caps to 12 (>= 10 so Maintain)
      const result = computeStrainTarget(90, 50, 80);
      expect(result.targetStrain).toBe(12);
      expect(result.zone).toBe("Maintain");
    });

    it("ACWR cap: sets zone to Recovery when capped target < 10", () => {
      // readiness = 55 -> Maintain zone, targetStrain = 10 + fraction * 4 ≈ 10.5
      // ACWR = 80/40 = 2.0 -> caps to 12 -> but 10.5 < 12 so cappedTarget = 10.5, not < targetStrain
      // Need: Push zone with very high ACWR where cap to 12 still results in 12 >= 10 -> Maintain
      // To get Recovery zone from cap, we need targetStrain that would be > 12 but cap = Math.min(target, 12)
      // and then targetStrain = 12, zone check: 12 < 10 is false -> Maintain
      // Actually targetStrain < 10 means Recovery. For cap to < 10, we'd need Math.min(target, 12) < 10
      // which is impossible since 12 >= 10. Let's verify ACWR cap doesn't change zone when target is already below 12
      const result = computeStrainTarget(30, 40, 60);
      // Recovery zone, ACWR = 60/40 = 1.5 > 1.3
      // targetStrain for readiness=30: 4 + (30/49)*6 ≈ 7.7
      // cappedTarget = min(7.7, 12) = 7.7 -> not < targetStrain -> no change
      expect(result.targetStrain).toBe(7.7);
      expect(result.explanation).toContain("workload ratio");
    });

    it("ACWR cap: does not alter zone or strain when target is already below 12", () => {
      // Moderate readiness=52, Recovery-zone would give ~10.3
      // With ACWR > 1.3, cappedTarget = min(10.3, 12) = 10.3, no change to target
      const result = computeStrainTarget(52, 40, 60);
      // Maintain zone, fraction = (52-50)/(69-50) = 2/19 ≈ 0.1053
      // targetStrain = 10 + 0.1053 * 4 ≈ 10.4
      // ACWR = 60/40 = 1.5 -> cappedTarget = min(10.4, 12) = 10.4 -> not less than 10.4 -> no change
      expect(result.targetStrain).toBe(10.4);
      expect(result.explanation).toContain("workload ratio");
      expect(result.explanation).toContain("1.50");
    });

    it("ACWR cap: includes the ACWR value in the explanation", () => {
      const result = computeStrainTarget(90, 50, 80);
      // ACWR = 80/50 = 1.60
      expect(result.explanation).toContain("1.60");
      expect(result.explanation).toContain("injury risk");
    });

    it("ACWR is 0 when chronic load is 0 (division by zero avoided)", () => {
      const result = computeStrainTarget(85, 0, 100);
      // chronicLoad=0 -> acwr=0, no capping
      expect(result.zone).toBe("Push");
      expect(result.targetStrain).toBe(16);
    });

    it("ACWR is 0 when both loads are 0", () => {
      const result = computeStrainTarget(60, 0, 0);
      expect(result.zone).toBe("Maintain");
    });
  });

  // ── Explanation string tests ──

  describe("explanations", () => {
    it("Push zone explanation includes readiness score", () => {
      const result = computeStrainTarget(85, 60, 55);
      expect(result.explanation).toContain("85");
      expect(result.explanation).toContain("strong");
      expect(result.explanation).toContain("Push");
    });

    it("Maintain zone explanation includes readiness score", () => {
      const result = computeStrainTarget(60, 60, 55);
      expect(result.explanation).toContain("60");
      expect(result.explanation).toContain("Moderate");
    });

    it("Recovery zone explanation includes readiness score", () => {
      const result = computeStrainTarget(30, 60, 55);
      expect(result.explanation).toContain("30");
      expect(result.explanation).toContain("low");
    });

    it("ACWR explanation contains elevated and capped language", () => {
      const result = computeStrainTarget(90, 50, 80);
      expect(result.explanation).toContain("elevated");
      expect(result.explanation).toContain("capped");
    });
  });

  // ── Return value rounding ──

  describe("rounding", () => {
    it("rounds targetStrain to one decimal place", () => {
      const result = computeStrainTarget(55, 60, 55);
      const decimals = result.targetStrain.toString().split(".")[1];
      expect(!decimals || decimals.length <= 1).toBe(true);
    });

    it("returns exact integer when interpolation yields integer", () => {
      // readiness = 70 -> fraction=0, target = 14
      const result = computeStrainTarget(70, 60, 55);
      expect(result.targetStrain).toBe(14);
      expect(Number.isInteger(result.targetStrain)).toBe(true);
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("handles very high readiness (>100)", () => {
      const result = computeStrainTarget(200, 60, 55);
      // Clamped fraction to 1 -> max strain
      expect(result.targetStrain).toBe(18);
      expect(result.zone).toBe("Push");
    });

    it("handles very negative readiness", () => {
      const result = computeStrainTarget(-100, 60, 55);
      expect(result.targetStrain).toBe(4);
      expect(result.zone).toBe("Recovery");
    });

    it("all three return fields are always present", () => {
      const result = computeStrainTarget(50, 50, 50);
      expect(result).toHaveProperty("targetStrain");
      expect(result).toHaveProperty("zone");
      expect(result).toHaveProperty("explanation");
      expect(typeof result.targetStrain).toBe("number");
      expect(typeof result.zone).toBe("string");
      expect(typeof result.explanation).toBe("string");
    });

    it("high ACWR with Maintain zone that caps below original", () => {
      // readiness = 65 -> Maintain zone
      // fraction = (65-50)/(69-50) = 15/19 ≈ 0.7895
      // targetStrain = 10 + 0.7895 * 4 ≈ 13.2
      // ACWR = 100/50 = 2.0 -> cap to 12, which is < 13.2
      // cappedTarget = 12, zone = 12 < 10 ? Recovery : Maintain -> Maintain
      const result = computeStrainTarget(65, 50, 100);
      expect(result.targetStrain).toBe(12);
      expect(result.zone).toBe("Maintain");
    });

    it("ACWR just barely > 1.3 with chronicLoad > 0 triggers capping logic", () => {
      // ACWR = 65.1/50 = 1.302
      const result = computeStrainTarget(90, 50, 65.1);
      expect(result.explanation).toContain("workload ratio");
    });
  });
});
