import { describe, expect, it } from "vitest";
import { mapTrainerRoadActivityType, parseTrainerRoadActivity } from "./parsing.ts";
import type { TrainerRoadActivity } from "./types.ts";

const sampleActivity: TrainerRoadActivity = {
  Id: 12345,
  WorkoutName: "Ramp Test",
  CompletedDate: "2026-03-15T08:00:00Z",
  Duration: 3600,
  Tss: 75,
  DistanceInMeters: 42000,
  IsOutside: false,
  ActivityType: "Ride",
  IfFactor: 0.95,
  NormalizedPower: 250,
  AveragePower: 230,
  MaxPower: 400,
  AverageHeartRate: 155,
  MaxHeartRate: 180,
  AverageCadence: 90,
  MaxCadence: 110,
  Calories: 800,
  ElevationGainInMeters: 0,
  AverageSpeed: 11.67,
  MaxSpeed: 15.0,
};

describe("mapTrainerRoadActivityType", () => {
  it("maps ride types to cycling when indoors", () => {
    expect(mapTrainerRoadActivityType("Ride", false)).toBe("virtual_cycling");
  });

  it("maps ride types to cycling when outdoors", () => {
    expect(mapTrainerRoadActivityType("Ride", true)).toBe("cycling");
  });

  it("maps cycling types", () => {
    expect(mapTrainerRoadActivityType("Cycling", false)).toBe("virtual_cycling");
    expect(mapTrainerRoadActivityType("Cycling", true)).toBe("cycling");
  });

  it("maps run types to running when indoors", () => {
    expect(mapTrainerRoadActivityType("Run", false)).toBe("virtual_running");
  });

  it("maps run types to running when outdoors", () => {
    expect(mapTrainerRoadActivityType("Run", true)).toBe("running");
  });

  it("maps swim types to swimming", () => {
    expect(mapTrainerRoadActivityType("Swim", false)).toBe("swimming");
    expect(mapTrainerRoadActivityType("Swim", true)).toBe("swimming");
  });

  it("returns other for unknown types", () => {
    expect(mapTrainerRoadActivityType("Yoga", false)).toBe("other");
    expect(mapTrainerRoadActivityType("Strength", true)).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(mapTrainerRoadActivityType("RIDE", false)).toBe("virtual_cycling");
    expect(mapTrainerRoadActivityType("run", true)).toBe("running");
    expect(mapTrainerRoadActivityType("SWIM", false)).toBe("swimming");
  });
});

describe("parseTrainerRoadActivity", () => {
  it("parses a complete activity", () => {
    const result = parseTrainerRoadActivity(sampleActivity);

    expect(result.externalId).toBe("12345");
    expect(result.activityType).toBe("virtual_cycling");
    expect(result.name).toBe("Ramp Test");
    expect(result.endedAt).toEqual(new Date("2026-03-15T08:00:00Z"));
    expect(result.startedAt).toEqual(new Date("2026-03-15T07:00:00Z")); // 1 hour before
  });

  it("calculates start time from completed date minus duration", () => {
    const act: TrainerRoadActivity = {
      ...sampleActivity,
      CompletedDate: "2026-03-15T10:00:00Z",
      Duration: 1800, // 30 min
    };
    const result = parseTrainerRoadActivity(act);

    expect(result.startedAt).toEqual(new Date("2026-03-15T09:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2026-03-15T10:00:00Z"));
  });

  it("includes all raw fields", () => {
    const result = parseTrainerRoadActivity(sampleActivity);

    expect(result.raw).toEqual({
      tss: 75,
      distanceMeters: 42000,
      normalizedPower: 250,
      avgPower: 230,
      maxPower: 400,
      avgHeartRate: 155,
      maxHeartRate: 180,
      avgCadence: 90,
      maxCadence: 110,
      calories: 800,
      elevationGain: 0,
      avgSpeed: 11.67,
      maxSpeed: 15.0,
      intensityFactor: 0.95,
      isOutside: false,
    });
  });

  it("uses outdoor activity type for outdoor rides", () => {
    const act: TrainerRoadActivity = { ...sampleActivity, IsOutside: true };
    const result = parseTrainerRoadActivity(act);
    expect(result.activityType).toBe("cycling");
    expect(result.raw.isOutside).toBe(true);
  });

  it("converts numeric id to string", () => {
    const act: TrainerRoadActivity = { ...sampleActivity, Id: 99999 };
    const result = parseTrainerRoadActivity(act);
    expect(result.externalId).toBe("99999");
  });
});
