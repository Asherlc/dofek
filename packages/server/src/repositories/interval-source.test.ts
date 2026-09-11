import { describe, expect, it } from "vitest";
import {
  type ComparableInterval,
  inferIntervalResult,
  mergeComparableIntervals,
} from "./intervals-repository.ts";

const providerMemberId = "00000000-0000-4000-8000-000000000011";
const inferredMemberId = "00000000-0000-4000-8000-000000000012";

function interval(overrides: Partial<ComparableInterval>): ComparableInterval {
  return {
    intervalIndex: 1,
    source: "inferred",
    startOffsetSeconds: 0,
    endOffsetSeconds: 300,
    label: null,
    segmentType: null,
    workRecoveryKind: null,
    sourceProvider: null,
    sourceActivityId: null,
    sourceMemberActivityIds: [],
    targetIntensity: null,
    targetZone: null,
    targetCadenceRpm: null,
    targetPowerWatts: null,
    targetResistance: null,
    raw: null,
    ...overrides,
  };
}

describe("activity interval source precedence", () => {
  it("prefers provider-recorded targets over inferred equal boundaries", () => {
    const result = mergeComparableIntervals([
      interval({ sourceMemberActivityIds: [inferredMemberId] }),
      interval({
        source: "provider_recorded",
        sourceProvider: "training-provider",
        sourceActivityId: providerMemberId,
        sourceMemberActivityIds: [providerMemberId],
        targetPowerWatts: 240,
        workRecoveryKind: "work",
      }),
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        source: "provider_recorded",
        targetPowerWatts: 240,
        workRecoveryKind: "work",
        sourceMemberActivityIds: [providerMemberId, inferredMemberId],
      }),
    ]);
  });

  it("does not invent target or completion values for inferred intervals", () => {
    expect(
      inferIntervalResult(
        interval({
          targetIntensity: 0.9,
          targetZone: 4,
          targetCadenceRpm: 95,
          targetPowerWatts: 300,
          targetResistance: 40,
          completionPct: 100,
        }),
      ),
    ).toMatchObject({
      source: "inferred",
      targetIntensity: null,
      targetZone: null,
      targetCadenceRpm: null,
      targetPowerWatts: null,
      targetResistance: null,
      completionPct: null,
    });
  });
});
