import { describe, expect, it, vi } from "vitest";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import {
  processBodyMeasurements,
  processMetricStream,
  processWorkoutRoutes,
} from "./health-kit-sync-processors.ts";
import type { HealthKitSample } from "./health-kit-sync-schemas.ts";

const heartRateSample = {
  type: "HKQuantityTypeIdentifierHeartRate",
  value: 72.7,
  unit: "count/min",
  startDate: "2026-06-06T19:00:00.000Z",
  endDate: "2026-06-06T19:00:05.000Z",
  sourceName: "Apple Watch",
  sourceBundle: "com.apple.health",
  uuid: "heart-rate-1",
} satisfies HealthKitSample;

describe("processMetricStream", () => {
  it("publishes HealthKit metric stream samples through the Redpanda writer boundary", async () => {
    const execute = vi.fn(async () => []);
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
    };

    const inserted = await processMetricStream(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [heartRateSample],
      publisher,
    );

    expect(inserted).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(publisher.publishRows).toHaveBeenCalledWith([
      {
        recordedAt: "2026-06-06T19:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        externalId: "hk:heart-rate-1",
        deviceId: "Apple Watch",
        sourceType: "api",
        channel: "heart_rate",
        scalar: 73,
      },
    ]);
  });
});

describe("processBodyMeasurements", () => {
  it("publishes body measurement samples through Redpanda instead of inserting into Postgres", async () => {
    const execute = vi.fn(async () => []);
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
    };

    const inserted = await processBodyMeasurements(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [
        {
          ...heartRateSample,
          type: "HKQuantityTypeIdentifierBodyMass",
          value: 82.5,
          uuid: "body-mass-1",
        },
      ],
      publisher,
    );

    expect(inserted).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(publisher.publishRows).toHaveBeenCalledWith([
      {
        recordedAt: "2026-06-06T19:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        externalId: "hk:body-mass-1",
        deviceId: "Apple Watch",
        sourceType: "api",
        channel: "body_weight",
        scalar: 82.5,
      },
    ]);
  });
});

describe("processWorkoutRoutes", () => {
  function makePublisher() {
    const capturedRows: unknown[][] = [];
    return {
      capturedRows,
      publishRows: vi.fn(async (rows: readonly unknown[]) => {
        const rowsSnapshot = [...rows];
        capturedRows.push(rowsSnapshot);
        return rowsSnapshot.map((_, index) => ({ id: `event-${index}` }));
      }),
    };
  }

  it("flushes route rows at the batch boundary without publishing an empty final batch", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ id: "activity-123", external_id: "hk:workout:w-batch" }]);
    const publisher = makePublisher();
    const locations = Array.from({ length: 500 }, (_, index) => ({
      date: `2026-06-06T19:00:00.${String(index).padStart(3, "0")}Z`,
      lat: 37.77 + index / 100_000,
      lng: -122.42 - index / 100_000,
    }));

    const inserted = await processWorkoutRoutes(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [{ workoutUuid: "w-batch", sourceName: "Apple Watch", locations }],
      publisher,
    );

    expect(inserted).toBe(500);
    expect(publisher.publishRows).toHaveBeenCalledTimes(1);
    expect(publisher.capturedRows[0]).toHaveLength(500);
  });

  it("keeps scalar route metrics in the same 500-row batch window as location rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ id: "activity-456", external_id: "hk:workout:w-scalars" }]);
    const publisher = makePublisher();
    const locations = Array.from({ length: 251 }, (_, index) => ({
      date: `2026-06-06T19:00:00.${String(index).padStart(3, "0")}Z`,
      lat: 37.77,
      lng: -122.42,
      speed: 3 + index / 100,
    }));

    const inserted = await processWorkoutRoutes(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [{ workoutUuid: "w-scalars", sourceName: "Route Watch", locations }],
      publisher,
    );

    expect(inserted).toBe(502);
    expect(publisher.publishRows).toHaveBeenCalledTimes(2);
    expect(publisher.capturedRows[0]).toHaveLength(500);
    expect(publisher.capturedRows[1]).toHaveLength(2);
  });

  it("copies the route source name onto scalar metric rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ id: "activity-789", external_id: "hk:workout:w-device" }]);
    const publisher = makePublisher();

    await processWorkoutRoutes(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [
        {
          workoutUuid: "w-device",
          sourceName: "Route Watch",
          locations: [
            {
              date: "2026-06-06T19:00:00.000Z",
              lat: 37.77,
              lng: -122.42,
              speed: 4.2,
            },
          ],
        },
      ],
      publisher,
    );

    const publishedRows = publisher.capturedRows[0] ?? [];
    expect(publishedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "speed",
          deviceId: "Route Watch",
        }),
      ]),
    );
  });
});
