import { describe, expect, it } from "vitest";
import { evaluateClimbingAttemptIncrease } from "./climbing-attempt-increase.ts";

function days(start: number, counts: (number | null)[]) {
  return counts.map((attempts, index) => ({ daysAgo: start + index, attempts }));
}

const baseline = days(7, [20, 20, 20, 20, 20, 20, null, 40, null, null]);

describe("evaluateClimbingAttemptIncrease", () => {
  it("triggers at both thresholds with 70 percent baseline coverage", () => {
    expect(evaluateClimbingAttemptIncrease([...baseline, ...days(0, [20, 20, 10, null])])).toEqual({
      status: "increase",
      recentAttempts: 50,
      baselineAttempts: 40,
      increasePercent: 25,
    });
  });

  it("accepts a coverage gap of exactly 15 percentage points", () => {
    const wellLoggedBaseline = days(7, [16, 16, 16, 16, 16, 16, 16, 24, 24, null]);
    expect(
      evaluateClimbingAttemptIncrease([...wellLoggedBaseline, ...days(0, [20, 20, 10, null])]),
    ).toMatchObject({ status: "increase" });
  });

  it.each([
    [20, 20, 20, null, null],
    [20, 20, 20],
  ])("withholds a comparison when coverage is too low or too different (%j)", (...recent) => {
    expect(evaluateClimbingAttemptIncrease([...baseline, ...days(0, recent)])).toEqual({
      status: "insufficient_data",
    });
  });

  it("requires at least 70 percent baseline coverage", () => {
    expect(
      evaluateClimbingAttemptIncrease([
        ...baseline,
        { daysAgo: 17, attempts: null },
        ...days(0, [20, 20, 20, null]),
      ]),
    ).toEqual({ status: "insufficient_data" });
  });

  it("requires counts from at least two baseline weeks", () => {
    expect(
      evaluateClimbingAttemptIncrease([...days(7, [20, 20, 20]), ...days(0, [40, 40])]),
    ).toEqual({ status: "insufficient_data" });
  });

  it.each([
    { baselineTotal: 80, recent: 28 },
    { baselineTotal: 200, recent: 60 },
  ])("requires both the relative and absolute thresholds", ({ baselineTotal, recent }) => {
    expect(
      evaluateClimbingAttemptIncrease([
        { daysAgo: 7, attempts: baselineTotal / 2 },
        { daysAgo: 34, attempts: baselineTotal / 2 },
        { daysAgo: 6, attempts: recent },
      ]),
    ).toEqual({ status: "below_threshold" });
  });
});
