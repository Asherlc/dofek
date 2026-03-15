import { mapTrainerRoadActivityType, parseTrainerRoadActivity } from "trainerroad-client";
import { describe, expect, it } from "vitest";

const sampleActivity = {
  Id: 987654,
  WorkoutName: "Pettit",
  CompletedDate: "2026-03-01T19:00:00.000Z",
  Duration: 3600, // 60 minutes
  Tss: 52,
  DistanceInMeters: 0,
  IsOutside: false,
  ActivityType: "Ride",
  IfFactor: 0.72,
  NormalizedPower: 180,
  AveragePower: 165,
  MaxPower: 320,
  AverageHeartRate: 135,
  MaxHeartRate: 155,
  AverageCadence: 88,
  MaxCadence: 105,
  Calories: 650,
  ElevationGainInMeters: 0,
  AverageSpeed: 0,
  MaxSpeed: 0,
};

describe("TrainerRoad Provider", () => {
  describe("mapTrainerRoadActivityType", () => {
    it("maps indoor rides to virtual_cycling", () => {
      expect(mapTrainerRoadActivityType("Ride", false)).toBe("virtual_cycling");
      expect(mapTrainerRoadActivityType("VirtualRide", false)).toBe("virtual_cycling");
    });

    it("maps outdoor rides to cycling", () => {
      expect(mapTrainerRoadActivityType("Ride", true)).toBe("cycling");
    });

    it("maps indoor runs to virtual_running", () => {
      expect(mapTrainerRoadActivityType("Run", false)).toBe("virtual_running");
    });

    it("maps outdoor runs to running", () => {
      expect(mapTrainerRoadActivityType("Run", true)).toBe("running");
    });

    it("maps swimming", () => {
      expect(mapTrainerRoadActivityType("Swim", false)).toBe("swimming");
      expect(mapTrainerRoadActivityType("Swim", true)).toBe("swimming");
    });

    it("maps unknown to other", () => {
      expect(mapTrainerRoadActivityType("Yoga", false)).toBe("other");
    });
  });

  describe("parseTrainerRoadActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseTrainerRoadActivity(sampleActivity);

      expect(result.externalId).toBe("987654");
      expect(result.activityType).toBe("virtual_cycling");
      expect(result.name).toBe("Pettit");
      expect(result.endedAt).toEqual(new Date("2026-03-01T19:00:00.000Z"));
    });

    it("calculates startedAt from completedDate minus duration", () => {
      const result = parseTrainerRoadActivity(sampleActivity);
      // completedDate is 19:00, duration is 3600s (1 hour), so start is 18:00
      expect(result.startedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
    });

    it("stores power/HR/cadence metrics in raw", () => {
      const result = parseTrainerRoadActivity(sampleActivity);

      expect(result.raw.normalizedPower).toBe(180);
      expect(result.raw.avgPower).toBe(165);
      expect(result.raw.maxPower).toBe(320);
      expect(result.raw.avgHeartRate).toBe(135);
      expect(result.raw.maxHeartRate).toBe(155);
      expect(result.raw.avgCadence).toBe(88);
      expect(result.raw.tss).toBe(52);
      expect(result.raw.intensityFactor).toBe(0.72);
      expect(result.raw.isOutside).toBe(false);
    });

    it("handles outdoor activity", () => {
      const outdoor = {
        ...sampleActivity,
        IsOutside: true,
        DistanceInMeters: 50000,
        ElevationGainInMeters: 800,
      };
      const result = parseTrainerRoadActivity(outdoor);

      expect(result.activityType).toBe("cycling");
      expect(result.raw.distanceMeters).toBe(50000);
      expect(result.raw.elevationGain).toBe(800);
      expect(result.raw.isOutside).toBe(true);
    });
  });
});
