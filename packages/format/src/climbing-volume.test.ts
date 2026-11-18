import { expect, it } from "vitest";
import { climbingVolumeIncreaseTitle, formatClimbingVolumeIncrease } from "./climbing-volume.ts";

it("describes the recent climbing duration and rounded increase over the weekly baseline", () => {
  expect(climbingVolumeIncreaseTitle).toBe("Climbing volume increased");
  expect(
    formatClimbingVolumeIncrease({
      recentMinutes: 300,
      baselineMinutes: 210,
      increasePercent: 42.857,
    }),
  ).toBe(
    "You logged 5 hours of climbing in the last 7 days, up 43% from your recent weekly average of 3 hours 30 minutes.",
  );
});
