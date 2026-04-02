import { describe, expect, it } from "vitest";
import {
  mapActivityType,
  parseTrackPoints,
  parseTripToActivity,
  type RideWithGpsTrackPoint,
  type RideWithGpsTripSummary,
} from "./ride-with-gps.ts";

describe("mapActivityType", () => {
  it("maps cycling types", () => {
    expect(mapActivityType("cycling")).toBe("cycling");
    expect(mapActivityType("mountain_biking")).toBe("mountain_biking");
    expect(mapActivityType("road_cycling")).toBe("road_cycling");
    expect(mapActivityType("gravel_cycling")).toBe("gravel_cycling");
  });

  it("maps running types", () => {
    expect(mapActivityType("running")).toBe("running");
    expect(mapActivityType("trail_running")).toBe("running");
  });

  it("maps other known types", () => {
    expect(mapActivityType("walking")).toBe("walking");
    expect(mapActivityType("hiking")).toBe("hiking");
    expect(mapActivityType("swimming")).toBe("swimming");
  });

  it("defaults unknown to other", () => {
    expect(mapActivityType("paragliding")).toBe("other");
  });

  it("defaults null/undefined to cycling", () => {
    expect(mapActivityType(null)).toBe("cycling");
    expect(mapActivityType(undefined)).toBe("cycling");
  });
});

describe("parseTripToActivity", () => {
  const baseTrip: RideWithGpsTripSummary = {
    id: 12345,
    name: "Morning Ride",
    description: "Nice loop",
    departed_at: "2024-08-10T07:30:00Z",
    activity_type: "cycling",
    distance: 50000,
    duration: 7200,
    moving_time: 6800,
    elevation_gain: 500,
    elevation_loss: 500,
    created_at: "2024-08-10T10:00:00Z",
    updated_at: "2024-08-10T10:00:00Z",
  };

  it("maps all fields correctly", () => {
    const result = parseTripToActivity(baseTrip);
    expect(result.externalId).toBe("12345");
    expect(result.activityType).toBe("cycling");
    expect(result.name).toBe("Morning Ride");
    expect(result.startedAt).toEqual(new Date("2024-08-10T07:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2024-08-10T09:30:00Z")); // +7200s
    expect(result.notes).toBe("Nice loop");
    expect(result.raw).toBe(baseTrip);
    expect(result.sourceName).toBeUndefined();
  });

  it("extracts sourceName from source field", () => {
    const trip = { ...baseTrip, source: "ridewithgps_iphone" };
    const result = parseTripToActivity(trip);
    expect(result.sourceName).toBe("ridewithgps_iphone");
  });

  it("handles missing source field", () => {
    const result = parseTripToActivity(baseTrip);
    expect(result.sourceName).toBeUndefined();
  });

  it("falls back to created_at when departed_at is null", () => {
    const trip = { ...baseTrip, departed_at: null };
    const result = parseTripToActivity(trip);
    expect(result.startedAt).toEqual(new Date("2024-08-10T10:00:00Z"));
  });

  it("maps activity type through mapActivityType", () => {
    const trip = { ...baseTrip, activity_type: "mountain_biking" };
    expect(parseTripToActivity(trip).activityType).toBe("mountain_biking");
  });

  it("handles null description", () => {
    const trip = { ...baseTrip, description: null };
    expect(parseTripToActivity(trip).notes).toBeUndefined();
  });
});

describe("parseTrackPoints", () => {
  it("converts speed from km/h to m/s", () => {
    const points: RideWithGpsTrackPoint[] = [
      {
        longitude: -122.6,
        latitude: 45.5,
        distanceMeters: 0,
        epochSeconds: 1723276200,
        speedKph: 36,
      },
    ];
    const result = parseTrackPoints(points);
    expect(result).toHaveLength(1);
    expect(result[0]?.speed).toBeCloseTo(10, 5); // 36 km/h = 10 m/s
  });

  it("maps all sensor fields", () => {
    const points: RideWithGpsTrackPoint[] = [
      {
        longitude: -122.6,
        latitude: 45.5,
        distanceMeters: 1000,
        elevationMeters: 150,
        epochSeconds: 1723276200,
        speedKph: 25,
        temperatureCelsius: 22,
        heartRateBpm: 145,
        cadenceRpm: 90,
        powerWatts: 200,
      },
    ];
    const result = parseTrackPoints(points);
    expect(result[0]).toMatchObject({
      lat: 45.5,
      lng: -122.6,
      altitude: 150,
      temperature: 22,
      heartRate: 145,
      cadence: 90,
      power: 200,
    });
  });

  it("uses unix epoch timestamp for recordedAt", () => {
    const points: RideWithGpsTrackPoint[] = [
      { longitude: -122.6, latitude: 45.5, distanceMeters: 0, epochSeconds: 1723276200 },
    ];
    const result = parseTrackPoints(points);
    expect(result[0]?.recordedAt).toEqual(new Date(1723276200 * 1000));
  });

  it("skips points without timestamp", () => {
    const points: RideWithGpsTrackPoint[] = [
      { longitude: -122.6, latitude: 45.5, distanceMeters: 0 }, // no epochSeconds
      { longitude: -122.7, latitude: 45.6, distanceMeters: 100, epochSeconds: 1723276300 },
    ];
    const result = parseTrackPoints(points);
    expect(result).toHaveLength(1);
    expect(result[0]?.lng).toBe(-122.7);
  });

  it("handles missing optional fields as undefined", () => {
    const points: RideWithGpsTrackPoint[] = [
      { longitude: -122.6, latitude: 45.5, distanceMeters: 0, epochSeconds: 1723276200 },
    ];
    const result = parseTrackPoints(points);
    const point = result[0];
    if (!point) {
      expect(point).toBeDefined();
      return;
    }
    expect(point.altitude).toBeUndefined();
    expect(point.heartRate).toBeUndefined();
    expect(point.power).toBeUndefined();
    expect(point.cadence).toBeUndefined();
    expect(point.temperature).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(parseTrackPoints([])).toEqual([]);
  });

  it("skips track points with missing longitude or latitude", () => {
    const points: RideWithGpsTrackPoint[] = [
      {
        // Missing BOTH
        distanceMeters: 0,
        epochSeconds: 1723276200,
      },
      {
        // Missing longitude ONLY
        latitude: 45.6,
        distanceMeters: 100,
        epochSeconds: 1723276300,
      },
      {
        // Missing latitude ONLY
        longitude: -122.7,
        distanceMeters: 200,
        epochSeconds: 1723276400,
      },
      {
        // Has BOTH
        longitude: -122.8,
        latitude: 45.7,
        distanceMeters: 300,
        epochSeconds: 1723276500,
      },
    ];
    const result = parseTrackPoints(points);
    expect(result).toHaveLength(1);
    expect(result[0]?.lng).toBe(-122.8);
    expect(result[0]?.lat).toBe(45.7);
  });
});
