import { describe, expect, it } from "vitest";
import {
  CORRELATION_METRICS,
  correlationColor,
  correlationConfidence,
  describeCorrelation,
  generateCorrelationInsight,
  linearRegression,
  pearsonCorrelation,
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
});
