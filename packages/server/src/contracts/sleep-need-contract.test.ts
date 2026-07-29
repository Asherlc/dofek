import { describe, expect, it } from "vitest";
import {
  buildSleepNeedComputation,
  MISSING_PREVIOUS_NIGHT_MESSAGE,
  type SleepNight,
  sleepNeedV1Schema,
  sleepNeedV2Schema,
  toSleepNeedV1,
  toSleepNeedV2,
} from "./sleep-need-contract.ts";

const recentNights: SleepNight[] = [
  {
    date: "2026-07-27",
    actualMinutes: 420,
    neededMinutes: 480,
    debtMinutes: 60,
    providerId: "apple_health",
    sourceName: "Apple Watch",
    sourceProviders: ["apple_health"],
  },
];

describe("sleep need contract", () => {
  it("builds the available V2 variant with server-owned debt recovery", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      baselineQualifyingNightCount: 1,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: true,
    });

    expect(toSleepNeedV2(computation)).toEqual({
      availability: "available",
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      debtRecoveryMinutes: 23,
      totalNeedMinutes: 515,
      estimateMetadata: {
        basis: "generic_eight_hour_default",
        baselineQualifyingNightCount: 1,
        debtObservedNightCount: 1,
        methodVersion: "sleep-need-heuristic-v1",
        uncertainty: "not_established",
        valueQualifier: "About",
        summaryLabel: "Heuristic estimate",
        componentLabels: {
          baseline: "Baseline estimate",
          strainDebt: "Previous-day load adjustment",
          debtRecovery: "Debt recovery",
        },
        basisLabel:
          "Baseline uses a generic 8-hour default because 1 qualifying night is below the 7-night minimum.",
        coverageLabel:
          "Sleep-debt input uses 1 observed night from the model's recent-night window.",
        methodLabel: "Method: sleep-need-heuristic-v1",
        uncertaintyLabel: "Uncertainty: not established",
        limitationLabel:
          "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
      },
      recentNights,
    });
  });

  it("builds a strict missing-previous-night V2 variant without recommendation values", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      baselineQualifyingNightCount: 1,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: false,
    });

    const result = toSleepNeedV2(computation);

    expect(result).toEqual({
      availability: "missing_previous_night",
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    });
    expect(
      sleepNeedV2Schema.safeParse({
        ...result,
        totalNeedMinutes: computation.totalNeedMinutes,
      }).success,
    ).toBe(false);
  });

  it("describes a personalized basis and plural observed-night coverage", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 455,
      strainDebtMinutes: 10,
      accumulatedDebtMinutes: 40,
      baselineQualifyingNightCount: 7,
      debtObservedNightCount: 0,
      recentNights,
      hasPreviousNight: true,
    });

    const result = toSleepNeedV2(computation);
    if (result.availability !== "available") {
      throw new Error("Expected available sleep need");
    }

    expect(result.estimateMetadata).toMatchObject({
      basis: "personalized_high_hrv_average",
      baselineQualifyingNightCount: 7,
      debtObservedNightCount: 0,
      basisLabel:
        "Baseline uses the average of 7 qualifying nights followed by at-or-above-median heart rate variability.",
      coverageLabel:
        "Sleep-debt input uses 0 observed nights from the model's recent-night window.",
    });
  });

  it("preserves the exact V1 DTO as a projection of the canonical computation", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      baselineQualifyingNightCount: 1,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: false,
    });

    const result = sleepNeedV1Schema.parse(toSleepNeedV1(computation));

    expect(result).toEqual({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      totalNeedMinutes: 515,
      recentNights,
      canRecommend: false,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "accumulatedDebtMinutes",
        "baselineMinutes",
        "canRecommend",
        "recentNights",
        "strainDebtMinutes",
        "totalNeedMinutes",
      ].sort(),
    );
  });
});
