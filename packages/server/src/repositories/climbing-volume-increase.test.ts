import { describe, expect, it } from "vitest";
import { evaluateClimbingVolumeIncrease } from "./climbing-volume-increase.ts";

const microsecondsPerMinute = 60_000_000;

function workout(daysAgo: number, minutes: number) {
  return { daysAgo, durationMicroseconds: minutes * microsecondsPerMinute };
}

describe("evaluateClimbingVolumeIncrease", () => {
  it("uses the exact 7- and 28-day boundaries with quiet baseline weeks", () => {
    expect(
      evaluateClimbingVolumeIncrease([workout(34, 480), workout(7, 480), workout(6, 300)]),
    ).toEqual({
      status: "increase",
      recentMinutes: 300,
      baselineMinutes: 240,
      increasePercent: 25,
    });
  });

  it.each([
    { label: "absolute threshold", baselineMinutes: 60, recentMinutes: 90 },
    { label: "relative threshold", baselineMinutes: 480, recentMinutes: 540 },
  ])(
    "requires the $label in addition to the other threshold",
    ({ baselineMinutes, recentMinutes }) => {
      expect(
        evaluateClimbingVolumeIncrease([
          workout(7, baselineMinutes * 2),
          workout(14, baselineMinutes * 2),
          workout(0, recentMinutes),
        ]),
      ).toEqual({ status: "below_threshold" });
    },
  );

  it("keeps precision through evaluation", () => {
    expect(
      evaluateClimbingVolumeIncrease([
        workout(7, 480),
        workout(14, 480),
        { daysAgo: 0, durationMicroseconds: 300 * microsecondsPerMinute - 1 },
      ]),
    ).toEqual({ status: "below_threshold" });
  });

  it("requires timed workouts in more than one baseline block", () => {
    expect(
      evaluateClimbingVolumeIncrease([workout(7, 300), workout(13, 300), workout(0, 480)]),
    ).toEqual({ status: "insufficient_data" });
  });

  it.each([null, 0, -1])("withholds a comparison with an invalid duration of %s", (duration) => {
    expect(
      evaluateClimbingVolumeIncrease([
        workout(7, 480),
        workout(14, 480),
        workout(0, 400),
        { daysAgo: 15, durationMicroseconds: duration },
      ]),
    ).toEqual({ status: "insufficient_data" });
  });
});
