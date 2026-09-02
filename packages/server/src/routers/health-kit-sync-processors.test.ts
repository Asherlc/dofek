import { describe, expect, it, vi } from "vitest";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import {
  appleHealthWorkoutExternalId,
  processBodyMeasurements,
  processMetricStream,
  processWorkouts,
} from "./health-kit-sync-processors.ts";
import type { HealthKitSample } from "./health-kit-sync-schemas.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

type ProviderActivityListSyncScope = {
  windowStart: Date;
  windowEnd: Date;
};

const providerActivitySyncMocks = vi.hoisted(() => ({
  reconcile: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue({ id: "activity-id" }),
  scope: undefined satisfies ProviderActivityListSyncScope | undefined,
}));

const hangTenIntervalMocks = vi.hoisted(() => ({
  replace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../src/db/provider-activity-sync.ts", () => ({
  ProviderActivityListSync: class {
    constructor(scope: { windowStart: Date; windowEnd: Date }) {
      providerActivitySyncMocks.scope = scope;
    }
    upsert = providerActivitySyncMocks.upsert;
    reconcile = providerActivitySyncMocks.reconcile;
  },
  finishProviderActivityListSync: vi.fn(),
  upsertProviderActivity: vi.fn(),
}));

vi.mock("../../../../src/providers/apple-health/hang-ten-intervals.ts", () => ({
  replaceHangTenIntervals: hangTenIntervalMocks.replace,
}));

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
      makeTransactionalTestDatabase({ execute }),
      "00000000-0000-0000-0000-000000000001",
      [heartRateSample],
      publisher,
    );

    expect(inserted).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(publisher.publishRows).toHaveBeenCalledWith(
      [
        {
          recordedAt: "2026-06-06T19:00:00.000Z",
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "apple_health",
          generation: 0,
          externalId: "hk:heart-rate-1",
          deviceId: "Apple Watch",
          sourceType: "api",
          channel: "heart_rate",
          scalar: 73,
        },
      ],
      { operationRevision: "1000000000000000" },
    );
  });
});

describe("processBodyMeasurements", () => {
  it("publishes body measurement samples through Redpanda instead of inserting into Postgres", async () => {
    const execute = vi.fn(async () => []);
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
    };

    const inserted = await processBodyMeasurements(
      makeTransactionalTestDatabase({ execute }),
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
    expect(execute).toHaveBeenCalledTimes(2);
    expect(publisher.publishRows).toHaveBeenCalledWith(
      [
        {
          recordedAt: "2026-06-06T19:00:00.000Z",
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "apple_health",
          generation: 0,
          externalId: "hk:body-mass-1",
          deviceId: "Apple Watch",
          sourceType: "api",
          channel: "body_weight",
          scalar: 82.5,
        },
      ],
      { operationRevision: "1000000000000000" },
    );
  });
});

describe("processWorkouts", () => {
  it("classifies Hang Ten workouts from the HealthKit source", async () => {
    providerActivitySyncMocks.upsert.mockClear();
    const execute = vi.fn(async () => []);

    await processWorkouts(
      makeTransactionalTestDatabase({ execute }),
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "hang-ten-workout",
          workoutType: "20",
          startDate: "2026-08-25T14:50:32.000Z",
          endDate: "2026-08-25T14:56:13.000Z",
          duration: 341,
          totalDistance: null,
          sourceName: "Hang Ten",
          sourceBundle: "com.hangten.app",
        },
      ],
      {
        windowStart: "2026-08-18T00:00:00.000Z",
        windowEnd: "2026-08-26T00:00:00.000Z",
      },
    );

    expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "hangboard", providerType: "20" }),
        sourceName: "Hang Ten",
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "hangboard", providerType: "20" }),
        sourceName: "Hang Ten",
      }),
      expect.anything(),
    );
  });

  it("reconciles apple_health workouts missing from the HealthKit sync window", async () => {
    hangTenIntervalMocks.replace.mockClear();
    providerActivitySyncMocks.reconcile.mockClear();
    providerActivitySyncMocks.upsert.mockClear();
    providerActivitySyncMocks.scope = undefined;
    const execute = vi.fn(async () => []);

    await processWorkouts(
      makeTransactionalTestDatabase({ execute }),
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "workout-1",
          workoutType: "13",
          startDate: "2026-06-20T21:49:00.000-07:00",
          endDate: "2026-06-20T22:17:59.000-07:00",
          duration: 1738,
          totalDistance: null,
          sourceName: "WHOOP",
          sourceBundle: "com.whoop.app",
        },
      ],
      {
        windowStart: "2026-06-13T00:00:00.000Z",
        windowEnd: "2026-06-21T00:00:00.000Z",
      },
    );

    expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: appleHealthWorkoutExternalId("workout-1"),
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "device_offset",
      }),
      expect.objectContaining({
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "device_offset",
      }),
      expect.anything(),
    );
    expect(providerActivitySyncMocks.reconcile).toHaveBeenCalledTimes(1);
    expect(providerActivitySyncMocks.scope?.windowStart.toISOString()).toBe(
      "2026-06-13T00:00:00.000Z",
    );
    expect(providerActivitySyncMocks.scope?.windowEnd.toISOString()).toBe(
      "2026-06-21T00:00:00.000Z",
    );
  });

  it("persists unknown local-time context when a workout boundary lacks an offset", async () => {
    hangTenIntervalMocks.replace.mockClear();
    providerActivitySyncMocks.upsert.mockClear();
    const execute = vi.fn(async () => []);

    await processWorkouts(
      makeTransactionalTestDatabase({ execute }),
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "workout-without-end-offset",
          workoutType: "13",
          startDate: "2026-06-20T21:49:00.000Z",
          endDate: "2026-06-20T22:17:59.000",
          duration: 1738,
          totalDistance: null,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
      ],
      {
        windowStart: "2026-06-13T00:00:00.000Z",
        windowEnd: "2026-06-21T00:00:00.000Z",
      },
    );

    const unknownContext = {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      localTimeSource: "unknown",
    };
    expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining(unknownContext),
      expect.objectContaining(unknownContext),
      expect.anything(),
    );
  });

  it("commits each workout independently before reconciling the sync window", async () => {
    hangTenIntervalMocks.replace.mockClear();
    providerActivitySyncMocks.reconcile.mockClear();
    providerActivitySyncMocks.upsert.mockClear();
    const execute = vi.fn(async () => []);
    const db = makeTransactionalTestDatabase({ execute });
    const transaction = vi.spyOn(db, "transaction");

    await processWorkouts(
      db,
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "workout-1",
          workoutType: "13",
          startDate: "2026-06-20T21:49:00.000Z",
          endDate: "2026-06-20T22:17:59.000Z",
          duration: 1738,
          totalDistance: null,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
        {
          uuid: "workout-2",
          workoutType: "13",
          startDate: "2026-06-20T23:49:00.000Z",
          endDate: "2026-06-21T00:17:59.000Z",
          duration: 1738,
          totalDistance: null,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
      ],
      {
        windowStart: "2026-06-13T00:00:00.000Z",
        windowEnd: "2026-06-21T00:00:00.000Z",
      },
    );

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(providerActivitySyncMocks.reconcile).toHaveBeenCalledTimes(1);
  });

  it("normalizes Hang Ten metadata before writing its activity intervals", async () => {
    hangTenIntervalMocks.replace.mockClear();
    const execute = vi.fn(async () => []);
    const db = makeTransactionalTestDatabase({ execute });

    await processWorkouts(
      db,
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "hang-ten-workout",
          workoutType: "20",
          startDate: "2026-06-20T21:49:00.000Z",
          endDate: "2026-06-20T22:17:59.000Z",
          duration: 1738,
          totalDistance: null,
          sourceName: "Hang Ten",
          sourceBundle: "com.hangten.app",
          metadata: {
            HKMetadataKeyWorkoutBrandName: "Hang Ten",
            "HangTen.PlanName": "Max Hangs",
            "HangTen.ActivitySegments": JSON.stringify({ version: 1, segments: [] }),
          },
        },
      ],
      {
        windowStart: "2026-06-13T00:00:00.000Z",
        windowEnd: "2026-06-21T00:00:00.000Z",
      },
    );

    expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "hangboard" }),
        sourceName: "Hang Ten",
        raw: expect.objectContaining({
          hangTen: expect.objectContaining({ planName: "Max Hangs" }),
        }),
      }),
      expect.anything(),
      db,
    );
    expect(hangTenIntervalMocks.replace).toHaveBeenCalledWith(
      db,
      "activity-id",
      expect.objectContaining({
        hangTen: expect.objectContaining({ planName: "Max Hangs" }),
      }),
    );
  });

  it("writes Hang Ten intervals only when the activity upsert returns a row", async () => {
    hangTenIntervalMocks.replace.mockClear();
    providerActivitySyncMocks.upsert.mockResolvedValueOnce(undefined);
    const execute = vi.fn(async () => []);
    const db = makeTransactionalTestDatabase({ execute });

    await processWorkouts(
      db,
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "unpersisted-hang-ten-workout",
          workoutType: "20",
          startDate: "2026-06-20T21:49:00.000Z",
          endDate: "2026-06-20T22:17:59.000Z",
          duration: 1738,
          totalDistance: null,
          sourceName: "Hang Ten",
          sourceBundle: "com.hangten.app",
          metadata: {
            HKMetadataKeyWorkoutBrandName: "Hang Ten",
            "HangTen.PlanName": "Max Hangs",
          },
        },
        {
          uuid: "persisted-cycling-workout",
          workoutType: "13",
          startDate: "2026-06-20T23:49:00.000Z",
          endDate: "2026-06-21T00:17:59.000Z",
          duration: 1738,
          totalDistance: null,
          sourceName: "Apple Watch",
          sourceBundle: "com.apple.health",
        },
      ],
      {
        windowStart: "2026-06-13T00:00:00.000Z",
        windowEnd: "2026-06-21T00:00:00.000Z",
      },
    );

    expect(hangTenIntervalMocks.replace).not.toHaveBeenCalled();
  });
});
