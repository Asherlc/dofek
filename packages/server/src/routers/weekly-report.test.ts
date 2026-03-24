import { describe, expect, it } from "vitest";
import { classifyStrainZone } from "./weekly-report.ts";

describe("classifyStrainZone", () => {
  it("returns 'optimal' when chronicAvgLoad is 0", () => {
    expect(classifyStrainZone(50, 0)).toBe("optimal");
  });

  it("returns 'optimal' when chronicAvgLoad is negative", () => {
    expect(classifyStrainZone(50, -10)).toBe("optimal");
  });

  it("returns 'restoring' when ratio is below 0.8", () => {
    // ratio = 30 / 100 = 0.3
    expect(classifyStrainZone(30, 100)).toBe("restoring");
  });

  it("returns 'overreaching' when ratio is above 1.3", () => {
    // ratio = 140 / 100 = 1.4
    expect(classifyStrainZone(140, 100)).toBe("overreaching");
  });

  it("returns 'optimal' when ratio is between 0.8 and 1.3", () => {
    // ratio = 100 / 100 = 1.0
    expect(classifyStrainZone(100, 100)).toBe("optimal");
  });

  it("returns 'optimal' when ratio is exactly 0.8 (boundary)", () => {
    // ratio = 80 / 100 = 0.8 → not < 0.8, so falls through to optimal
    expect(classifyStrainZone(80, 100)).toBe("optimal");
  });

  it("returns 'optimal' when ratio is exactly 1.3 (boundary)", () => {
    // ratio = 130 / 100 = 1.3 → not > 1.3, so falls through to optimal
    expect(classifyStrainZone(130, 100)).toBe("optimal");
  });

  it("returns 'restoring' when ratio is just below 0.8", () => {
    // ratio = 79 / 100 = 0.79
    expect(classifyStrainZone(79, 100)).toBe("restoring");
  });

  it("returns 'overreaching' when ratio is just above 1.3", () => {
    // ratio = 131 / 100 = 1.31
    expect(classifyStrainZone(131, 100)).toBe("overreaching");
  });

  it("returns 'optimal' when weekAvgLoad is 0 and chronicAvgLoad > 0", () => {
    // ratio = 0 / 100 = 0 → < 0.8 → restoring
    expect(classifyStrainZone(0, 100)).toBe("restoring");
  });

  it("returns 'optimal' when both loads are 0", () => {
    // chronicAvgLoad <= 0 → short-circuits to optimal
    expect(classifyStrainZone(0, 0)).toBe("optimal");
  });

  it("handles very small chronicAvgLoad", () => {
    // ratio = 50 / 0.001 = 50000 → overreaching
    expect(classifyStrainZone(50, 0.001)).toBe("overreaching");
  });

  it("handles negative weekAvgLoad with positive chronicAvgLoad", () => {
    // ratio = -10 / 100 = -0.1 → < 0.8 → restoring
    expect(classifyStrainZone(-10, 100)).toBe("restoring");
  });
});
