import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import {
  buildRideWithGpsMetricRows,
  mapActivityType,
  parseTrackPoints,
  parseTripToActivity,
  RideWithGpsClient,
  RideWithGpsProvider,
  type RideWithGpsTrackPoint,
  type RideWithGpsTripSummary,
} from "./ride-with-gps.ts";

const rateLimitedFetch: typeof globalThis.fetch = async (): Promise<Response> =>
  new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

describe("mapActivityType", () => {
  it("maps cycling types", () => {
    expect(mapActivityType("cycling").canonicalType).toBe("cycling");
    expect(mapActivityType("mountain_biking").canonicalType).toBe("cycling");
    expect(mapActivityType("road_cycling").canonicalType).toBe("cycling");
    expect(mapActivityType("gravel_cycling").canonicalType).toBe("cycling");
  });

  it("maps colon-delimited RideWithGPS cycling types", () => {
    expect(mapActivityType("cycling:generic").canonicalType).toBe("cycling");
    expect(mapActivityType("cycling:road").canonicalType).toBe("cycling");
  });

  it("maps running types", () => {
    expect(mapActivityType("running").canonicalType).toBe("running");
    expect(mapActivityType("trail_running").canonicalType).toBe("running");
  });

  it("maps other known types", () => {
    expect(mapActivityType("walking").canonicalType).toBe("walking");
    expect(mapActivityType("hiking").canonicalType).toBe("hiking");
    expect(mapActivityType("swimming").canonicalType).toBe("swimming");
  });

  it("defaults unknown to other", () => {
    expect(mapActivityType("paragliding").canonicalType).toBe("other");
  });

  it("defaults null/undefined to cycling", () => {
    expect(mapActivityType(null).canonicalType).toBe("cycling");
    expect(mapActivityType(undefined).canonicalType).toBe("cycling");
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
    expect(result.activityType.canonicalType).toBe("cycling");
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
    expect(parseTripToActivity(trip).activityType.canonicalType).toBe("cycling");
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

describe("buildRideWithGpsMetricRows", () => {
  it("converts parsed track points to source rows for metric stream fan-out", () => {
    const rows = buildRideWithGpsMetricRows({
      activityId: "activity-1",
      externalId: "trip-1",
      activityType: resolveProviderActivityType("cycling:road", "road_cycling"),
      trackPoints: [
        {
          longitude: -122.6,
          latitude: 45.5,
          elevationMeters: 150,
          epochSeconds: 1723276200,
          speedKph: 36,
          temperatureCelsius: 22,
          heartRateBpm: 145,
          cadenceRpm: 90,
          powerWatts: 200,
        },
      ],
    });

    expect(rows).toEqual([
      {
        recordedAt: new Date(1723276200 * 1000),
        activityId: "activity-1",
        externalId: "trip-1",
        providerId: "ride-with-gps",
        lat: 45.5,
        lng: -122.6,
        altitude: 150,
        speed: 10,
        temperature: 22,
        heartRate: 145,
        cadence: 90,
        power: 200,
      },
    ]);
  });

  it("omits speed for indoor cycling activities", () => {
    const rows = buildRideWithGpsMetricRows({
      activityId: "activity-1",
      externalId: "trip-1",
      activityType: resolveProviderActivityType("cycling:indoor", "indoor_cycling"),
      trackPoints: [
        {
          longitude: -122.6,
          latitude: 45.5,
          epochSeconds: 1723276200,
          speedKph: 36,
        },
      ],
    });

    expect(rows[0]?.speed).toBeUndefined();
    expect(rows[0]?.lat).toBe(45.5);
    expect(rows[0]?.lng).toBe(-122.6);
  });
});

describe("RideWithGps — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("RideWithGpsClient surfaces a 429 as a ProviderRateLimitError tagged 'ride-with-gps'", async () => {
    const client = new RideWithGpsClient(
      "access-token",
      createProviderRateLimitFetch("ride-with-gps", rateLimitedFetch),
    );

    const err = await client.sync("2024-01-01T00:00:00Z").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("ride-with-gps");
      expect(err.statusCode).toBe(429);
    }
  });

  it("exchangeCode surfaces a 429 as a ProviderRateLimitError tagged 'ride-with-gps'", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    const provider = new RideWithGpsProvider(rateLimitedFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode?.("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("ride-with-gps");
      expect(err.statusCode).toBe(429);
    }
  });
});
