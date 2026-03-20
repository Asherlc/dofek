import { describe, expect, it } from "vitest";
import {
  CORRELATION_METRICS,
  correlationColor,
  correlationConfidence,
  describeCorrelation,
  generateCorrelationInsight,
  lgamma,
  linearRegression,
  pearsonCorrelation,
  regularizedBeta,
  tCDF,
} from "./correlation.ts";

describe("CORRELATION_METRICS", () => {
  it("contains at least 15 metrics across all domains", () => {
    expect(CORRELATION_METRICS.length).toBeGreaterThanOrEqual(15);
  });

  it("has unique ids", () => {
    const ids = CORRELATION_METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all five domains", () => {
    const domains = new Set(CORRELATION_METRICS.map((m) => m.domain));
    expect(domains).toContain("recovery");
    expect(domains).toContain("sleep");
    expect(domains).toContain("nutrition");
    expect(domains).toContain("activity");
    expect(domains).toContain("body");
  });

  it("has non-empty labels, units, and descriptions for every metric", () => {
    for (const m of CORRELATION_METRICS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.unit.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});

describe("describeCorrelation", () => {
  it("returns 'strong positive' for rho >= 0.7", () => {
    expect(describeCorrelation(0.7)).toBe("strong positive");
    expect(describeCorrelation(0.95)).toBe("strong positive");
  });

  it("returns 'moderate positive' for 0.4 <= rho < 0.7", () => {
    expect(describeCorrelation(0.5)).toBe("moderate positive");
  });

  it("returns 'weak positive' for 0.2 <= rho < 0.4", () => {
    expect(describeCorrelation(0.25)).toBe("weak positive");
  });

  it("returns 'negligible' for |rho| < 0.2", () => {
    expect(describeCorrelation(0.1)).toBe("negligible");
    expect(describeCorrelation(-0.05)).toBe("negligible");
    expect(describeCorrelation(0)).toBe("negligible");
  });

  it("returns negative descriptions for negative rho", () => {
    expect(describeCorrelation(-0.75)).toBe("strong negative");
    expect(describeCorrelation(-0.5)).toBe("moderate negative");
    expect(describeCorrelation(-0.3)).toBe("weak negative");
  });

  it("returns 'moderate positive' at exact boundary 0.4", () => {
    expect(describeCorrelation(0.4)).toBe("moderate positive");
  });

  it("returns 'weak positive' at exact boundary 0.2", () => {
    expect(describeCorrelation(0.2)).toBe("weak positive");
  });

  it("returns 'negligible' at exactly 0", () => {
    expect(describeCorrelation(0)).toBe("negligible");
  });
});

describe("correlationConfidence", () => {
  it("returns 'strong' for high rho + large n", () => {
    expect(correlationConfidence(0.6, 50)).toBe("strong");
  });

  it("returns 'emerging' for moderate rho + moderate n", () => {
    expect(correlationConfidence(0.4, 20)).toBe("emerging");
  });

  it("returns 'early' for weak rho + small n", () => {
    expect(correlationConfidence(0.25, 12)).toBe("early");
  });

  it("returns 'insufficient' for tiny rho or tiny n", () => {
    expect(correlationConfidence(0.1, 5)).toBe("insufficient");
    expect(correlationConfidence(0.5, 5)).toBe("insufficient");
  });

  it("returns 'strong' at exact boundaries rho=0.5 and n=30", () => {
    expect(correlationConfidence(0.5, 30)).toBe("strong");
  });

  it("returns 'emerging' at exact boundaries rho=0.35 and n=15", () => {
    expect(correlationConfidence(0.35, 15)).toBe("emerging");
  });

  it("returns 'early' at exact boundaries rho=0.2 and n=10", () => {
    expect(correlationConfidence(0.2, 10)).toBe("early");
  });
});

describe("correlationColor", () => {
  it("returns emerald for positive correlation", () => {
    expect(correlationColor(0.5)).toBe("#10b981");
  });

  it("returns rose for negative correlation", () => {
    expect(correlationColor(-0.5)).toBe("#f43f5e");
  });

  it("returns neutral for negligible correlation", () => {
    expect(correlationColor(0.05)).toBe("#71717a");
  });

  it("returns emerald at exact boundary rho=0.2", () => {
    expect(correlationColor(0.2)).toBe("#10b981");
  });

  it("returns neutral at exactly zero", () => {
    expect(correlationColor(0)).toBe("#71717a");
  });
});

describe("generateCorrelationInsight", () => {
  it("generates a descriptive sentence for a positive correlation", () => {
    const result = generateCorrelationInsight({
      xLabel: "protein intake",
      yLabel: "heart rate variability",
      rho: 0.45,
      pValue: 0.001,
      n: 200,
      lag: 0,
    });
    expect(result).toContain("protein intake");
    expect(result).toContain("heart rate variability");
    expect(result).toContain("moderately");
    expect(result).toContain("0.45");
    expect(result).toContain("200");
  });

  it("generates a 'no relationship' message for negligible correlation", () => {
    const result = generateCorrelationInsight({
      xLabel: "sleep duration",
      yLabel: "weight",
      rho: 0.03,
      pValue: 0.7,
      n: 300,
      lag: 0,
    });
    expect(result).toContain("No meaningful");
  });

  it("includes lag info when lag > 0", () => {
    const result = generateCorrelationInsight({
      xLabel: "exercise duration",
      yLabel: "heart rate variability",
      rho: 0.5,
      pValue: 0.001,
      n: 100,
      lag: 1,
    });
    expect(result).toMatch(/next.day|1.day later/i);
  });

  it("uses 'lower' for negative correlation", () => {
    const result = generateCorrelationInsight({
      xLabel: "alcohol intake",
      yLabel: "sleep quality",
      rho: -0.5,
      pValue: 0.001,
      n: 100,
      lag: 0,
    });
    expect(result).toContain("lower");
  });

  it("does not contain lag text when lag is 0", () => {
    const result = generateCorrelationInsight({
      xLabel: "protein intake",
      yLabel: "recovery score",
      rho: 0.45,
      pValue: 0.001,
      n: 100,
      lag: 0,
    });
    expect(result).not.toContain("day later");
    expect(result).not.toContain("next day");
  });

  it("uses 'strongly' for high correlation", () => {
    const result = generateCorrelationInsight({
      xLabel: "sleep duration",
      yLabel: "heart rate variability",
      rho: 0.8,
      pValue: 0.001,
      n: 100,
      lag: 0,
    });
    expect(result).toContain("strongly");
  });

  it("uses 'weakly' for weak correlation", () => {
    const result = generateCorrelationInsight({
      xLabel: "caffeine",
      yLabel: "resting heart rate",
      rho: 0.25,
      pValue: 0.05,
      n: 50,
      lag: 0,
    });
    expect(result).toContain("weakly");
  });
});

describe("pearsonCorrelation", () => {
  it("returns r = 1 for perfectly correlated data", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const result = pearsonCorrelation(x, y);
    expect(result.r).toBeCloseTo(1, 5);
    expect(result.n).toBe(5);
  });

  it("returns r = -1 for perfectly inversely correlated data", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    const result = pearsonCorrelation(x, y);
    expect(result.r).toBeCloseTo(-1, 5);
  });

  it("returns r ≈ 0 for uncorrelated data", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 1, 4, 2, 3];
    const result = pearsonCorrelation(x, y);
    expect(Math.abs(result.r)).toBeLessThan(0.5);
  });

  it("returns r = 0 and pValue = 1 for insufficient data", () => {
    const result = pearsonCorrelation([1, 2], [3, 4]);
    expect(result.r).toBe(0);
    expect(result.pValue).toBe(1);
  });

  it("returns valid r for exactly 3 data points (boundary)", () => {
    const x = [1, 2, 3];
    const y = [2, 4, 6];
    const result = pearsonCorrelation(x, y);
    expect(result.r).toBeCloseTo(1, 5);
    expect(result.n).toBe(3);
  });

  it("returns reasonable pValue for non-perfectly-correlated data", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [2, 3, 5, 4, 7, 6, 9, 8, 10, 11];
    const result = pearsonCorrelation(x, y);
    expect(result.pValue).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(1);
  });
});

describe("linearRegression", () => {
  it("computes correct slope and intercept for a perfect line", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [3, 5, 7, 9, 11]; // y = 2x + 1
    const result = linearRegression(x, y);
    expect(result.slope).toBeCloseTo(2, 5);
    expect(result.intercept).toBeCloseTo(1, 5);
    expect(result.rSquared).toBeCloseTo(1, 5);
  });

  it("returns zeros for insufficient data", () => {
    const result = linearRegression([1], [2]);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(0);
    expect(result.rSquared).toBe(0);
  });

  it("computes correct results for exactly 2 data points (boundary)", () => {
    const x = [1, 2];
    const y = [3, 5];
    const result = linearRegression(x, y);
    expect(result.slope).toBeCloseTo(2, 5);
    expect(result.intercept).toBeCloseTo(1, 5);
    expect(result.rSquared).toBeCloseTo(1, 5);
  });
});

describe("regularizedBeta", () => {
  it("returns 0 when x=0", () => {
    expect(regularizedBeta(0, 2, 3)).toBe(0);
  });

  it("returns 1 when x=1", () => {
    expect(regularizedBeta(1, 2, 3)).toBe(1);
  });

  it("returns 0.5 for I(0.5, 1, 1) (uniform beta CDF)", () => {
    expect(regularizedBeta(0.5, 1, 1)).toBeCloseTo(0.5, 5);
  });

  it("returns 0.5 for I(0.5, 2, 2) (symmetric beta)", () => {
    expect(regularizedBeta(0.5, 2, 2)).toBeCloseTo(0.5, 5);
  });

  it("returns value between 0 and 1 for x between 0 and 1", () => {
    const result = regularizedBeta(0.3, 3, 4);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("is monotonically increasing in x", () => {
    const r1 = regularizedBeta(0.2, 2, 3);
    const r2 = regularizedBeta(0.5, 2, 3);
    const r3 = regularizedBeta(0.8, 2, 3);
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
  });
});

describe("lgamma", () => {
  it("lgamma(1) = 0 since Γ(1) = 1", () => {
    expect(lgamma(1)).toBeCloseTo(0, 10);
  });

  it("lgamma(2) = 0 since Γ(2) = 1! = 1", () => {
    expect(lgamma(2)).toBeCloseTo(0, 10);
  });

  it("lgamma(3) ≈ ln(2) since Γ(3) = 2! = 2", () => {
    expect(lgamma(3)).toBeCloseTo(Math.log(2), 5);
  });

  it("lgamma(4) ≈ ln(6) since Γ(4) = 3! = 6", () => {
    expect(lgamma(4)).toBeCloseTo(Math.log(6), 5);
  });

  it("lgamma(5) ≈ ln(24) since Γ(5) = 4! = 24", () => {
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 5);
  });

  it("lgamma(0.5) ≈ ln(√π) since Γ(1/2) = √π", () => {
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 5);
  });

  it("handles values near zero (z < 0.5, reflection formula)", () => {
    const result = lgamma(0.1);
    // Γ(0.1) ≈ 9.5135, ln(9.5135) ≈ 2.2527
    expect(result).toBeCloseTo(2.2527, 3);
  });
});

describe("tCDF", () => {
  it("tCDF(0, df) = 0.5 (symmetric distribution center)", () => {
    expect(tCDF(0, 10)).toBeCloseTo(0.5, 10);
    expect(tCDF(0, 1)).toBeCloseTo(0.5, 10);
  });

  it("large negative t approaches 0", () => {
    const result = tCDF(-100, 10);
    expect(result).toBeLessThan(0.001);
  });

  it("returns value between 0 and 1", () => {
    const result = tCDF(-1.5, 5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});
