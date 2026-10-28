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

const activityGroupMocks = vi.hoisted(() => ({
  lock: vi.fn().mockResolvedValue(undefined),
  reconcile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../src/db/activity-group-reconciliation.ts", () => ({
  lockActivityGroups: activityGroupMocks.lock,
  reconcileActivityGroups: activityGroupMocks.reconcile,
}));

vi.mock("../../../../src/db/provider-activity-sync.ts", () => ({
  ProviderActivityListSync: class {
    constructor(scope: { windowStart: Date; windowEnd: Date }) {
      providerActivitySyncMocks.scope = scope;
    }
    upsert = providerActivitySyncMocks.upsert;
    reconcile = providerActivitySyncMocks.reconcile;
    trackPresent = vi.fn();
  },
  finishProviderActivityListSync: vi.fn(),
  upsertProviderActivity: (db: unknown, values: unknown, update: unknown) =>
    providerActivitySyncMocks.upsert(values, update, db),
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
  it.each([
    ["RunningSpeed", "m/s", 4.5, "speed", 4.5],
    ["RunningSpeed", "km/h", 18, "speed", 5],
    ["RunningSpeed", "km/hr", 18, "speed", 5],
    ["RunningSpeed", "mi/h", 10, "speed", 4.4704],
    ["RunningSpeed", "mi/hr", 10, "speed", 4.4704],
    ["RunningSpeed", "mph", 10, "speed", 4.4704],
    ["RunningSpeed", "ft/s", 10, "speed", 3.048],
    ["RunningSpeed", "cm/s", 350, "speed", 3.5],
    ["RunningPower", "W", 250.5, "power", 250.5],
    ["RunningPower", "mW", 250500, "power", 250.5],
    ["RunningStrideLength", "m", 1.25, "stride_length", 1.25],
    ["RunningStrideLength", "mm", 1250, "stride_length", 1.25],
    ["RunningStrideLength", "km", 0.00125, "stride_length", 1.25],
    ["RunningStrideLength", "ft", 4, "stride_length", 1.2192],
    ["RunningStrideLength", "in", 50, "stride_length", 1.27],
    ["RunningStrideLength", "yd", 1, "stride_length", 0.9144],
    ["RunningStrideLength", "mi", 0.001, "stride_length", 1.609344],
    ["RunningGroundContactTime", "ms", 245, "ground_contact_time", 245],
    ["RunningGroundContactTime", "min", 0.004, "ground_contact_time", 240],
    ["RunningGroundContactTime", "h", 0.0001, "ground_contact_time", 360],
    ["RunningVerticalOscillation", "mm", 75, "vertical_oscillation", 75],
    ["RunningPower", "kW", 0.2505, "power", 250.5],
    ["RunningStrideLength", "cm", 125, "stride_length", 1.25],
    ["RunningGroundContactTime", "s", 0.245, "ground_contact_time", 245],
    ["RunningVerticalOscillation", "cm", 7.5, "vertical_oscillation", 75],
  ])(
    "normalizes %s and preserves series point identity",
    async (suffix, unit, value, channel, scalar) => {
      const publisher: MetricStreamEventPublisher = { publishRows: vi.fn(async () => []) };
      const samples = ["2026-10-28T10:00:00.125Z", "2026-10-28T10:00:00.875Z"].map((startDate) => ({
        ...heartRateSample,
        type: `HKQuantityTypeIdentifier${suffix}`,
        unit: String(unit),
        value: Number(value),
        startDate,
        uuid: "parent-running-sample",
      }));
      expect(
        await processMetricStream(
          makeTransactionalTestDatabase({ execute: vi.fn(async () => []) }),
          "user-1",
          samples,
          publisher,
        ),
      ).toBe(2);
      expect(publisher.publishRows).toHaveBeenCalledWith(
        samples.map((sample) =>
          expect.objectContaining({
            recordedAt: sample.startDate,
            externalId: "hk:parent-running-sample",
            deviceId: "Apple Watch",
            providerId: "apple_health",
            generation: 0,
            sourceType: "api",
            channel,
            scalar: expect.closeTo(Number(scalar), 8),
          }),
        ),
        { operationRevision: "1000000000000000" },
      );
    },
  );

  it.each([
    "RunningSpeed",
    "RunningPower",
    "RunningStrideLength",
    "RunningGroundContactTime",
    "RunningVerticalOscillation",
  ])("rejects incompatible units for %s before publication", async (suffix) => {
    const publisher: MetricStreamEventPublisher = { publishRows: vi.fn(async () => []) };
    await expect(
      processMetricStream(
        makeTransactionalTestDatabase({ execute: vi.fn(async () => []) }),
        "user-1",
        [
          {
            ...heartRateSample,
            type: `HKQuantityTypeIdentifier${suffix}`,
            unit: "kg",
          },
        ],
        publisher,
      ),
    ).rejects.toThrow(/Unsupported.*kg.*Running.*Expected/);
    expect(publisher.publishRows).not.toHaveBeenCalled();
  });

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
          sourceProductType: "Watch7,12",
          device: { name: "My Watch", model: "Watch7,12" },
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
        raw: expect.objectContaining({
          sourceBundle: "com.hangten.app",
          sourceProductType: "Watch7,12",
          device: { name: "My Watch", model: "Watch7,12" },
        }),
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "hangboard", providerType: "20" }),
        sourceName: "Hang Ten",
        raw: expect.objectContaining({
          sourceBundle: "com.hangten.app",
          sourceProductType: "Watch7,12",
          device: { name: "My Watch", model: "Watch7,12" },
        }),
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

    expect(transaction).toHaveBeenCalledTimes(3);
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

  it("reconciles workout presence and groups through the same transaction", async () => {
    providerActivitySyncMocks.reconcile.mockClear();
    activityGroupMocks.lock.mockClear();
    activityGroupMocks.reconcile.mockClear();
    const db = makeTransactionalTestDatabase({ execute: vi.fn(async () => []) });
    const transaction = makeTransactionalTestDatabase({ execute: vi.fn(async () => []) });
    vi.spyOn(db, "transaction").mockImplementation(async (work) => work(transaction));

    await processWorkouts(db, "00000000-0000-0000-0000-000000000001", [], {
      windowStart: "2026-06-13T00:00:00.000Z",
      windowEnd: "2026-06-21T00:00:00.000Z",
    });

    expect(activityGroupMocks.lock).toHaveBeenCalledWith(
      transaction,
      "00000000-0000-0000-0000-000000000001",
    );
    expect(providerActivitySyncMocks.reconcile).toHaveBeenCalledWith(
      undefined,
      { presentAppleHealthIdentities: [] },
      transaction,
    );
    expect(activityGroupMocks.reconcile).toHaveBeenCalledWith(
      transaction,
      "00000000-0000-0000-0000-000000000001",
    );
    expect(activityGroupMocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      providerActivitySyncMocks.reconcile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(providerActivitySyncMocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      activityGroupMocks.reconcile.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("rejects workout processing when activity grouping fails", async () => {
    activityGroupMocks.reconcile.mockRejectedValueOnce(new Error("Activity grouping failed"));

    await expect(
      processWorkouts(
        makeTransactionalTestDatabase({ execute: vi.fn(async () => []) }),
        "00000000-0000-0000-0000-000000000001",
        [],
        {
          windowStart: "2026-06-13T00:00:00.000Z",
          windowEnd: "2026-06-21T00:00:00.000Z",
        },
      ),
    ).rejects.toThrow("Activity grouping failed");
  });
});
