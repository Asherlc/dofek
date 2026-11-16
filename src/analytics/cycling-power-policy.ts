import type { PowerCoveragePolicy } from "@dofek/cycling-power/power";
import type { CyclingPowerPolicy } from "./cycling-power-projector.ts";
import referenceBank from "./cycling-reference-bank.json" with { type: "json" };

/** Application coverage policy shared by activity and interval adapters. */
export const cyclingPowerCoveragePolicy: PowerCoveragePolicy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};

/** Dofek policy, deliberately outside the reusable numerical package. */
export const cyclingCriticalPowerPolicy = {
  minimumDurationSeconds: 120,
  maximumDurationSeconds: 600,
};

export const cyclingPowerSuggestionPolicy = {
  referenceCurves: referenceBank.percentiles,
  thresholdPolicy: {
    minimumDurationSeconds: 180,
    maximumDurationSeconds: 1800,
    targetDurationSeconds: 3600,
  },
};

export const cyclingPowerPolicy: CyclingPowerPolicy = {
  coveragePolicy: cyclingPowerCoveragePolicy,
};
