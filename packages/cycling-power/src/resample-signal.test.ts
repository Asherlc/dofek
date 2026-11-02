import { describe, expect, it } from "vitest";
import { resampleSignal } from "./resample-signal.ts";

const policy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};
describe("resampleSignal", () => {
  it("caps every observation at the caller hold even inside gap tolerance", () => {
    const result = resampleSignal(
      Array.from({ length: 12 }, (_, index) => ({ elapsedSeconds: index * 5, value: 200 })),
      60,
      { ...policy, maximumHoldSeconds: 1 },
    );
    expect(result.buckets.size).toBe(12);
  });
  it("never holds through the next explicit barrier even when inferred cadence exceeds a gap", () => {
    const result = resampleSignal(
      [
        { elapsedSeconds: 0, value: 200 },
        { elapsedSeconds: 6, value: null },
        { elapsedSeconds: 100, value: 200 },
        { elapsedSeconds: 200, value: 200 },
      ],
      210,
      { ...policy, minimumGapSeconds: 1, maximumGapSeconds: 1 },
    );
    expect(result.buckets.has(5)).toBe(true);
    expect(result.buckets.has(6)).toBe(false);
    expect(result.buckets.has(9)).toBe(false);
  });
  it("weights fractional observations while retaining native peaks and negative signals", () => {
    const result = resampleSignal(
      [
        { elapsedSeconds: 0, value: -2 },
        { elapsedSeconds: 0.5, value: 6 },
        { elapsedSeconds: 1, value: 2 },
        { elapsedSeconds: 1.5, value: 2 },
      ],
      2,
      policy,
    );
    expect(result.buckets.get(0)).toEqual({ value: 2, maximumValue: 6, coveredDuration: 1 });
    expect(result.maximumValue).toBe(6);
    expect(result.coverage.coveredSeconds).toBe(2);
  });
  it("makes duplicate null barriers deterministic and rejects conflicting finite observations", () => {
    const samples = [
      { elapsedSeconds: 0, value: 200 },
      { elapsedSeconds: 1, value: 200 },
      { elapsedSeconds: 1, value: null },
      { elapsedSeconds: 2, value: 200 },
    ];
    const first = resampleSignal(samples, 3, policy);
    expect(first).toEqual(resampleSignal([...samples].reverse(), 3, policy));
    expect(first.buckets.has(1)).toBe(false);
    expect(first.coverage.observedSamples).toBe(2);
    expect(() =>
      resampleSignal(
        [
          { elapsedSeconds: 0, value: 1 },
          { elapsedSeconds: 0, value: 2 },
        ],
        3,
        policy,
      ),
    ).toThrow("Conflicting");
  });
  it("keeps sparse allocation bounded by observations and caller hold", () => {
    const result = resampleSignal(
      [
        { elapsedSeconds: 0, value: 2 },
        { elapsedSeconds: 1e7, value: 3 },
      ],
      1e8,
      policy,
    );
    expect(result.buckets.size).toBe(20);
    expect(result.coverage.missingSeconds).toBe(1e8 - 20);
  });
  it("requires integer elapsed duration and finite samples and policy", () => {
    expect(() => resampleSignal([], 30.9, policy)).toThrow("integer");
    expect(() => resampleSignal([{ elapsedSeconds: 0, value: Number.NaN }], 30, policy)).toThrow(
      "finite",
    );
    expect(() => resampleSignal([], 30, { ...policy, maximumHoldSeconds: Infinity })).toThrow(
      "policy",
    );
  });
});
