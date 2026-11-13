import { describe, expect, it } from "vitest";
import { runningCadenceLabel } from "./running-cadence.ts";

describe("runningCadenceLabel", () => {
  it("distinguishes recorded cadence from step intervals with supplied coverage", () => {
    expect(
      runningCadenceLabel({ cadenceBasis: "cadence_samples", cadenceCoveragePercent: null }),
    ).toBe("Recorded cadence");
    expect(
      runningCadenceLabel({ cadenceBasis: "step_intervals", cadenceCoveragePercent: 30 }),
    ).toBe("Steps · 30% coverage");
    expect(
      runningCadenceLabel({ cadenceBasis: "step_intervals", cadenceCoveragePercent: null }),
    ).toBe("Steps");
    expect(runningCadenceLabel({ cadenceBasis: "unknown", cadenceCoveragePercent: null })).toBe(
      "Unknown basis",
    );
  });
});
