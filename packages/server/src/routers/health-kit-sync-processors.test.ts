import { describe, expect, it, vi } from "vitest";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import { processBodyMeasurements, processMetricStream } from "./health-kit-sync-processors.ts";
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
