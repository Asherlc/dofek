import { describe, expect, it, vi } from "vitest";

const mockLinearRegression = vi.fn();
vi.mock("@dofek/cycling-power/regression", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    linearRegression: (...args: unknown[]) => mockLinearRegression(...args),
  };
});

import { buildTssModel, computeHrTss, computeTrimp } from "./pmc.ts";

// --- computeTrimp ---

describe("computeTrimp", () => {
  it("returns 0 when maxHr equals restingHr", () => {
    expect(computeTrimp(60, 150, 60, 60)).toBe(0);
  });

  it("returns 0 when maxHr less than restingHr", () => {
    expect(computeTrimp(60, 150, 50, 60)).toBe(0);
  });

  it("returns 0 when duration is 0", () => {
    expect(computeTrimp(0, 155, 190, 55)).toBe(0);
  });

  it("returns 0 when duration is negative", () => {
    expect(computeTrimp(-10, 155, 190, 55)).toBe(0);
  });

  it("returns 0 when avgHr equals restingHr (deltaHrRatio is 0)", () => {
    expect(computeTrimp(60, 55, 190, 55)).toBe(0);
  });

  it("returns 0 when avgHr below restingHr (deltaHrRatio negative)", () => {
    expect(computeTrimp(60, 50, 190, 55)).toBe(0);
  });

  it("computes correct TRIMP for known inputs", () => {
    // deltaHrRatio = (155-55)/(190-55) = 100/135
    const deltaHrRatio = (155 - 55) / (190 - 55);
    const expected = 60 * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
    expect(computeTrimp(60, 155, 190, 55)).toBeCloseTo(expected, 5);
  });

  it("scales linearly with duration", () => {
    const trimp30 = computeTrimp(30, 155, 190, 55);
    const trimp60 = computeTrimp(60, 155, 190, 55);
    expect(trimp60).toBeCloseTo(trimp30 * 2, 5);
  });

  it("increases more than linearly with HR due to exponential", () => {
    const trimpLow = computeTrimp(60, 120, 190, 55);
    const trimpHigh = computeTrimp(60, 170, 190, 55);
    expect(trimpHigh).toBeGreaterThan(trimpLow);
    // Verify exponential by checking ratio > linear HR ratio
    const hrRatioLow = (120 - 55) / (190 - 55);
    const hrRatioHigh = (170 - 55) / (190 - 55);
    expect(trimpHigh / trimpLow).toBeGreaterThan(hrRatioHigh / hrRatioLow);
  });

  it("uses 0.64 coefficient and 1.92 exponent factor", () => {
    // For a simple case: durationMin=1, avgHr=190, maxHr=190, restingHr=0
    // deltaHrRatio = 1.0
    // trimp = 1 * 1.0 * 0.64 * exp(1.92 * 1.0)
    const expected = 1 * 1.0 * 0.64 * Math.exp(1.92);
    expect(computeTrimp(1, 190, 190, 0)).toBeCloseTo(expected, 5);
  });
});

// --- computeHrTss ---

describe("computeHrTss", () => {
  it("returns 0 when maxHr <= restingHr", () => {
    expect(computeHrTss(60, 150, 60, 60)).toBe(0);
  });

  it("returns 0 when durationMin is 0", () => {
    expect(computeHrTss(0, 155, 190, 55)).toBe(0);
  });

  it("returns ~100 for 1 hour at threshold HR", () => {
    // Threshold HR = restingHr + 0.85 * (maxHr - restingHr)
    const maxHr = 190;
    const restingHr = 55;
    const thresholdHr = restingHr + (maxHr - restingHr) * 0.85;
    const result = computeHrTss(60, thresholdHr, maxHr, restingHr);
    expect(result).toBeCloseTo(100, 0);
  });

  it("returns less than 100 for sub-threshold effort", () => {
    expect(computeHrTss(60, 130, 190, 55)).toBeLessThan(100);
    expect(computeHrTss(60, 130, 190, 55)).toBeGreaterThan(0);
  });

  it("returns more than 100 for supra-threshold effort", () => {
    expect(computeHrTss(60, 180, 190, 55)).toBeGreaterThan(100);
  });

  it("computes correct value using trimp ratio", () => {
    const trimp = computeTrimp(60, 155, 190, 55);
    const thresholdDeltaRatio = 0.85;
    const thresholdTrimp = 60 * thresholdDeltaRatio * 0.64 * Math.exp(1.92 * thresholdDeltaRatio);
    const expected = (trimp / thresholdTrimp) * 100;
    expect(computeHrTss(60, 155, 190, 55)).toBeCloseTo(expected, 5);
  });
});

describe("buildTssModel", () => {
  it("returns null when fewer than 10 data points", () => {
    const paired = Array.from({ length: 9 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 12 + 15,
    }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when exactly 0 data points", () => {
    expect(buildTssModel([])).toBeNull();
  });

  it("returns null when r2 below 0.3", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, r2: 0.2 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: Math.random() * 100,
    }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when r2 exactly 0.3 threshold boundary", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, r2: 0.29 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 60 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns model when r2 exactly 0.3", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, r2: 0.3 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 60 }));
    expect(buildTssModel(paired)).not.toBeNull();
  });

  it("returns null when slope is 0", () => {
    mockLinearRegression.mockReturnValue({ slope: 0, intercept: 50, r2: 0.5 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 50 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns null when slope is negative", () => {
    mockLinearRegression.mockReturnValue({ slope: -0.5, intercept: 100, r2: 0.5 });
    const paired = Array.from({ length: 10 }, () => ({ trimp: 50, powerTss: 50 }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("returns model when r2 >= 0.3 and slope > 0", () => {
    mockLinearRegression.mockReturnValue({ slope: 0.8, intercept: 5, r2: 0.7 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 8 + 13,
    }));
    const result = buildTssModel(paired);
    expect(result).toEqual({ slope: 0.8, intercept: 5, r2: 0.7 });
  });

  it("passes correct xs and ys to linearRegression", () => {
    mockLinearRegression.mockReturnValue({ slope: 1, intercept: 0, r2: 0.9 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: (i + 1) * 10,
      powerTss: (i + 1) * 12,
    }));
    buildTssModel(paired);
    expect(mockLinearRegression).toHaveBeenCalledWith(
      paired.map((p) => p.trimp),
      paired.map((p) => p.powerTss),
    );
  });

  it("returns model with exactly 10 data points", () => {
    mockLinearRegression.mockReturnValue({ slope: 1.2, intercept: 10, r2: 0.85 });
    const paired = Array.from({ length: 10 }, (_, i) => ({
      trimp: i * 10 + 10,
      powerTss: i * 12 + 22,
    }));
    expect(buildTssModel(paired)).not.toBeNull();
  });
});

// --- estimateFtp ---
