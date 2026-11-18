import { expect, it } from "vitest";
import {
  climbingAttemptIncreaseTitle,
  climbingVolumeIncreaseTitle,
  formatClimbingAttemptIncrease,
  formatClimbingVolumeIncrease,
} from "./climbing-volume.ts";

it.each([40, 40.25])("describes recorded attempts with an average of %s", (baselineAttempts) => {
  expect(climbingAttemptIncreaseTitle).toBe("Recorded climbing attempts increased");
  expect(
    formatClimbingAttemptIncrease({ recentAttempts: 50, baselineAttempts, increasePercent: 25.2 }),
  ).toBe(
    `You logged 50 climbing attempts in the last 7 days, up 25% from your recent weekly average of ${baselineAttempts}.`,
  );
});

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
