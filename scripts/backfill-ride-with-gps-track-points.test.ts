import { describe, expect, it } from "vitest";
import { planRideWithGpsActivityBackfill } from "./backfill-ride-with-gps-track-points.ts";

describe("planRideWithGpsActivityBackfill", () => {
  it("builds metric rows from stored descriptive RideWithGPS track points", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      userId: "user-1",
      activityType: "other",
      raw: {
        activity_type: "cycling:road",
        track_points: [
          {
            longitude: -122.6,
            latitude: 45.5,
            elevationMeters: 150,
            epochSeconds: 1_723_276_200,
            speedKph: 36,
          },
        ],
      },
    });

    expect(plan.activityType).toBe("road_cycling");
    expect(plan.shouldUpdateActivityType).toBe(true);
    expect(plan.metricRows).toEqual([
      {
        recordedAt: new Date(1_723_276_200 * 1000),
        activityId: "activity-1",
        providerId: "ride-with-gps",
        lat: 45.5,
        lng: -122.6,
        altitude: 150,
        speed: 10,
        temperature: undefined,
        heartRate: undefined,
        cadence: undefined,
        power: undefined,
      },
    ]);
  });

  it("builds metric rows from compact RideWithGPS API track points", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      userId: "user-1",
      activityType: "cycling",
      raw: {
        activity_type: "cycling:generic",
        track_points: [
          {
            x: -122.6,
            y: 45.5,
            e: 150,
            t: 1_723_276_200,
            s: 36,
            h: 145,
            c: 90,
            p: 200,
          },
        ],
      },
    });

    expect(plan.activityType).toBe("cycling");
    expect(plan.shouldUpdateActivityType).toBe(false);
    expect(plan.metricRows[0]).toMatchObject({
      heartRate: 145,
      cadence: 90,
      power: 200,
    });
  });
});
