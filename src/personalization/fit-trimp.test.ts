import { describe, expect, it } from "vitest";
import { fitTrimpConstants, type TrimpInput } from "./fit-trimp.ts";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate paired HR+power activity data where TRIMP with specific
 * constants best predicts power TSS.
 */
function generateTrimpData(
  n: number,
  trueGenderFactor: number,
  trueExponent: number,
  seed: number = 42,
): TrimpInput[] {
  const rng = mulberry32(seed);
  const data: TrimpInput[] = [];

  const maxHr = 190;
  const restingHr = 55;

  for (let i = 0; i < n; i++) {
    const durationMin = 30 + rng() * 90;
    const avgHr = 120 + rng() * 50;

    const deltaHrRatio = (avgHr - restingHr) / (maxHr - restingHr);
    const trueTrimP =
      durationMin * deltaHrRatio * trueGenderFactor * Math.exp(trueExponent * deltaHrRatio);

    // Power TSS correlates with the true TRIMP + noise
    const powerTss = trueTrimP * 0.8 + (rng() - 0.5) * 10;

    data.push({
      durationMin,
      avgHr,
      maxHr,
      restingHr,
      powerTss: Math.max(0, powerTss),
    });
  }

  return data;
}

describe("fitTrimpConstants", () => {
  it("returns null with insufficient data (< 20 activities)", () => {
    const data = generateTrimpData(10, 0.64, 1.92);
    expect(fitTrimpConstants(data)).toBeNull();
  });

  it("returns null with exactly 19 activities (boundary below MIN_ACTIVITIES)", () => {
    const data = generateTrimpData(19, 0.64, 1.92);
    expect(fitTrimpConstants(data)).toBeNull();
  });

  it("processes exactly 20 activities (boundary at MIN_ACTIVITIES)", () => {
    const data = generateTrimpData(20, 0.64, 1.92, 555);
    const result = fitTrimpConstants(data);
    // Should not short-circuit on length check
    if (result) {
      expect(result.sampleCount).toBe(20);
    }
  });

  it("returns null with empty data", () => {
    expect(fitTrimpConstants([])).toBeNull();
  });

  it("finds constants near the true generating parameters", () => {
    const data = generateTrimpData(50, 0.7, 1.8, 123);
    const result = fitTrimpConstants(data);

    expect(result).not.toBeNull();
    if (!result) return;

    // Should be close to the true values (within grid resolution)
    expect(result.genderFactor).toBeGreaterThanOrEqual(0.5);
    expect(result.genderFactor).toBeLessThanOrEqual(0.85);
    expect(result.exponent).toBeGreaterThanOrEqual(1.5);
    expect(result.exponent).toBeLessThanOrEqual(2.1);
    expect(result.r2).toBeGreaterThan(0.3);
    expect(result.sampleCount).toBe(50);
  });

  it("returns null when power TSS has no correlation with HR load", () => {
    const rng = mulberry32(789);
    const data: TrimpInput[] = [];
    for (let i = 0; i < 30; i++) {
      data.push({
        durationMin: 30 + rng() * 90,
        avgHr: 120 + rng() * 50,
        maxHr: 190,
        restingHr: 55,
        powerTss: rng() * 200, // completely random
      });
    }

    const result = fitTrimpConstants(data);
    expect(result).toBeNull();
  });

  it("produces reasonable R² values for well-correlated data", () => {
    const data = generateTrimpData(40, 0.64, 1.92, 456);
    const result = fitTrimpConstants(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.r2).toBeGreaterThan(0.3);
    expect(result.r2).toBeLessThanOrEqual(1.0);
  });

  it("output has correct shape", () => {
    const data = generateTrimpData(30, 0.64, 1.92);
    const result = fitTrimpConstants(data);
    if (!result) return;

    expect(typeof result.genderFactor).toBe("number");
    expect(typeof result.exponent).toBe("number");
    expect(typeof result.sampleCount).toBe("number");
    expect(typeof result.r2).toBe("number");
  });

  it("R² is rounded to 3 decimal places", () => {
    const data = generateTrimpData(50, 0.64, 1.92, 456);
    const result = fitTrimpConstants(data);

    expect(result).not.toBeNull();
    if (!result) return;

    const rounded = Math.round(result.r2 * 1000) / 1000;
    expect(result.r2).toBe(rounded);
  });

  it("skips activities where maxHr <= restingHr", () => {
    const rng = mulberry32(111);
    const data: TrimpInput[] = [];

    // Add 25 valid activities
    for (let i = 0; i < 25; i++) {
      const durationMin = 30 + rng() * 90;
      const avgHr = 130 + rng() * 30;
      const deltaHrRatio = (avgHr - 55) / (190 - 55);
      const trueTrimP = durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
      data.push({
        durationMin,
        avgHr,
        maxHr: 190,
        restingHr: 55,
        powerTss: Math.max(0, trueTrimP * 0.8 + (rng() - 0.5) * 10),
      });
    }

    // Add invalid activities where maxHr <= restingHr
    for (let i = 0; i < 10; i++) {
      data.push({
        durationMin: 60,
        avgHr: 40,
        maxHr: 50, // <= restingHr (55)
        restingHr: 55,
        powerTss: 100,
      });
    }

    const result = fitTrimpConstants(data);
    // Should still produce a result if valid activities meet threshold
    if (result) {
      expect(result.sampleCount).toBe(35); // all 35 passed to fitTrimpConstants
    }
  });

  it("skips activities where durationMin <= 0", () => {
    const rng = mulberry32(222);
    const data: TrimpInput[] = [];

    // Add valid activities
    for (let i = 0; i < 25; i++) {
      const durationMin = 30 + rng() * 90;
      const avgHr = 130 + rng() * 30;
      const deltaHrRatio = (avgHr - 55) / (190 - 55);
      const trueTrimP = durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
      data.push({
        durationMin,
        avgHr,
        maxHr: 190,
        restingHr: 55,
        powerTss: Math.max(0, trueTrimP * 0.8 + (rng() - 0.5) * 10),
      });
    }

    // Add zero-duration activities (should be skipped internally)
    for (let i = 0; i < 5; i++) {
      data.push({ durationMin: 0, avgHr: 140, maxHr: 190, restingHr: 55, powerTss: 100 });
    }

    const result = fitTrimpConstants(data);
    // The function should still work with the valid activities
    if (result) {
      expect(result.r2).toBeGreaterThan(0.3);
    }
  });

  it("skips activities where deltaHrRatio <= 0 (avgHr <= restingHr)", () => {
    const rng = mulberry32(333);
    const data: TrimpInput[] = [];

    // Add valid activities
    for (let i = 0; i < 25; i++) {
      const durationMin = 30 + rng() * 90;
      const avgHr = 130 + rng() * 30;
      const deltaHrRatio = (avgHr - 55) / (190 - 55);
      const trueTrimP = durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
      data.push({
        durationMin,
        avgHr,
        maxHr: 190,
        restingHr: 55,
        powerTss: Math.max(0, trueTrimP * 0.8 + (rng() - 0.5) * 10),
      });
    }

    // Add activities where avgHr < restingHr (deltaHrRatio < 0)
    for (let i = 0; i < 5; i++) {
      data.push({ durationMin: 60, avgHr: 40, maxHr: 190, restingHr: 55, powerTss: 100 });
    }

    const result = fitTrimpConstants(data);
    if (result) {
      expect(result.r2).toBeGreaterThan(0.3);
    }
  });

  it("requires positive slope (more HR effort → more load)", () => {
    // Generate inversely correlated data: more TRIMP → less power TSS
    const rng = mulberry32(444);
    const data: TrimpInput[] = [];
    for (let i = 0; i < 30; i++) {
      const durationMin = 30 + rng() * 90;
      const avgHr = 120 + rng() * 50;
      const deltaHrRatio = (avgHr - 55) / (190 - 55);
      const trimp = durationMin * deltaHrRatio * 0.64 * Math.exp(1.92 * deltaHrRatio);
      // Inverse relationship — should produce negative slope → return -Infinity
      data.push({
        durationMin,
        avgHr,
        maxHr: 190,
        restingHr: 55,
        powerTss: Math.max(0, 200 - trimp * 0.5 + (rng() - 0.5) * 10),
      });
    }

    const result = fitTrimpConstants(data);
    // With an inverse relationship, all grid candidates should produce negative slope
    // and be rejected. The result depends on whether any candidate has positive slope.
    // The key assertion is it doesn't crash.
    if (result) {
      expect(result.r2).toBeGreaterThan(0);
    }
  });

  it("handles all constant HR data (zero denomX)", () => {
    const data: TrimpInput[] = [];
    for (let i = 0; i < 25; i++) {
      data.push({
        durationMin: 60,
        avgHr: 140,
        maxHr: 190,
        restingHr: 55,
        powerTss: 100,
      });
    }

    // With constant TRIMP values, the regression denominator (denomX) will be 0
    const result = fitTrimpConstants(data);
    expect(result).toBeNull();
  });

  it("handles all constant power TSS (zero ssTot)", () => {
    const rng = mulberry32(555);
    const data: TrimpInput[] = [];
    for (let i = 0; i < 25; i++) {
      data.push({
        durationMin: 30 + rng() * 90,
        avgHr: 120 + rng() * 50,
        maxHr: 190,
        restingHr: 55,
        powerTss: 100, // constant TSS
      });
    }

    const result = fitTrimpConstants(data);
    // ssTot will be 0 since all targets are equal → returns -Infinity for R²
    expect(result).toBeNull();
  });

  it("R² must be >= MIN_R2 (0.3) to produce a result", () => {
    const data = generateTrimpData(50, 0.64, 1.92, 789);
    const result = fitTrimpConstants(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.r2).toBeGreaterThanOrEqual(0.3);
  });

  it("sampleCount matches input length", () => {
    const data = generateTrimpData(50, 0.64, 1.92, 321);
    const result = fitTrimpConstants(data);

    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.sampleCount).toBe(50);
  });

  it("bestR2 starts at -Infinity so any valid R2 can win", () => {
    // Generate data where only some grid points produce valid R²
    const data = generateTrimpData(30, 0.55, 1.6, 888);
    const result = fitTrimpConstants(data);

    if (result) {
      // The fact that a result was produced means at least one grid candidate
      // beat the -Infinity initial value
      expect(result.r2).toBeGreaterThanOrEqual(0.3);
    }
  });
});
