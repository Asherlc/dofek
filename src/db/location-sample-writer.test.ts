import { describe, expect, it, vi } from "vitest";
import type { LocationSampleInsert } from "./location-sample-writer.ts";
import { sourceRowToLocationSample, writeLocationSamples } from "./location-sample-writer.ts";

describe("sourceRowToLocationSample", () => {
  it("converts a coordinate-bearing source row into one location_sample row", () => {
    const row = sourceRowToLocationSample(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        userId: "user-1",
        providerId: "apple_health",
        activityId: "act-1",
        sourceName: "Apple Watch",
        lat: 40.7128,
        lng: -74.006,
        horizontalAccuracy: 5.2,
      },
      "api",
    );

    expect(row).toEqual({
      recordedAt: new Date("2026-03-30T12:00:00Z"),
      userId: "user-1",
      providerId: "apple_health",
      activityId: "act-1",
      deviceId: "Apple Watch",
      sourceType: "api",
      latitude: 40.7128,
      longitude: -74.006,
      horizontalAccuracyM: 5.2,
      gpsAccuracyM: null,
      raw: null,
    });
  });

  it("keeps FIT gps_accuracy distinct from horizontal accuracy", () => {
    const row = sourceRowToLocationSample(
      {
        recordedAt: new Date("2026-03-30T12:00:00Z"),
        providerId: "wahoo",
        lat: 40.7128,
        lng: -74.006,
        gpsAccuracy: 3,
      },
      "file",
    );

    expect(row?.horizontalAccuracyM).toBeNull();
    expect(row?.gpsAccuracyM).toBe(3);
  });

  it("returns null unless both latitude and longitude are present", () => {
    expect(
      sourceRowToLocationSample(
        {
          recordedAt: new Date("2026-03-30T12:00:00Z"),
          providerId: "strava",
          lat: 40.7128,
        },
        "api",
      ),
    ).toBeNull();
  });
});

describe("writeLocationSamples", () => {
  it("inserts rows in batches", async () => {
    const insertedBatches: LocationSampleInsert[][] = [];
    const insertBatch = vi.fn(async (batch: LocationSampleInsert[]) => {
      insertedBatches.push(batch);
    });

    const rows: LocationSampleInsert[] = Array.from({ length: 7 }, (_, index) => ({
      recordedAt: new Date("2026-03-30T12:00:00Z"),
      userId: "user-1",
      providerId: "test",
      activityId: "act-1",
      deviceId: null,
      sourceType: "api",
      latitude: 40 + index / 1000,
      longitude: -74,
      horizontalAccuracyM: null,
      gpsAccuracyM: null,
      raw: null,
    }));

    const count = await writeLocationSamples(insertBatch, rows, 3);

    expect(count).toBe(7);
    expect(insertedBatches).toHaveLength(3);
    expect(insertedBatches[0]).toHaveLength(3);
    expect(insertedBatches[1]).toHaveLength(3);
    expect(insertedBatches[2]).toHaveLength(1);
  });
});
