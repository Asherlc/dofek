import { describe, expect, it } from "vitest";
import { referenceBestPower } from "./power-duration-reference.ts";

describe("referenceBestPower", () => {
  it("calculates a constant one-hertz effort", () => {
    const samples = Array.from({ length: 21 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      watts: 250,
    }));

    expect(referenceBestPower(samples, 20)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 1,
      medianSampleIntervalSeconds: 1,
      observedSamples: 21,
      startOffsetSeconds: 0,
      watts: 250,
    });
  });

  it("preserves a measured zero inside the effort", () => {
    const samples = [300, 300, 0, 300, 300, 300].map((watts, elapsedSeconds) => ({
      elapsedSeconds,
      watts,
    }));

    expect(referenceBestPower(samples, 5)).toMatchObject({
      startOffsetSeconds: 0,
      watts: 240,
    });
  });

  it("integrates an irregularly sampled effort at a fractional endpoint", () => {
    const samples = [
      { elapsedSeconds: 0, watts: 100 },
      { elapsedSeconds: 1.5, watts: 200 },
      { elapsedSeconds: 3.5, watts: 300 },
      { elapsedSeconds: 5.5, watts: 400 },
    ];

    expect(referenceBestPower(samples, 5)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 2,
      medianSampleIntervalSeconds: 2,
      observedSamples: 3,
      startOffsetSeconds: 0,
      watts: 200,
    });
  });

  it("rejects candidates that cross a sensor dropout", () => {
    const samples = [
      { elapsedSeconds: 0, watts: 500 },
      { elapsedSeconds: 1, watts: 500 },
      { elapsedSeconds: 2, watts: 500 },
      { elapsedSeconds: 20, watts: 100 },
    ];

    expect(referenceBestPower(samples, 20)).toBeNull();
  });

  it("does not claim sub-resolution power from five-second samples", () => {
    const samples = [
      { elapsedSeconds: 0, watts: 200 },
      { elapsedSeconds: 5, watts: 200 },
      { elapsedSeconds: 10, watts: 200 },
    ];

    expect(referenceBestPower(samples, 1)).toBeNull();
    expect(referenceBestPower(samples, 10)).toMatchObject({
      startOffsetSeconds: 0,
      watts: 200,
    });
    expect(referenceBestPower(samples, 5)).toMatchObject({
      largestGapSeconds: 5,
      medianSampleIntervalSeconds: 5,
      observedSamples: 2,
      startOffsetSeconds: 0,
      watts: 200,
    });
  });

  it("sorts observations and selects the later strictly better rolling effort", () => {
    const samples = [
      { elapsedSeconds: 3, watts: 100 },
      { elapsedSeconds: 0, watts: 100 },
      { elapsedSeconds: 2, watts: 300 },
      { elapsedSeconds: 1, watts: 300 },
    ];

    expect(referenceBestPower(samples, 2)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 1,
      medianSampleIntervalSeconds: 1,
      observedSamples: 3,
      startOffsetSeconds: 1,
      watts: 300,
    });
  });

  it("breaks equal-power ties using the earliest non-zero sample offset", () => {
    const samples = [5, 6, 7, 8].map((elapsedSeconds) => ({ elapsedSeconds, watts: 200 }));

    expect(referenceBestPower(samples, 2)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 1,
      medianSampleIntervalSeconds: 1,
      observedSamples: 3,
      startOffsetSeconds: 5,
      watts: 200,
    });
  });

  it("uses the average of the middle intervals for an even-sized median", () => {
    const samples = [0, 1, 3, 6, 10].map((elapsedSeconds) => ({ elapsedSeconds, watts: 200 }));

    expect(referenceBestPower(samples, 2.5)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 2,
      medianSampleIntervalSeconds: 2.5,
      observedSamples: 2,
      startOffsetSeconds: 0,
      watts: 200,
    });
  });

  it("accepts a gap exactly at the continuity tolerance", () => {
    const samples = [0, 1, 2, 7].map((elapsedSeconds) => ({ elapsedSeconds, watts: 200 }));

    expect(referenceBestPower(samples, 7)).toEqual({
      coveragePct: 100,
      largestGapSeconds: 5,
      medianSampleIntervalSeconds: 1,
      observedSamples: 4,
      startOffsetSeconds: 0,
      watts: 200,
    });
  });

  it("rejects invalid durations and power samples", () => {
    expect(referenceBestPower([{ elapsedSeconds: 0, watts: 200 }], 0)).toBeNull();
    expect(referenceBestPower([{ elapsedSeconds: 0, watts: 200 }], 1)).toBeNull();
    expect(
      referenceBestPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 1, watts: 200 },
        ],
        Number.NaN,
      ),
    ).toBeNull();
    expect(
      referenceBestPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 1, watts: -1 },
        ],
        1,
      ),
    ).toBeNull();
    expect(
      referenceBestPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 1, watts: Number.NaN },
        ],
        1,
      ),
    ).toBeNull();
    expect(
      referenceBestPower(
        [
          { elapsedSeconds: 0, watts: 200 },
          { elapsedSeconds: 0, watts: 200 },
        ],
        1,
      ),
    ).toBeNull();
  });
});
