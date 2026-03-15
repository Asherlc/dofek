import { describe, expect, it } from "vitest";
import { mapZwiftSport, parseZwiftActivity, parseZwiftFitnessData } from "../zwift.ts";

// ============================================================
// Sample API responses
// ============================================================

const sampleActivity = {
  id: 123456789,
  id_str: "123456789",
  profileId: 99999,
  name: "Watopia Hilly Route",
  startDate: "2026-03-01T18:00:00.000Z",
  endDate: "2026-03-01T19:00:00.000Z",
  distanceInMeters: 35000,
  avgHeartRate: 155,
  maxHeartRate: 180,
  avgWatts: 220,
  maxWatts: 550,
  avgCadenceInRotationsPerMinute: 85,
  avgSpeedInMetersPerSecond: 9.72,
  maxSpeedInMetersPerSecond: 15.5,
  totalElevationInMeters: 450,
  calories: 800,
  sport: "CYCLING",
  rideOnGiven: 5,
  activityRideOnCount: 12,
};

const sampleFitnessData = {
  powerInWatts: [200, 220, 250, 180, 300],
  heartRate: [140, 145, 155, 150, 165],
  cadencePerMin: [85, 88, 90, 82, 95],
  distanceInCm: [0, 97200, 194400, 291600, 388800],
  speedInCmPerSec: [972, 972, 972, 972, 972],
  altitudeInCm: [5000, 5100, 5250, 5200, 5300],
  latlng: [
    [40.7128, -74.006],
    [40.713, -74.005],
    [40.714, -74.004],
    [40.715, -74.003],
    [40.716, -74.002],
  ] as Array<[number, number]>,
  timeInSec: [0, 1, 2, 3, 4],
};

// ============================================================
// Tests
// ============================================================

describe("Zwift Provider", () => {
  describe("mapZwiftSport", () => {
    it("maps cycling", () => {
      expect(mapZwiftSport("CYCLING")).toBe("cycling");
    });

    it("maps running", () => {
      expect(mapZwiftSport("RUNNING")).toBe("running");
    });

    it("maps unknown sports to other", () => {
      expect(mapZwiftSport("ROWING")).toBe("other");
      expect(mapZwiftSport("")).toBe("other");
    });

    it("is case-insensitive", () => {
      expect(mapZwiftSport("cycling")).toBe("cycling");
      expect(mapZwiftSport("Running")).toBe("running");
    });
  });

  describe("parseZwiftActivity", () => {
    it("maps activity fields correctly", () => {
      const result = parseZwiftActivity(sampleActivity);

      expect(result.externalId).toBe("123456789");
      expect(result.activityType).toBe("cycling");
      expect(result.name).toBe("Watopia Hilly Route");
      expect(result.startedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T19:00:00.000Z"));
    });

    it("stores key metrics in raw object", () => {
      const result = parseZwiftActivity(sampleActivity);

      expect(result.raw.avgWatts).toBe(220);
      expect(result.raw.maxWatts).toBe(550);
      expect(result.raw.avgHeartRate).toBe(155);
      expect(result.raw.maxHeartRate).toBe(180);
      expect(result.raw.distanceMeters).toBe(35000);
      expect(result.raw.elevationGain).toBe(450);
      expect(result.raw.calories).toBe(800);
    });

    it("uses id_str when available", () => {
      const result = parseZwiftActivity(sampleActivity);
      expect(result.externalId).toBe("123456789");
    });

    it("falls back to id when id_str is empty", () => {
      const noIdStr = { ...sampleActivity, id_str: "" };
      const result = parseZwiftActivity(noIdStr);
      expect(result.externalId).toBe("123456789");
    });
  });

  describe("parseZwiftFitnessData", () => {
    const activityStart = new Date("2026-03-01T18:00:00.000Z");

    it("parses all stream channels", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({
        recordedAt: new Date("2026-03-01T18:00:00.000Z"),
        heartRate: 140,
        power: 200,
        cadence: 85,
        speed: 9.72, // 972 cm/s → 9.72 m/s
        altitude: 50, // 5000 cm → 50 m
        distance: 0,
        lat: 40.7128,
        lng: -74.006,
      });
    });

    it("converts cm/s to m/s for speed", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.speed).toBe(9.72);
    });

    it("converts cm to m for altitude", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.altitude).toBe(50);
      expect(result[2]?.altitude).toBe(52.5);
    });

    it("converts cm to m for distance", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[1]?.distance).toBe(972);
    });

    it("calculates timestamps from timeInSec offsets", () => {
      const result = parseZwiftFitnessData(sampleFitnessData, activityStart);
      expect(result[0]?.recordedAt).toEqual(new Date("2026-03-01T18:00:00.000Z"));
      expect(result[4]?.recordedAt).toEqual(new Date("2026-03-01T18:00:04.000Z"));
    });

    it("handles missing optional fields", () => {
      const partialData = {
        powerInWatts: [200, 220],
        timeInSec: [0, 1],
      };
      const result = parseZwiftFitnessData(partialData, activityStart);

      expect(result).toHaveLength(2);
      expect(result[0]?.power).toBe(200);
      expect(result[0]?.heartRate).toBeUndefined();
      expect(result[0]?.cadence).toBeUndefined();
      expect(result[0]?.lat).toBeUndefined();
    });

    it("handles empty fitness data", () => {
      const result = parseZwiftFitnessData({}, activityStart);
      expect(result).toHaveLength(0);
    });
  });
});
