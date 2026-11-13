import { describe, expect, it } from "vitest";
import {
  normalizedPower as evaluateNormalizedPower,
  intensityFactor,
  type PowerSample,
  powerDose,
  powerTrainingStress,
} from "./power.ts";

const coveragePolicy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};
const normalizedPower = (samples: readonly PowerSample[], duration: number) =>
  evaluateNormalizedPower(samples, duration, coveragePolicy);

describe("cycling power mathematics", () => {
  it("retains zero power in full thirty-second windows", () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({
      elapsedSeconds: i,
      watts: i < 30 ? 200 : 0,
    }));
    const expected =
      (Array.from({ length: 31 }, (_, i) => ((200 * (30 - i)) / 30) ** 4).reduce(
        (a, b) => a + b,
        0,
      ) /
        31) **
      0.25;
    expect(normalizedPower(samples, 60)).toBeCloseTo(expected, 8);
  });
  it("weights native five-second and fractional samples by elapsed coverage", () => {
    expect(
      normalizedPower(
        Array.from({ length: 12 }, (_, i) => ({ elapsedSeconds: i * 5, watts: 240 })),
        60,
      ),
    ).toBeCloseTo(240, 8);
    expect(
      normalizedPower(
        Array.from({ length: 120 }, (_, i) => ({ elapsedSeconds: i / 2, watts: 240 })),
        60,
      ),
    ).toBeCloseTo(240, 8);
  });
  it("withholds incomplete power rather than bridging gaps or partial windows", () => {
    expect(
      normalizedPower(
        [
          { elapsedSeconds: 0, watts: 240 },
          { elapsedSeconds: 60, watts: 240 },
        ],
        120,
      ),
    ).toBeNull();
    expect(
      normalizedPower(
        Array.from({ length: 29 }, (_, i) => ({ elapsedSeconds: i, watts: 240 })),
        29,
      ),
    ).toBeNull();
    const samples = Array.from({ length: 60 }, (_, i) => ({
      elapsedSeconds: i,
      watts: i === 30 ? null : 240,
    }));
    expect(normalizedPower(samples, 60)).toBeNull();
  });
  it("does not invent coverage for sparse multi-day observations", () => {
    expect(
      normalizedPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 1e7, watts: 200 },
        ],
        1e8,
      ),
    ).toBeNull();
  });
  it("uses the caller's coverage policy rather than an application-specific hold limit", () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ elapsedSeconds: i * 5, watts: 240 }));
    expect(
      evaluateNormalizedPower(samples, 60, {
        ...coveragePolicy,
        maximumHoldSeconds: 1,
        maximumGapSeconds: 1,
        minimumGapSeconds: 1,
      }),
    ).toBeNull();
  });
  it("distinguishes zero work from unavailable observations and thresholds", () => {
    expect(
      normalizedPower(
        Array.from({ length: 60 }, (_, i) => ({ elapsedSeconds: i, watts: 0 })),
        60,
      ),
    ).toBe(0);
    expect(intensityFactor(240, 240)).toBe(1);
    expect(powerTrainingStress(240, 240, 3600)).toBe(100);
    expect(powerTrainingStress(0, 240, 3600)).toBe(0);
    expect(powerTrainingStress(240, null, 3600)).toBeNull();
    expect(powerTrainingStress(null, 240, 3600)).toBeNull();
    expect(powerDose(240, 3600)).toBe(207360000);
  });
  it("rejects invalid input instead of silently repairing measurements", () => {
    expect(() => normalizedPower([], 30.9)).toThrow("integer");
    expect(() => normalizedPower([{ elapsedSeconds: 0, watts: -1 }], 60)).toThrow("nonnegative");
    expect(() =>
      normalizedPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 0, watts: 220 },
        ],
        60,
      ),
    ).toThrow("Conflicting");
    expect(() => normalizedPower([], Number.NaN)).toThrow("duration");
    expect(powerTrainingStress(Number.POSITIVE_INFINITY, 240, 3600)).toBeNull();
  });
});
