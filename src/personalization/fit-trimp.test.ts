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
});
