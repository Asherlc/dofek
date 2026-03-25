import { describe, expect, it } from "vitest";
import { formatYearsDelta, scoreToYearsDelta } from "./healthspan-years.ts";

describe("scoreToYearsDelta", () => {
  it("returns +3 years for score 0 (worst health)", () => {
    expect(scoreToYearsDelta(0)).toBe(3);
  });

  it("returns 0 years for score 50 (average health)", () => {
    expect(scoreToYearsDelta(50)).toBe(0);
  });

  it("returns -2 years for score 100 (best health)", () => {
    expect(scoreToYearsDelta(100)).toBe(-2);
  });

  it("interpolates linearly between 0 and 50", () => {
    // 25 is midpoint of 0-50 range: delta should be +1.5
    expect(scoreToYearsDelta(25)).toBe(1.5);
  });

  it("interpolates linearly between 50 and 100", () => {
    // 75 is midpoint of 50-100 range: delta should be -1
    expect(scoreToYearsDelta(75)).toBe(-1);
  });

  it("clamps below 0", () => {
    expect(scoreToYearsDelta(-10)).toBe(3);
  });

  it("clamps above 100", () => {
    expect(scoreToYearsDelta(110)).toBe(-2);
  });
});

describe("formatYearsDelta", () => {
  it("formats positive years with + sign", () => {
    expect(formatYearsDelta(1.5)).toBe("+1.5 yr");
  });

  it("formats negative years with - sign", () => {
    expect(formatYearsDelta(-2)).toBe("-2.0 yr");
  });

  it("formats zero as +0.0 yr", () => {
    expect(formatYearsDelta(0)).toBe("+0.0 yr");
  });

  it("formats fractional values to one decimal", () => {
    expect(formatYearsDelta(1.23)).toBe("+1.2 yr");
    expect(formatYearsDelta(-0.87)).toBe("-0.9 yr");
  });
});
