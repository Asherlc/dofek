import { describe, expect, it } from "vitest";
import { parseOuraSleep } from "./parsing.ts";
import type { OuraSleepDocument } from "./schemas.ts";

const completeSleep: OuraSleepDocument = {
  id: "sleep-1",
  day: "2026-07-29",
  bedtime_start: "2026-07-28T22:00:00Z",
  bedtime_end: "2026-07-29T06:00:00Z",
  total_sleep_duration: 28_800,
  deep_sleep_duration: 5_400,
  rem_sleep_duration: 7_200,
  light_sleep_duration: 14_400,
  awake_time: 1_800,
  efficiency: 90,
  type: "long_sleep",
  average_heart_rate: 52,
  lowest_heart_rate: 45,
  average_hrv: 48,
  time_in_bed: 30_600,
  readiness_score_delta: null,
  latency: 300,
};

describe("parseOuraSleep staging availability", () => {
  it("marks a complete provider stage bundle as available", () => {
    expect(parseOuraSleep(completeSleep).stagingAvailable).toBe(true);
  });

  it.each([
    "deep_sleep_duration",
    "rem_sleep_duration",
    "light_sleep_duration",
    "awake_time",
  ] as const)("marks staging unavailable when %s is absent", (missingStage) => {
    const parsed = parseOuraSleep({ ...completeSleep, [missingStage]: null });

    expect(parsed.stagingAvailable).toBe(false);
  });
});
