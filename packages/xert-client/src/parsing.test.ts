import { describe, expect, it } from "vitest";
import { mapXertSport, parseXertActivity } from "./parsing.ts";
import type { XertActivity } from "./types.ts";

function activity(overrides: Partial<XertActivity> = {}): XertActivity {
  return {
    id: 12345,
    name: "Morning Ride",
    sport: "Cycling",
    startTimestamp: 1_709_290_800,
    endTimestamp: 1_709_294_400,
    duration: 3600,
    distance: 30_000,
    power_avg: 200,
    power_max: 450,
    power_normalized: 220,
    heartrate_avg: 145,
    heartrate_max: 175,
    cadence_avg: 85,
    cadence_max: 110,
    elevation_gain: 300,
    elevation_loss: 280,
    xss: 85,
    focus: 120,
    difficulty: 3,
    ...overrides,
  };
}

describe("mapXertSport", () => {
  it.each([
    ["Cycling", "cycling"],
    ["Running", "running"],
    ["Swimming", "swimming"],
    ["Walking", "walking"],
    ["Hiking", "hiking"],
    ["Rowing", "rowing"],
    ["Skiing", "skiing"],
    ["Virtual Cycling", "cycling"],
    ["Mountain Biking", "cycling"],
    ["Trail Running", "running"],
    ["Cross Country Skiing", "skiing"],
  ] as const)("maps %s to %s", (sport, expected) => {
    expect(mapXertSport(sport).canonicalType).toBe(expected);
  });

  it("maps unknown sports to other", () => {
    expect(mapXertSport("Juggling").canonicalType).toBe("other");
  });
});

describe("parseXertActivity", () => {
  it("normalizes identity, timestamps, sport, and observed metrics", () => {
    const parsed = parseXertActivity(activity());

    expect(parsed).toEqual({
      externalId: "12345",
      activityType: {
        canonicalType: "cycling",
        providerType: "Cycling",
        modality: null,
      },
      name: "Morning Ride",
      startedAt: new Date(1_709_290_800_000),
      endedAt: new Date(1_709_294_400_000),
      raw: {
        sport: "Cycling",
        duration: 3600,
        distance: 30_000,
        powerAvg: 200,
        powerMax: 450,
        powerNormalized: 220,
        heartrateAvg: 145,
        heartrateMax: 175,
        cadenceAvg: 85,
        cadenceMax: 110,
        elevationGain: 300,
        elevationLoss: 280,
        xss: 85,
        focus: 120,
        difficulty: 3,
      },
    });
  });
});
