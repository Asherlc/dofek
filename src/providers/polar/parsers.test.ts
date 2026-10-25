import { describe, expect, it } from "vitest";
import { parsePolarExercise, parsePolarSleep } from "./parsers.ts";
import type { PolarSleep } from "./types.ts";

const sleep: PolarSleep = {
  polar_user: "https://www.polaraccesslink.com/v3/users/1",
  date: "2026-07-29",
  sleep_start_time: "2026-07-28T22:00:00Z",
  sleep_end_time: "2026-07-29T06:00:00Z",
  device_id: "device-1",
  continuity: 4,
  continuity_class: 4,
  light_sleep: 14_400,
  deep_sleep: 5_400,
  rem_sleep: 7_200,
  unrecognized_sleep_stage: 0,
  sleep_score: 90,
  total_interruption_duration: 1_800,
  sleep_charge: 4,
  sleep_goal_minutes: 480,
  sleep_rating: 4,
  hypnogram: {},
};

describe("parsePolarSleep", () => {
  it("marks the provider-supplied stage bundle as available", () => {
    expect(parsePolarSleep(sleep).stagingAvailable).toBe(true);
  });
});

it("retains exercise recording hardware without using it as source identity", () => {
  expect(
    parsePolarExercise({
      id: "exercise-1",
      upload_time: "2026-10-24T10:00:00Z",
      polar_user: "user-1",
      device: "Polar Vantage V3",
      device_id: "ABC12345",
      start_time: "2026-10-24T09:00:00Z",
      duration: "PT1H",
      calories: 300,
      sport: "CYCLING",
      has_route: false,
      detailed_sport_info: "Cycling",
    }),
  ).toMatchObject({ device: "Polar Vantage V3", deviceId: "ABC12345" });
});
