import { describe, expect, it } from "vitest";
import {
  buildSleepNeedComputation,
  MISSING_PREVIOUS_NIGHT_MESSAGE,
  type SleepNight,
  sleepNeedV1Schema,
  sleepNeedV2Schema,
  type SleepNeedV2,
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
      baselineQualifyingNightCount: 7,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: true,
      hasYesterdayLoad: true,
    });

    expect(toSleepNeedV2(computation)).toEqual({
      availability: "available",
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      debtRecoveryMinutes: 23,
      totalNeedMinutes: 515,
      estimateMetadata: {
        basis: "personalized_high_hrv_average",
        baselineQualifyingNightCount: 7,
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
          "Baseline uses the average of 7 qualifying nights followed by at-or-above-median heart rate variability.",
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
      baselineQualifyingNightCount: 7,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: false,
      hasYesterdayLoad: true,
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
      hasYesterdayLoad: true,
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
      baselineQualifyingNightCount: 7,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: true,
      hasYesterdayLoad: true,
    });

    const result = sleepNeedV1Schema.parse(toSleepNeedV1(computation));

    expect(result).toEqual({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
      totalNeedMinutes: 515,
      recentNights,
      canRecommend: true,
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

  it("returns a server-authored insufficient-baseline state instead of a generic estimate", () => {
    const result = toSleepNeedV2(
      buildSleepNeedComputation({
        baselineMinutes: 480,
        strainDebtMinutes: 12,
        accumulatedDebtMinutes: 90,
        baselineQualifyingNightCount: 6,
        debtObservedNightCount: 1,
        recentNights,
        hasPreviousNight: true,
        hasYesterdayLoad: true,
      }),
    );

    expect(result).toEqual({
      availability: "insufficient_data",
      reason: "insufficient_baseline_history",
      message: "Sync at least 7 qualifying nights to estimate sleep need.",
      nextAction: "Sync more sleep and recovery data.",
    });
    expect(result.availability).toBe("insufficient_data");
    expect((result as Extract<SleepNeedV2, { availability: "insufficient_data" }>).reason).toBe(
      "insufficient_baseline_history",
    );
  });

  it("returns a server-authored missing-load state when yesterday's load is absent", () => {
    const result = toSleepNeedV2(
      buildSleepNeedComputation({
        baselineMinutes: 480,
        strainDebtMinutes: 0,
        accumulatedDebtMinutes: 0,
        baselineQualifyingNightCount: 7,
        debtObservedNightCount: 1,
        recentNights,
        hasPreviousNight: true,
        hasYesterdayLoad: false,
      }),
    );

    expect(result).toEqual({
      availability: "insufficient_data",
      reason: "missing_previous_day_load",
      message: "Sync yesterday's activity data to include training load in sleep need.",
      nextAction: "Sync activity data for the previous day.",
    });
  });

  it("does not project sleep need to the legacy V1 DTO until its inputs are complete", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 0,
      accumulatedDebtMinutes: 0,
      baselineQualifyingNightCount: 6,
      debtObservedNightCount: 1,
      recentNights,
      hasPreviousNight: true,
      hasYesterdayLoad: true,
    });

    expect(toSleepNeedV1(computation)).toBeNull();
  });
});
