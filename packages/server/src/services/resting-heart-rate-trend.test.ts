import { describe, expect, it } from "vitest";
import { computeRestingHeartRateTrendDirection } from "./resting-heart-rate-trend.ts";

describe("computeRestingHeartRateTrendDirection", () => {
  it.each<{
    name: string;
    readings: [number | null, number | null][];
    direction: "up" | "down" | "stable" | null;
  }>([
    {
      name: "uses the last two averages when raw readings fall",
      readings: [
        [58, 60],
        [56, 53],
        [54, 55],
      ],
      direction: "up",
    },
    {
      name: "reports falling averages when raw readings rise",
      readings: [
        [54, 55],
        [56, 53],
      ],
      direction: "down",
    },
    {
      name: "reports equal averages as stable",
      readings: [
        [56, 53],
        [54, 53],
      ],
      direction: "stable",
    },
    {
      name: "skips missing readings and averages before comparing the latest available pair",
      readings: [
        [56, 55],
        [null, 60],
        [54, null],
        [52, 53],
        [null, 40],
      ],
      direction: "down",
    },
    { name: "has no direction without readings", readings: [], direction: null },
    { name: "has no direction with one average", readings: [[54, 53]], direction: null },
    {
      name: "does not compare averages outside the displayed last fourteen rows",
      readings: [
        [56, 53],
        [54, 55],
        ...Array.from({ length: 13 }, (): [null, null] => [null, null]),
        [52, 54],
      ],
      direction: null,
    },
  ])("$name", ({ readings, direction }) => {
    const rows = readings.map(([resting_hr, resting_hr_mean_7d]) => ({
      resting_hr,
      resting_hr_mean_7d,
    }));

    expect(computeRestingHeartRateTrendDirection(rows)).toBe(direction);
  });
});
