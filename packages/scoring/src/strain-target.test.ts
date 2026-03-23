import { describe, expect, it } from "vitest";
import { computeStrainTarget } from "./strain-target.ts";

describe("computeStrainTarget", () => {
  it("returns Push zone for high readiness (70+)", () => {
    const result = computeStrainTarget(85, 60, 55);
    expect(result.zone).toBe("Push");
    expect(result.targetStrain).toBeGreaterThanOrEqual(14);
    expect(result.targetStrain).toBeLessThanOrEqual(18);
  });

  it("returns Maintain zone for moderate readiness (50-69)", () => {
    const result = computeStrainTarget(60, 60, 55);
    expect(result.zone).toBe("Maintain");
    expect(result.targetStrain).toBeGreaterThanOrEqual(10);
    expect(result.targetStrain).toBeLessThanOrEqual(14);
  });

  it("returns Recovery zone for low readiness (<50)", () => {
    const result = computeStrainTarget(30, 60, 55);
    expect(result.zone).toBe("Recovery");
    expect(result.targetStrain).toBeGreaterThanOrEqual(4);
    expect(result.targetStrain).toBeLessThanOrEqual(10);
  });

  it("caps strain target when ACWR > 1.3 to prevent injury", () => {
    // High readiness but dangerously high acute:chronic ratio
    const result = computeStrainTarget(90, 50, 80);
    // ACWR = 80/50 = 1.6 — should cap the target
    expect(result.targetStrain).toBeLessThanOrEqual(12);
    expect(result.explanation).toContain("workload ratio");
  });

  it("handles zero chronic load gracefully", () => {
    const result = computeStrainTarget(75, 0, 0);
    expect(result.targetStrain).toBeGreaterThan(0);
    expect(result.zone).toBe("Push");
  });

  it("returns explanation string", () => {
    const result = computeStrainTarget(75, 60, 55);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it("scales target within zone based on readiness", () => {
    const low = computeStrainTarget(70, 60, 55);
    const high = computeStrainTarget(95, 60, 55);
    expect(high.targetStrain).toBeGreaterThanOrEqual(low.targetStrain);
  });
});
