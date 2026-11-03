import { describe, expect, it } from "vitest";
import { computeTrimp } from "./pmc.ts";

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
