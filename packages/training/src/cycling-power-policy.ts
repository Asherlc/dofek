import type { PowerCoveragePolicy } from "@dofek/cycling-power/power";

/** Application coverage policy shared by whole-activity and interval adapters. */
export const cyclingPowerCoveragePolicy: PowerCoveragePolicy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};
