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
      recentNights,
    });
  });

  it("builds a strict missing-previous-night V2 variant without recommendation values", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
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

  it("preserves the exact V1 DTO as a projection of the canonical computation", () => {
    const computation = buildSleepNeedComputation({
      baselineMinutes: 480,
      strainDebtMinutes: 12,
      accumulatedDebtMinutes: 90,
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
