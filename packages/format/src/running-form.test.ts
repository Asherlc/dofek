import { describe, expect, it } from "vitest";
import { formatRunningFormMeasurements } from "./running-form.ts";

describe("formatRunningFormMeasurements", () => {
  it("keeps only available form readings with readable labels and cadence evidence", () => {
    expect(
      formatRunningFormMeasurements({
        cadence: 180,
        cadenceBasis: "step_intervals",
        cadenceObservedSeconds: 180,
        cadenceCoveragePercent: 30,
        strideLengthMeters: 1.2,
        stanceTimeMs: 210,
        verticalOscillationMm: 8.5,
      }),
    ).toEqual([
      { label: "Cadence", value: "180 spm", qualifier: "Steps · 30% coverage" },
      { label: "Stride length", value: "1.20 m" },
      { label: "Ground contact time", value: "210 ms" },
      { label: "Vertical oscillation", value: "8.5 mm" },
    ]);
  });

  it("preserves a zero reading and steps coverage without inventing missing values", () => {
    expect(
      formatRunningFormMeasurements({
        cadence: 0,
        cadenceBasis: "step_intervals",
        cadenceObservedSeconds: 60,
        cadenceCoveragePercent: 0,
        strideLengthMeters: null,
        stanceTimeMs: 240,
        verticalOscillationMm: null,
      }),
    ).toEqual([
      { label: "Cadence", value: "0 spm", qualifier: "Steps · 0% coverage" },
      { label: "Ground contact time", value: "240 ms" },
    ]);
  });

  it("returns no readings for a form with no measurements", () => {
    expect(
      formatRunningFormMeasurements({
        cadence: null,
        cadenceBasis: "unknown",
        cadenceObservedSeconds: null,
        cadenceCoveragePercent: null,
        strideLengthMeters: null,
        stanceTimeMs: null,
        verticalOscillationMm: null,
      }),
    ).toEqual([]);
  });
});
