import { describe, expect, it } from "vitest";
import { mapZwiftSport, parseZwiftActivity, parseZwiftFitnessData } from "../parsing.ts";
import type { ZwiftActivitySummary, ZwiftFitnessData } from "../types.ts";

// ============================================================
// mapZwiftSport
// ============================================================

describe("mapZwiftSport", () => {
  it("maps CYCLING to cycling", () => {
    expect(mapZwiftSport("CYCLING")).toBe("cycling");
  });

  it("maps RUNNING to running", () => {
    expect(mapZwiftSport("RUNNING")).toBe("running");
  });

  it("maps lowercase cycling to cycling", () => {
    expect(mapZwiftSport("cycling")).toBe("cycling");
  });

  it("maps lowercase running to running", () => {
    expect(mapZwiftSport("running")).toBe("running");
  });

  it("maps mixed case to correct sport", () => {
    expect(mapZwiftSport("Cycling")).toBe("cycling");
    expect(mapZwiftSport("Running")).toBe("running");
  });

  it("maps unknown sport to other", () => {
    expect(mapZwiftSport("SWIMMING")).toBe("other");
  });

  it("maps empty string to other", () => {
    expect(mapZwiftSport("")).toBe("other");
  });
});

// ============================================================
// parseZwiftActivity
// ============================================================

describe("parseZwiftActivity", () => {
  function makeActivity(overrides: Partial<ZwiftActivitySummary> = {}): ZwiftActivitySummary {
    return {
      id: 123,
      id_str: "123",
      profileId: 100,
      name: "Watopia Ride",
      startDate: "2024-01-15T08:00:00Z",
      endDate: "2024-01-15T09:30:00Z",
      distanceInMeters: 42000,
      avgHeartRate: 145,
      maxHeartRate: 175,
      avgWatts: 200,
      maxWatts: 350,
      avgCadenceInRotationsPerMinute: 90,
      avgSpeedInMetersPerSecond: 7.8,
      maxSpeedInMetersPerSecond: 12.5,
      totalElevationInMeters: 500,
      calories: 900,
      sport: "CYCLING",
      rideOnGiven: 5,
      activityRideOnCount: 10,
      ...overrides,
    };
  }

  it("parses a complete activity", () => {
    const result = parseZwiftActivity(makeActivity());

    expect(result.externalId).toBe("123");
    expect(result.activityType).toBe("cycling");
    expect(result.name).toBe("Watopia Ride");
    expect(result.startedAt).toEqual(new Date("2024-01-15T08:00:00Z"));
    expect(result.endedAt).toEqual(new Date("2024-01-15T09:30:00Z"));
    expect(result.raw.distanceMeters).toBe(42000);
    expect(result.raw.avgHeartRate).toBe(145);
    expect(result.raw.maxHeartRate).toBe(175);
    expect(result.raw.avgWatts).toBe(200);
    expect(result.raw.maxWatts).toBe(350);
    expect(result.raw.avgCadence).toBe(90);
    expect(result.raw.avgSpeed).toBe(7.8);
    expect(result.raw.maxSpeed).toBe(12.5);
    expect(result.raw.elevationGain).toBe(500);
    expect(result.raw.calories).toBe(900);
  });

  it("uses id_str when available", () => {
    const result = parseZwiftActivity(makeActivity({ id_str: "abc-123" }));
    expect(result.externalId).toBe("abc-123");
  });

  it("falls back to String(id) when id_str is empty", () => {
    const result = parseZwiftActivity(makeActivity({ id_str: "", id: 456 }));
    expect(result.externalId).toBe("456");
  });

  it("maps running sport correctly", () => {
    const result = parseZwiftActivity(makeActivity({ sport: "RUNNING" }));
    expect(result.activityType).toBe("running");
  });

  it("maps unknown sport to other", () => {
    const result = parseZwiftActivity(makeActivity({ sport: "SWIMMING" }));
    expect(result.activityType).toBe("other");
  });
});

// ============================================================
// parseZwiftFitnessData
// ============================================================

describe("parseZwiftFitnessData", () => {
  const activityStart = new Date("2024-01-15T08:00:00Z");

  it("parses complete fitness data with all fields", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [200, 210],
      heartRate: [140, 145],
      cadencePerMin: [90, 92],
      distanceInCm: [0, 10000],
      speedInCmPerSec: [700, 720],
      altitudeInCm: [5000, 5100],
      latlng: [
        [40.7128, -74.006],
        [40.7129, -74.005],
      ],
      timeInSec: [0, 1],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result).toHaveLength(2);

    expect(result[0]?.recordedAt).toEqual(new Date("2024-01-15T08:00:00Z"));
    expect(result[0]?.power).toBe(200);
    expect(result[0]?.heartRate).toBe(140);
    expect(result[0]?.cadence).toBe(90);
    expect(result[0]?.distance).toBe(0);
    expect(result[0]?.speed).toBe(7);
    expect(result[0]?.altitude).toBe(50);
    expect(result[0]?.lat).toBe(40.7128);
    expect(result[0]?.lng).toBe(-74.006);

    expect(result[1]?.recordedAt).toEqual(new Date("2024-01-15T08:00:01Z"));
    expect(result[1]?.power).toBe(210);
    expect(result[1]?.distance).toBe(100);
  });

  it("handles empty fitness data", () => {
    const data: ZwiftFitnessData = {};
    const result = parseZwiftFitnessData(data, activityStart);
    expect(result).toHaveLength(0);
  });

  it("uses index as offset when timeInSec is missing", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [100, 110, 120],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result).toHaveLength(3);
    expect(result[0]?.recordedAt).toEqual(new Date("2024-01-15T08:00:00Z"));
    expect(result[1]?.recordedAt).toEqual(new Date("2024-01-15T08:00:01Z"));
    expect(result[2]?.recordedAt).toEqual(new Date("2024-01-15T08:00:02Z"));
  });

  it("handles missing optional fields as undefined", () => {
    const data: ZwiftFitnessData = {
      timeInSec: [0],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result).toHaveLength(1);
    expect(result[0]?.heartRate).toBeUndefined();
    expect(result[0]?.power).toBeUndefined();
    expect(result[0]?.cadence).toBeUndefined();
    expect(result[0]?.speed).toBeUndefined();
    expect(result[0]?.altitude).toBeUndefined();
    expect(result[0]?.distance).toBeUndefined();
    expect(result[0]?.lat).toBeUndefined();
    expect(result[0]?.lng).toBeUndefined();
  });

  it("handles arrays of different lengths", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [200, 210, 220],
      heartRate: [140],
      timeInSec: [0, 1],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    // Length should be max of all array lengths
    expect(result).toHaveLength(3);
    expect(result[0]?.power).toBe(200);
    expect(result[0]?.heartRate).toBe(140);
    expect(result[1]?.power).toBe(210);
    expect(result[1]?.heartRate).toBeUndefined();
    expect(result[2]?.power).toBe(220);
    expect(result[2]?.heartRate).toBeUndefined();
  });

  it("converts speed from cm/s to m/s", () => {
    const data: ZwiftFitnessData = {
      speedInCmPerSec: [1000],
      timeInSec: [0],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.speed).toBe(10);
  });

  it("converts altitude from cm to m", () => {
    const data: ZwiftFitnessData = {
      altitudeInCm: [10000],
      timeInSec: [0],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.altitude).toBe(100);
  });

  it("converts distance from cm to m", () => {
    const data: ZwiftFitnessData = {
      distanceInCm: [500000],
      timeInSec: [0],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.distance).toBe(5000);
  });

  it("handles latlng being undefined", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [200],
      timeInSec: [0],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.lat).toBeUndefined();
    expect(result[0]?.lng).toBeUndefined();
  });

  it("handles partial latlng array (shorter than other arrays)", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [200, 210],
      latlng: [[40.0, -74.0]],
      timeInSec: [0, 1],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.lat).toBe(40.0);
    expect(result[0]?.lng).toBe(-74.0);
    expect(result[1]?.lat).toBeUndefined();
    expect(result[1]?.lng).toBeUndefined();
  });

  it("uses timeInSec for custom time offsets", () => {
    const data: ZwiftFitnessData = {
      powerInWatts: [200, 210],
      timeInSec: [0, 60],
    };

    const result = parseZwiftFitnessData(data, activityStart);

    expect(result[0]?.recordedAt).toEqual(new Date("2024-01-15T08:00:00Z"));
    expect(result[1]?.recordedAt).toEqual(new Date("2024-01-15T08:01:00Z"));
  });
});
