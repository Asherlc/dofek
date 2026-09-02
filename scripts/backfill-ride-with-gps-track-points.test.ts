import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRideWithGpsActivityBackfillPlan,
  planRideWithGpsActivityBackfill,
} from "./backfill-ride-with-gps-track-points.ts";

const replaceMetricStreamBatchMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db/metric-stream-writer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/metric-stream-writer.ts")>();
  return {
    ...actual,
    replaceMetricStreamBatch: replaceMetricStreamBatchMock,
  };
});

beforeEach(() => {
  replaceMetricStreamBatchMock.mockReset();
  replaceMetricStreamBatchMock.mockResolvedValue(0);
});

describe("planRideWithGpsActivityBackfill", () => {
  it("builds metric rows from stored descriptive RideWithGPS track points", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "other",
      providerType: "other",
      modality: null,
      raw: {
        activity_type: "cycling:road",
        track_points: [
          {
            longitude: -122.6,
            latitude: 45.5,
            elevationMeters: 150,
            epochSeconds: 1_723_276_200,
            speedMetersPerSecond: 10,
          },
        ],
      },
    });

    expect(plan.activityType).toEqual({
      canonicalType: "cycling",
      providerType: "cycling:road",
      modality: "road",
    });
    expect(plan.shouldUpdateActivityType).toBe(true);
    expect(plan.metricRows).toEqual([
      {
        recordedAt: new Date(1_723_276_200 * 1000),
        activityId: "activity-1",
        externalId: "trip-1",
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
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
      raw: {
        activity_type: "cycling:generic",
        track_points: [
          {
            x: -122.6,
            y: 45.5,
            e: 150,
            t: 1_723_276_200,
            s: 10,
            h: 145,
            c: 90,
            p: 200,
          },
        ],
      },
    });

    expect(plan.activityType).toEqual({
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
    });
    expect(plan.shouldUpdateActivityType).toBe(false);
    expect(plan.metricRows[0]).toMatchObject({
      speed: 10,
      heartRate: 145,
      cadence: 90,
      power: 200,
    });
  });

  it("preserves the legacy descriptive speedKph field as meters per second", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:road",
      modality: "road",
      raw: {
        activity_type: "cycling:road",
        track_points: [
          {
            longitude: -122.6,
            latitude: 45.5,
            epochSeconds: 1_723_276_200,
            speedKph: 15.25,
          },
        ],
      },
    });

    expect(plan.metricRows[0]?.speed).toBe(15.25);
  });

  it("returns no metric rows for empty RideWithGPS track points", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
      raw: {
        activity_type: "cycling:generic",
        track_points: [],
      },
    });

    expect(plan.metricRows).toEqual([]);
  });

  it("drops track points that are missing required stream fields", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
      raw: {
        activity_type: "cycling:generic",
        track_points: [
          {
            longitude: -122.6,
            latitude: 45.5,
          },
          {
            longitude: -122.6,
            epochSeconds: 1_723_276_200,
          },
          {
            latitude: 45.5,
            epochSeconds: 1_723_276_200,
          },
        ],
      },
    });

    expect(plan.metricRows).toEqual([]);
  });

  it("rejects stored rows with missing raw payloads", () => {
    expect(() =>
      planRideWithGpsActivityBackfill({
        id: "activity-1",
        externalId: "trip-1",
        userId: "user-1",
        canonicalType: "cycling",
        providerType: "cycling:generic",
        modality: null,
      }),
    ).toThrow();
  });

  it("rejects stored rows with non-array track points", () => {
    expect(() =>
      planRideWithGpsActivityBackfill({
        id: "activity-1",
        externalId: "trip-1",
        userId: "user-1",
        canonicalType: "cycling",
        providerType: "cycling:generic",
        modality: null,
        raw: {
          activity_type: "cycling:generic",
          track_points: "not-an-array",
        },
      }),
    ).toThrow();
  });

  it("rejects track points with invalid field types", () => {
    expect(() =>
      planRideWithGpsActivityBackfill({
        id: "activity-1",
        externalId: "trip-1",
        userId: "user-1",
        canonicalType: "cycling",
        providerType: "cycling:generic",
        modality: null,
        raw: {
          activity_type: "cycling:generic",
          track_points: [
            {
              x: "not-a-number",
              y: 45.5,
              t: 1_723_276_200,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("omits a negative stored speed without rejecting the activity", () => {
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
      raw: {
        activity_type: "cycling:generic",
        track_points: [
          {
            x: -122.6,
            y: 45.5,
            t: 1_723_276_200,
            s: -1,
          },
        ],
      },
    });

    expect(plan.metricRows).toHaveLength(1);
    expect(plan.metricRows[0]?.speed).toBeUndefined();
  });

  it("publishes an empty replacement for activities with no valid metric rows", async () => {
    const db = { execute: vi.fn() };
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "cycling",
      providerType: "cycling:generic",
      modality: null,
      raw: {
        activity_type: "cycling:generic",
        track_points: [],
      },
    });

    await applyRideWithGpsActivityBackfillPlan(db, plan);

    expect(replaceMetricStreamBatchMock).toHaveBeenCalledWith(
      db,
      { activityId: "activity-1", userId: "user-1" },
      [],
      "api",
    );
  });

  it("updates the stored activity type before publishing metric rows when the mapped type differs", async () => {
    const db = { execute: vi.fn().mockResolvedValue(undefined) };
    const plan = planRideWithGpsActivityBackfill({
      id: "activity-1",
      externalId: "trip-1",
      userId: "user-1",
      canonicalType: "other",
      providerType: "other",
      modality: null,
      raw: {
        activity_type: "cycling:road",
        track_points: [
          {
            x: -122.6,
            y: 45.5,
            t: 1_723_276_200,
          },
        ],
      },
    });

    await applyRideWithGpsActivityBackfillPlan(db, plan);

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.execute.mock.calls[0]?.[0])).toContain("canonical_type");
    expect(JSON.stringify(db.execute.mock.calls[0]?.[0])).toContain("provider_type");
    expect(JSON.stringify(db.execute.mock.calls[0]?.[0])).toContain("cycling:road");
    expect(JSON.stringify(db.execute.mock.calls[0]?.[0])).toContain("activity-1");
    expect(replaceMetricStreamBatchMock).toHaveBeenCalledWith(
      db,
      { activityId: "activity-1", userId: "user-1" },
      expect.arrayContaining([
        expect.objectContaining({
          activityId: "activity-1",
          externalId: "trip-1",
          providerId: "ride-with-gps",
        }),
      ]),
      "api",
    );
  });
});
