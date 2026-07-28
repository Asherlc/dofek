import { describe, expect, it, vi } from "vitest";
import { getProviderDataGenerations } from "../../../../src/db/provider-data-deletion.ts";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import {
  appleHealthWorkoutExternalId,
  processBodyMeasurements,
  processDeletedQuantitySamples,
  processMetricStream,
  processWorkouts,
} from "./health-kit-sync-processors.ts";
import type { HealthKitSample } from "./health-kit-sync-schemas.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: vi.fn(resolveProviderDataGenerationsForTest) };
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
    expect(execute).toHaveBeenCalledOnce();
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
    expect(execute).toHaveBeenCalledOnce();
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

describe("processDeletedQuantitySamples", () => {
  it("does nothing when the anchored query has no deleted UUIDs", async () => {
    vi.mocked(getProviderDataGenerations).mockClear();
    const execute = vi.fn(async () => []);
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
    };

    const deleted = await processDeletedQuantitySamples(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      "HKQuantityTypeIdentifierHeartRate",
      [],
      publisher,
    );

    expect(deleted).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(getProviderDataGenerations).not.toHaveBeenCalled();
  });

  it("fails when the metric stream publisher cannot emit deletion tombstones", async () => {
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
    };

    await expect(
      processDeletedQuantitySamples(
        { execute: vi.fn(async () => []) },
        "00000000-0000-0000-0000-000000000001",
        "HKQuantityTypeIdentifierHeartRate",
        ["heart-rate-1"],
        publisher,
      ),
    ).rejects.toThrow("Metric stream publisher does not support HealthKit deletion tombstones");
  });

  it("publishes UUID-scoped metric tombstones without deleting another provider's rows", async () => {
    const execute = vi.fn(async () => []);
    const replaceRows = vi.fn(
      async (_scope, rows: readonly never[], operationRevision: string) => ({
        deleted: {
          version: 3 as const,
          eventType: "metric_stream_deleted" as const,
          eventId: "00000000-0000-4000-8000-000000000001",
          operationRevision,
          scope: _scope,
          partitionKey: "test",
        },
        rows: [...rows],
      }),
    );
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
      replaceRows,
    };

    const deleted = await processDeletedQuantitySamples(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      "HKQuantityTypeIdentifierHeartRate",
      ["heart-rate-1", "heart-rate-2"],
      publisher,
    );

    expect(deleted).toBe(2);
    expect(getProviderDataGenerations).toHaveBeenLastCalledWith({ execute }, [
      {
        providerId: "apple_health",
        userId: "00000000-0000-0000-0000-000000000001",
      },
    ]);
    expect(replaceRows).toHaveBeenNthCalledWith(
      1,
      {
        externalId: "hk:heart-rate-1",
        providerId: "apple_health",
        userId: "00000000-0000-0000-0000-000000000001",
      },
      [],
      "1000000000000000",
    );
    expect(replaceRows).toHaveBeenNthCalledWith(
      2,
      {
        externalId: "hk:heart-rate-2",
        providerId: "apple_health",
        userId: "00000000-0000-0000-0000-000000000001",
      },
      [],
      "1000000000000000",
    );
  });

  it("deletes UUID-addressed HealthKit events without publishing metric tombstones", async () => {
    const execute = vi.fn(async () => []);
    const publisher: MetricStreamEventPublisher = {
      publishRows: vi.fn(async () => []),
      replaceRows: vi.fn(),
    };

    const deleted = await processDeletedQuantitySamples(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      "HKQuantityTypeIdentifierVO2Max",
      ["vo2-max-1"],
      publisher,
    );

    expect(deleted).toBe(1);
    expect(publisher.replaceRows).not.toHaveBeenCalled();
    expect(JSON.stringify(execute.mock.calls)).toContain("fitness.health_event");
    expect(JSON.stringify(execute.mock.calls)).toContain("hk:vo2-max-1");
  });
});

describe("processWorkouts", () => {
  it("reconciles apple_health workouts missing from the HealthKit sync window", async () => {
    providerActivitySyncMocks.reconcile.mockClear();
    providerActivitySyncMocks.upsert.mockClear();
    providerActivitySyncMocks.scope = undefined;
    const execute = vi.fn(async () => []);

    await processWorkouts(
      { execute },
      "00000000-0000-0000-0000-000000000001",
      [
        {
          uuid: "workout-1",
          workoutType: "13",
          startDate: "2026-06-20T21:49:00.000Z",
          endDate: "2026-06-20T22:17:59.000Z",
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
      }),
      expect.any(Object),
    );
    expect(providerActivitySyncMocks.reconcile).toHaveBeenCalledTimes(1);
    expect(providerActivitySyncMocks.scope?.windowStart.toISOString()).toBe(
      "2026-06-13T00:00:00.000Z",
    );
    expect(providerActivitySyncMocks.scope?.windowEnd.toISOString()).toBe(
      "2026-06-21T00:00:00.000Z",
    );
  });
});
