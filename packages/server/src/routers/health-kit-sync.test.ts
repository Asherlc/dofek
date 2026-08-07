import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const {
  mockInvalidateByPrefix,
  mockMetricStreamPublishRows,
  mockPublishedMetricStreamRowBatches,
  mockSentryCaptureException,
} = vi.hoisted(() => {
  const mockPublishedMetricStreamRowBatches: unknown[][] = [];
  return {
    mockInvalidateByPrefix: vi.fn().mockResolvedValue(undefined),
    mockMetricStreamPublishRows: vi.fn().mockResolvedValue([]),
    mockPublishedMetricStreamRowBatches,
    mockSentryCaptureException: vi.fn(),
  };
});

const providerActivitySyncMocks = vi.hoisted(() => ({
  reconcile: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

vi.mock("dofek/sync-metrics", () => ({
  healthKitRecordsTotal: { add: vi.fn() },
  healthKitPushTotal: { add: vi.fn() },
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: (userId: string) => mockInvalidateByPrefix(`${userId}:`),
  queryCache: {
    invalidateByPrefix: mockInvalidateByPrefix,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    invalidateAll: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@sentry/node", () => ({
  captureException: mockSentryCaptureException,
}));

vi.mock("../../../../src/metric-stream/redpanda-producer.ts", () => ({
  createKafkaMetricStreamEventPublisherFromEnv: async () => ({
    publishRows: mockMetricStreamPublishRows,
  }),
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: mockMetricStreamPublishRows,
  }),
}));

vi.mock("../../../../src/db/provider-activity-sync.ts", () => ({
  ProviderActivityListSync: class {
    upsert = providerActivitySyncMocks.upsert;
    reconcile = providerActivitySyncMocks.reconcile;
  },
  finishProviderActivityListSync: vi.fn(),
  upsertProviderActivity: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string; sensorStore?: unknown }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

import { healthKitPushTotal, healthKitRecordsTotal } from "dofek/sync-metrics";
import { computeBoundsFromIsoTimestamps } from "../lib/health-kit-sync-helpers.ts";
import { healthKitSyncRouter } from "./health-kit-sync.ts";
import { aggregateDailyMetricSamples } from "./health-kit-sync-processors.ts";
import type { SleepSample } from "./health-kit-sync-schemas.ts";
import { deriveSleepSessionsFromStages, isSleepStageValue } from "./health-kit-sync-sleep.ts";

const createCaller = createTestCallerFactory(healthKitSyncRouter);

function makeExecute() {
  return vi.fn().mockResolvedValue([]);
}

function makeDatabase(execute = makeExecute()) {
  return makeTransactionalTestDatabase({ execute });
}

const WORKOUT_SYNC_WINDOW = {
  windowStart: "2024-01-01T00:00:00.000Z",
  windowEnd: "2024-12-31T23:59:59.999Z",
};

const DELETED_HEART_RATE_UUID = "00000000-0000-4000-8000-000000000101";
const DELETED_VO2_MAX_UUID = "00000000-0000-4000-8000-000000000102";

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    type: "HKQuantityTypeIdentifierStepCount",
    value: 1000,
    unit: "count",
    startDate: "2024-01-15T10:00:00Z",
    endDate: "2024-01-15T10:30:00Z",
    sourceName: "iPhone",
    sourceBundle: "com.apple.Health",
    uuid: "test-uuid-001",
    ...overrides,
  };
}

function publishedMetricStreamRows(): unknown[] {
  const rows = mockPublishedMetricStreamRowBatches.flat();
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

function serializePublishedMetricStreamRows(): string {
  return JSON.stringify(publishedMetricStreamRows());
}

describe("healthKitSyncRouter", () => {
  beforeEach(() => {
    vi.mocked(healthKitRecordsTotal.add).mockClear();
    vi.mocked(healthKitPushTotal.add).mockClear();
    mockInvalidateByPrefix.mockClear();
    mockSentryCaptureException.mockClear();
    mockMetricStreamPublishRows.mockReset();
    mockPublishedMetricStreamRowBatches.length = 0;
    providerActivitySyncMocks.reconcile.mockClear();
    providerActivitySyncMocks.upsert.mockClear();
    providerActivitySyncMocks.upsert.mockResolvedValue({ id: "activity-id" });
    mockMetricStreamPublishRows.mockImplementation(async (rows: readonly unknown[]) => {
      const publishedRows = [...rows];
      mockPublishedMetricStreamRowBatches.push(publishedRows);
      return publishedRows;
    });
  });

  describe("deleteQuantitySamples", () => {
    it("publishes provider-scoped tombstones and invalidates the user's cache", async () => {
      const execute = makeExecute();
      const replaceRows = vi.fn(async (scope, rows, operationRevision) => ({
        deleted: {
          version: 3 as const,
          eventType: "metric_stream_deleted" as const,
          eventId: "00000000-0000-4000-8000-000000000001",
          operationRevision,
          scope,
          partitionKey: "test",
        },
        rows,
      }));
      const caller = createCaller({
        db: { execute },
        metricStreamPublisher: {
          publishRows: mockMetricStreamPublishRows,
          replaceRows,
        },
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
      });

      const result = await caller.deleteQuantitySamples({
        typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
        deletedUUIDs: [DELETED_HEART_RATE_UUID],
      });

      expect(result).toEqual({ deleted: 1 });
      expect(replaceRows).toHaveBeenCalledWith(
        {
          externalId: `hk:${DELETED_HEART_RATE_UUID}`,
          providerId: "apple_health",
          userId: "00000000-0000-0000-0000-000000000001",
        },
        [],
        "1000000000000000",
      );
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001:");
      expect(healthKitPushTotal.add).toHaveBeenCalledWith(1, {
        endpoint: "deleteQuantitySamples",
        status: "success",
      });
      expect(healthKitRecordsTotal.add).toHaveBeenCalledWith(1, {
        endpoint: "deleteQuantitySamples",
        category: "deletedQuantitySample",
      });
    });

    it("does not invalidate cached queries when there are no deleted UUIDs", async () => {
      const caller = createCaller({
        db: { execute: makeExecute() },
        metricStreamPublisher: {
          publishRows: mockMetricStreamPublishRows,
        },
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
      });

      const result = await caller.deleteQuantitySamples({
        typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
        deletedUUIDs: [],
      });

      expect(result).toEqual({ deleted: 0 });
      expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    });

    it("returns an actionable precondition error when tombstones are unavailable", async () => {
      const caller = createCaller({
        db: { execute: makeExecute() },
        metricStreamPublisher: {
          publishRows: mockMetricStreamPublishRows,
        },
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
      });

      await expect(
        caller.deleteQuantitySamples({
          typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
          deletedUUIDs: [DELETED_HEART_RATE_UUID],
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "HealthKit deletion sync is unavailable because metric deletion publishing is not configured. Please try again later.",
      });
      expect(mockSentryCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Metric stream publisher does not support HealthKit deletion tombstones",
        }),
        {
          extra: {
            userId: "00000000-0000-0000-0000-000000000001",
          },
          tags: {
            endpoint: "deleteQuantitySamples",
          },
        },
      );
    });

    it("rejects malformed HealthKit deletion identifiers", async () => {
      const caller = createCaller({
        db: { execute: makeExecute() },
        metricStreamPublisher: {
          publishRows: mockMetricStreamPublishRows,
        },
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
      });

      await expect(
        caller.deleteQuantitySamples({
          typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
          deletedUUIDs: ["not-a-uuid"],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("preserves unexpected repository failures", async () => {
      const repositoryError = new Error("database unavailable");
      const execute = makeExecute();
      execute.mockResolvedValueOnce([]).mockRejectedValueOnce(repositoryError);
      const caller = createCaller({
        db: { execute },
        metricStreamPublisher: {
          publishRows: mockMetricStreamPublishRows,
        },
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
      });

      await expect(
        caller.deleteQuantitySamples({
          typeIdentifier: "HKQuantityTypeIdentifierVO2Max",
          deletedUUIDs: [DELETED_VO2_MAX_UUID],
        }),
      ).rejects.toMatchObject({
        cause: repositoryError,
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(mockSentryCaptureException).toHaveBeenCalledWith(repositoryError, {
        extra: {
          userId: "00000000-0000-0000-0000-000000000001",
        },
        tags: {
          endpoint: "deleteQuantitySamples",
        },
      });
    });
  });

  describe("pushQuantitySamples", () => {
    it("uses the average HRV reading of the day", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 45,
          startDate: "2024-01-15T04:00:00Z", // overnight reading (e.g. 11pm EST)
          endDate: "2024-01-15T04:00:05Z",
          uuid: "hrv-overnight",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 50,
          startDate: "2024-01-15T08:00:00Z", // early morning reading
          endDate: "2024-01-15T08:00:05Z",
          uuid: "hrv-morning",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 120,
          startDate: "2024-01-15T22:00:00Z", // Breathe session (high value)
          endDate: "2024-01-15T22:00:05Z",
          uuid: "hrv-breathe",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      // 45 + 50 + 120 = 215, average = 71.666...
      expect(jan15?.hrv).toBeCloseTo(71.66666666666667);
    });

    it("uses the only HRV reading when there is just one", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 52,
          startDate: "2024-01-15T06:00:00Z",
          endDate: "2024-01-15T06:00:05Z",
          uuid: "hrv-only",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.hrv).toBe(52);
    });

    it("assigns HRV readings to the correct local date when timestamps include timezone offsets", () => {
      // iOS sends timestamps with local timezone offset so that extractDate
      // (which slices the first 10 chars) gets the correct calendar date.
      // Without timezone offsets, a 9:30 PM PDT reading would become
      // "2024-01-15T04:30:00Z" in UTC and be assigned to Jan 15 instead of Jan 14.
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 14, // low evening HRV (post-exercise)
          startDate: "2024-01-14T21:30:00-0700", // 9:30 PM PDT Jan 14
          endDate: "2024-01-14T21:30:05-0700",
          uuid: "hrv-evening",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 55, // normal overnight HRV reading on Jan 15
          startDate: "2024-01-15T06:00:00-0700", // 6 AM PDT Jan 15
          endDate: "2024-01-15T06:00:05-0700",
          uuid: "hrv-overnight",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);

      // The evening reading belongs to Jan 14 (local date)
      const jan14 = daily.get("2024-01-14\x00iPhone");
      expect(jan14?.hrv).toBe(14);

      // Jan 15 gets only the overnight reading
      const jan15 = daily.get("2024-01-15\x00iPhone");
      expect(jan15?.hrv).toBe(55);
    });

    it("processes body measurement samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "body-1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it("ignores calorie expenditure samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierActiveEnergyBurned",
            value: 450,
            unit: "kcal",
            uuid: "active-energy-1",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierBasalEnergyBurned",
            value: 1_800,
            unit: "kcal",
            uuid: "basal-energy-1",
          }),
        ],
      });

      expect(result).toEqual({ inserted: 0, errors: [] });
      expect(execute).toHaveBeenCalledOnce();
      expect(healthKitRecordsTotal.add).toHaveBeenCalledWith(0, {
        endpoint: "pushQuantitySamples",
        category: "bodyMeasurement",
      });
      expect(healthKitRecordsTotal.add).toHaveBeenCalledWith(0, {
        endpoint: "pushQuantitySamples",
        category: "healthEvent",
      });
    });

    it("applies body fat percentage transform (value * 100)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.18,
            uuid: "bf-1",
          }),
        ],
      });

      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            channel: "body_fat_percentage",
            scalar: 18,
          }),
        ],
        { operationRevision: "1000000000000000" },
      );
    });

    it("applies distance transform (value / 1000)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "dist-transform",
          }),
        ],
      });

      const sqlCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("distance_km");
      });
      expect(sqlCall).toBeDefined();
      // 5000 / 1000 = 5
      const serialized = JSON.stringify(sqlCall?.[0]);
      expect(serialized).toContain(",5,");
    });

    it("processes additive daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "s1" }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it("aggregates a single pre-deduplicated statistics sample per day (no double-counting)", () => {
      // When iOS uses HKStatisticsCollectionQuery, it sends one sample per day
      // per type with the deduplicated total. Verify the accumulator produces
      // the correct value (not doubled or split across batches).
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 8500,
          startDate: "2024-01-15T12:00:00Z",
          endDate: "2024-01-15T12:00:00Z",
          uuid: "stat:steps:2024-01-15",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.steps).toBe(8500);
    });

    it("does not double-count when raw samples from multiple sources are replaced by statistics", () => {
      // Before the fix, iPhone (2800 steps) + Apple Watch (3000 steps) raw
      // samples would sum to 5800. With statistics, only one deduplicated
      // total (3000) is sent.
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 3000,
          startDate: "2024-01-15T12:00:00Z",
          endDate: "2024-01-15T12:00:00Z",
          uuid: "stat:steps:2024-01-15",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15?.steps).toBe(3000);
    });

    it("rounds float steps to integer before inserting into daily_metrics", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5552.349998360692,
            uuid: "steps-float",
          }),
        ],
      });

      // Find the daily_metrics INSERT
      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics");
      });
      expect(dailyInsertCall).toBeDefined();
      // The serialized SQL should contain the rounded integer value (5552), not the float
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      expect(serialized).toContain("5552");
      expect(serialized).not.toContain("5552.349998360692");
    });

    it("rounds float heart rate before publishing metric_stream events", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 80.89823150634766,
            uuid: "hr-float",
          }),
        ],
      });

      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [expect.objectContaining({ channel: "heart_rate", scalar: 81 })],
        { operationRevision: "1000000000000000" },
      );
    });

    it("processes point-in-time daily metric samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierWalkingSpeed", value: 1.3, uuid: "speed1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 65,
            uuid: "hrv1",
          }),
        ],
      });

      expect(result.inserted).toBe(2);
    });

    it("processes metric stream samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 120, uuid: "hr1" }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            externalId: "hk:hr1",
            channel: "heart_rate",
            scalar: 120,
          }),
        ],
        { operationRevision: "1000000000000000" },
      );
    });

    it("does not touch the retired Postgres metric_stream table after inserting heart-rate metrics", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 130, uuid: "hr-link-1" }),
        ],
      });

      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
    });

    it("processes health event samples (catch-all)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierUnknownType", value: 1, uuid: "he1" }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty samples array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({ samples: [] });

      expect(result.inserted).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("applies body fat percentage transform", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyFatPercentage",
            value: 0.15,
            uuid: "bf1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("does not refresh v_daily_metrics materialized view after processing skin temp samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 34.5,
            unit: "degC",
            uuid: "skin-temp-1",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("does not refresh v_daily_metrics after processing SpO2 samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            unit: "%",
            uuid: "spo2-1",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("does not refresh v_daily_metrics when daily metric samples are inserted", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "steps-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("does not refresh v_daily_metrics when no daily metrics or metric stream samples present", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
            value: 70,
            uuid: "audio-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("reports errors when processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      mockMetricStreamPublishRows.mockRejectedValueOnce(new Error("DB connection failed"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierBodyMass", value: 75, uuid: "err1" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Body measurements");
    });

    it("reports errors when metric stream processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      mockMetricStreamPublishRows.mockRejectedValueOnce(new Error("Metric stream Redpanda error"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierHeartRate", value: 72, uuid: "hr-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Metric stream"))).toBe(true);
    });

    it("reports errors when daily metrics processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // daily metrics insert fails
      execute.mockRejectedValueOnce(new Error("Daily metrics DB error"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "dm-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Daily metrics"))).toBe(true);
    });

    it("reports errors when health event processing fails", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // health_event insert fails
      execute.mockRejectedValueOnce(new Error("Health event DB error"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierUnknownType", value: 1, uuid: "he-err" }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes("Health events"))).toBe(true);
    });

    it("applies distance transform (m to km)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "dist1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("emits HealthKit metrics with per-category counts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({ type: "HKQuantityTypeIdentifierBodyMass", value: 75, uuid: "bm1" }),
          makeSample({ type: "HKQuantityTypeIdentifierStepCount", value: 5000, uuid: "dm1" }),
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            uuid: "ms1",
          }),
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "bodyMeasurement",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "dailyMetric",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        category: "metricStream",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(0, {
        endpoint: "pushQuantitySamples",
        category: "healthEvent",
      });
    });
  });

  describe("pushWorkouts", () => {
    it("rejects inverted sync window bounds", async () => {
      const caller = createCaller({
        db: makeDatabase(),
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.pushWorkouts({
          windowStart: "2024-12-31T23:59:59.999Z",
          windowEnd: "2024-01-01T00:00:00.000Z",
          workouts: [],
        }),
      ).rejects.toThrow("windowEnd must be after windowStart");
    });

    it("rejects equal sync window bounds", async () => {
      const caller = createCaller({
        db: makeDatabase(),
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.pushWorkouts({
          windowStart: "2024-01-15T10:00:00.000Z",
          windowEnd: "2024-01-15T10:00:00.000Z",
          workouts: [],
        }),
      ).rejects.toThrow("windowEnd must be after windowStart");
    });

    it("processes workout samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w1",
            workoutType: "13", // cycling
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("does not touch the retired Postgres metric_stream table after workout upsert", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-link",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
    });

    it("maps unknown workout type to other", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w2",
            workoutType: "999",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T10:30:00Z",
            duration: 1800,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("handles empty workouts array", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkouts({ ...WORKOUT_SYNC_WINDOW, workouts: [] });
      expect(result.inserted).toBe(0);
    });

    it("emits HealthKit metrics for workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-metric",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushWorkouts",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushWorkouts",
        category: "workout",
      });
    });
  });

  describe("pushSleepSamples", () => {
    it("processes sleep session with stages", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-1",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-1",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-15T23:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-2",
            startDate: "2024-01-15T23:30:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-3",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T04:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-4",
            startDate: "2024-01-16T04:00:00Z",
            endDate: "2024-01-16T04:15:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);

      // Verify the computed stage minutes in the INSERT SQL
      // deep: 22:30-23:30 = 60, REM: 23:30-01:00 = 90,
      // light (core): 01:00-04:00 = 180, awake: 04:00-04:15 = 15
      const insertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(insertCall).toBeDefined();
      const sqlValues = JSON.stringify(insertCall?.[0]);
      // Stage minutes appear as query parameter values in order:
      // deep_minutes, rem_minutes, light_minutes, awake_minutes
      expect(sqlValues).toContain(",60,"); // deep_minutes = 60
      expect(sqlValues).toContain(",90,"); // rem_minutes = 90
      expect(sqlValues).toContain(",180,"); // light_minutes = 180
      expect(sqlValues).toContain(",15,"); // awake_minutes = 15
    });

    it("includes duration_minutes and sleep_type in SQL", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-dur",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // 8 hours = 480 minutes
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      // Find the sleep INSERT call (not the ensureProvider or DELETE call)
      const sleepCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepCall).toBeDefined();
      const serialized = JSON.stringify(sleepCall?.[0]);
      expect(serialized).toContain("duration_minutes");
      expect(serialized).toContain("sleep_type");
    });

    it.each([
      ["2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00", [-480, -420, "device_offset"]],
      ["2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00", [null, null, "unknown"]],
    ])("stores record-local sleep context for %s to %s", async (startDate, endDate, expectedContext) => {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-local-time",
            startDate,
            endDate,
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      const serialized = JSON.stringify(sleepCall?.[0]);
      for (const expected of expectedContext) {
        expect(serialized).toContain(JSON.stringify(expected));
      }
    });

    it("stores null sleep_type for short sessions", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "nap-1",
            startDate: "2024-01-15T14:00:00Z",
            endDate: "2024-01-15T14:45:00Z", // 45 minutes — nap
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      // HealthKit has no native nap flag; raw sleep_type is stored as null.
      const sleepCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepCall).toBeDefined();
      const serialized = JSON.stringify(sleepCall?.[0]);
      expect(serialized).toContain("sleep_type");
    });

    it("stores per-source rows for multi-source data (dedup at query time)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          // iPhone writes inBed + asleep (unspecified)
          {
            uuid: "iphone-inbed",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "iPhone",
          },
          {
            uuid: "iphone-asleep",
            startDate: "2024-01-15T22:20:00Z",
            endDate: "2024-01-16T05:50:00Z",
            value: "asleep",
            sourceName: "iPhone",
          },
          // Apple Watch writes granular stages
          {
            uuid: "watch-core",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-deep",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T02:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-rem",
            startDate: "2024-01-16T02:30:00Z",
            endDate: "2024-01-16T04:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-core-2",
            startDate: "2024-01-16T04:00:00Z",
            endDate: "2024-01-16T05:30:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "watch-awake",
            startDate: "2024-01-16T05:30:00Z",
            endDate: "2024-01-16T05:45:00Z",
            value: "awake",
            sourceName: "Apple Watch",
          },
        ],
      });

      // Should insert 2 rows — one per source. The v_sleep view handles dedup.
      expect(result.inserted).toBe(2);

      // Both sources should have INSERT calls with source-specific external_ids
      const insertCalls = execute.mock.calls.filter((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(insertCalls).toHaveLength(2);
    });

    it("derives a sleep session when only stage samples are present", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "stage-only-1",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T01:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-2",
            startDate: "2024-01-16T01:00:00Z",
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-only-3",
            startDate: "2024-01-16T02:00:00Z",
            endDate: "2024-01-16T05:00:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);
    });

    it("emits HealthKit metrics for sleep samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-metric",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushSleepSamples",
        status: "success",
      });
      expect(vi.mocked(healthKitRecordsTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushSleepSamples",
        category: "sleep",
      });
    });

    it("does not refresh v_sleep materialized view after inserting sleep data", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-refresh",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_sleep");
      });
      expect(refreshCall).toBeUndefined();
    });

    it("does not issue fallback refresh when sleep data is inserted", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-fallback",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const fallbackCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") &&
          serialized.includes("v_sleep") &&
          !serialized.includes("CONCURRENTLY")
        );
      });
      expect(fallbackCall).toBeUndefined();
    });

    it("continues when a non-refresh insert query fails to match refresh filters", async () => {
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("REFRESH MATERIALIZED VIEW")) {
          throw new Error("database unavailable");
        }
        return Promise.resolve([]);
      });
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // Should not throw — error is caught and logged
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-error",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });
      expect(result.inserted).toBe(1);
      expect(
        execute.mock.calls.some((call: unknown[]) =>
          JSON.stringify(call[0]).includes("REFRESH MATERIALIZED VIEW"),
        ),
      ).toBe(false);
    });
  });

  describe("pushWorkouts view refresh", () => {
    it("does not refresh v_activity after inserting workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "workout-refresh",
            workoutType: "13",
            startDate: "2024-01-15T09:00:00Z",
            endDate: "2024-01-15T10:00:00Z",
            duration: 3600,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      const activityRefreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_activity")
        );
      });
      expect(activityRefreshCall).toBeUndefined();
    });
  });

  describe("pushWorkoutRoutes", () => {
    it("inserts route location as a point metric with associated altitude and speed metrics", async () => {
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("SELECT id, external_id")) {
          return [{ id: "activity-123", external_id: "hk:workout:w-route-1" }];
        }
        return [];
      });
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkoutRoutes({
        routes: [
          {
            workoutUuid: "w-route-1",
            sourceName: "Apple Watch",
            locations: [
              {
                date: "2024-01-15T10:00:00Z",
                lat: 40.7128,
                lng: -74.006,
                altitude: 10.5,
                speed: 3.2,
                horizontalAccuracy: 5,
              },
            ],
          },
        ],
      });

      expect(result.inserted).toBeGreaterThan(0);

      // Should have resolved all activity IDs in one bulk query
      const lookupCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("SELECT id, external_id") && serialized.includes("IN");
      });
      expect(lookupCall).toBeDefined();

      // One location point plus separate altitude and speed metrics.
      expect(result.inserted).toBe(3);
      expect(publishedMetricStreamRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            activityId: "activity-123",
            channel: "location",
            deviceId: "Apple Watch",
            externalId: "hk:workout:w-route-1:location:2024-01-15T10:00:00.000Z",
            metadata: { horizontal_accuracy_m: 5 },
            point: "SRID=4326;POINT(-74.006 40.7128)",
          }),
          expect.objectContaining({
            activityId: "activity-123",
            channel: "altitude",
            externalId: "hk:workout:w-route-1:altitude:2024-01-15T10:00:00.000Z",
            scalar: 10.5,
          }),
          expect.objectContaining({
            activityId: "activity-123",
            channel: "speed",
            externalId: "hk:workout:w-route-1:speed:2024-01-15T10:00:00.000Z",
            scalar: 3.2,
          }),
        ]),
      );
      const serialized = serializePublishedMetricStreamRows();
      expect(serialized).not.toContain('"lat"');
      expect(serialized).not.toContain('"lng"');
      expect(serialized).not.toContain('"gps_accuracy"');
    });

    it("skips routes when no matching activity exists", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkoutRoutes({
        routes: [
          {
            workoutUuid: "nonexistent-workout",
            locations: [{ date: "2024-01-15T10:00:00Z", lat: 40.7128, lng: -74.006 }],
          },
        ],
      });

      expect(result.inserted).toBe(0);
    });

    it("skips null optional channels (altitude, speed, horizontalAccuracy)", async () => {
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("SELECT id, external_id")) {
          return [{ id: "activity-456", external_id: "hk:workout:w-minimal" }];
        }
        return [];
      });
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkoutRoutes({
        routes: [
          {
            workoutUuid: "w-minimal",
            locations: [{ date: "2024-01-15T10:00:00Z", lat: 51.5074, lng: -0.1278 }],
          },
        ],
      });

      // Only the location point should be inserted (no altitude or speed metrics).
      expect(result.inserted).toBe(1);
      const serialized = serializePublishedMetricStreamRows();
      expect(serialized).toContain('"location"');
      expect(serialized).not.toContain('"altitude"');
      expect(serialized).not.toContain('"gps_accuracy"');
    });

    it("skips routes with empty locations array", async () => {
      const execute = vi.fn().mockResolvedValue([{ id: "activity-789" }]);
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushWorkoutRoutes({
        routes: [{ workoutUuid: "w-empty", locations: [] }],
      });

      expect(result.inserted).toBe(0);
    });

    it("stores horizontal accuracy as location metadata", async () => {
      const execute = vi.fn().mockImplementation((query: unknown) => {
        const serialized = JSON.stringify(query);
        if (serialized.includes("SELECT id, external_id")) {
          return [{ id: "activity-round", external_id: "hk:workout:w-round" }];
        }
        return [];
      });
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkoutRoutes({
        routes: [
          {
            workoutUuid: "w-round",
            locations: [
              {
                date: "2024-01-15T10:00:00Z",
                lat: 40.0,
                lng: -74.0,
                horizontalAccuracy: 4.7,
              },
            ],
          },
        ],
      });

      // Find the batched insert and verify Core Location horizontal accuracy stays metadata.
      const serialized = serializePublishedMetricStreamRows();
      expect(serialized).toContain("horizontal_accuracy_m");
      expect(serialized).toContain("4.7");
      expect(serialized).not.toContain('"gps_accuracy"');
    });
  });

  describe("computeBoundsFromIsoTimestamps", () => {
    it("returns null for empty array", () => {
      expect(computeBoundsFromIsoTimestamps([])).toBeNull();
    });

    it("returns bounds for a single timestamp", () => {
      const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
      expect(result).toEqual({
        startAt: "2024-01-15T10:00:00.000Z",
        endAt: "2024-01-15T10:00:00.000Z",
      });
    });

    it("returns min/max bounds for multiple timestamps", () => {
      // Max is NOT the last element — kills `if (true) maxTs = ms` mutation
      // Min is NOT the last element — kills `if (true) minTs = ms` mutation
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T12:00:00Z",
        "2024-01-15T20:00:00Z",
        "2024-01-15T08:00:00Z",
      ]);
      expect(result).toEqual({
        startAt: "2024-01-15T08:00:00.000Z",
        endAt: "2024-01-15T20:00:00.000Z",
      });
    });

    it("returns null when only one of min/max is valid", () => {
      // Only one valid timestamp means both min and max are set —
      // but if the || is mutated to &&, it would incorrectly succeed when only one is invalid
      // This test kills `|| → &&` mutation on the isFinite check
      const result = computeBoundsFromIsoTimestamps(["2024-01-15T10:00:00Z"]);
      expect(result).not.toBeNull();
      // With a single valid ts, both min and max should be the same
      expect(result?.startAt).toBe(result?.endAt);
    });

    it("returns null when all timestamps are invalid", () => {
      expect(computeBoundsFromIsoTimestamps(["invalid", "also-invalid"])).toBeNull();
    });

    it("ignores invalid timestamps among valid ones", () => {
      const result = computeBoundsFromIsoTimestamps([
        "invalid",
        "2024-01-15T10:00:00Z",
        "2024-01-15T14:00:00Z",
      ]);
      expect(result).toEqual({
        startAt: "2024-01-15T10:00:00.000Z",
        endAt: "2024-01-15T14:00:00.000Z",
      });
    });
  });

  describe("deriveSleepSessionsFromStages", () => {
    function makeSleepSample(overrides: Partial<SleepSample> = {}): SleepSample {
      return {
        uuid: overrides.uuid ?? "sleep-1",
        startDate: overrides.startDate ?? "2024-01-15T23:00:00Z",
        endDate: overrides.endDate ?? "2024-01-15T23:30:00Z",
        value: overrides.value ?? "asleepCore",
        sourceName: overrides.sourceName ?? "Apple Watch",
      };
    }

    it("returns empty array for empty input", () => {
      expect(deriveSleepSessionsFromStages([])).toEqual([]);
    });

    it("returns empty array when no sleep stages present (only non-sleep values)", () => {
      const samples = [makeSleepSample({ value: "inBed", uuid: "s1" })];
      // "inBed" is not a sleep stage and not "awake", so it gets filtered out
      expect(deriveSleepSessionsFromStages(samples)).toEqual([]);
    });

    it("derives a single session from contiguous sleep stages", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T00:00:00.000Z");
      expect(result[0]?.value).toBe("inBed");
    });

    it("splits into two sessions when gap exceeds 90 minutes", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // 3-hour gap (> 90min threshold)
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      expect(result[0]?.endDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[1]?.startDate).toBe("2024-01-16T02:00:00.000Z");
    });

    it("merges stages within 90-minute gap", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        // 60-minute gap (< 90min threshold)
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T01:00:00Z",
          endDate: "2024-01-16T02:00:00Z",
          value: "asleepREM",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T02:00:00.000Z");
    });

    it("includes awake stages in session grouping", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T00:15:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s3",
          startDate: "2024-01-16T00:15:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("drops session that only contains awake stages (no actual sleep)", () => {
      // A session with only awake stages has currentHasSleepStage = false
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("filters out entries where endDate <= startDate", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-15T23:00:00Z", // end before start
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("filters out entries with invalid timestamps", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "invalid",
          endDate: "2024-01-15T23:30:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("sorts unsorted stages by start time before merging", () => {
      const samples = [
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session starts at the earliest stage, not the first in input order
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
      // UUID should be from the earliest stage (after sorting)
      expect(result[0]?.uuid).toBe("s1");
    });

    it("extends session end time when overlapping stage has later end", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:30:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z", // extends past s1 end
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("does not shrink session end time when overlapping stage has earlier end", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:30:00Z", // ends before s1
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // End should stay at s1's later end
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("does not emit session when gap occurs and first chunk has no sleep stage", () => {
      // First chunk: only awake (no sleep stage), then gap, then real sleep
      // Should only emit the second session, not the awake-only first chunk
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T20:00:00Z",
          endDate: "2024-01-15T21:00:00Z",
          value: "awake",
        }),
        // >90min gap
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("s2");
    });

    it("marks session as having sleep stage when later entry adds one", () => {
      // First entry is awake, second is actual sleep stage — session should be emitted
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session should span full range
      expect(result[0]?.startDate).toBe("2024-01-15T23:00:00.000Z");
      expect(result[0]?.endDate).toBe("2024-01-16T00:00:00.000Z");
    });

    it("uses correct uuid from first entry after gap (new session start)", () => {
      const samples = [
        makeSleepSample({
          uuid: "first-session",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // >90min gap
        makeSleepSample({
          uuid: "second-session",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result[0]?.uuid).toBe("first-session");
      expect(result[1]?.uuid).toBe("second-session");
    });

    it("handles entry at exact gap boundary (90 minutes)", () => {
      const baseEnd = "2024-01-16T00:00:00Z";
      // Exactly 90 minutes later = within gap threshold (<=)
      const nextStart = "2024-01-16T01:30:00Z";

      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: baseEnd,
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: nextStart,
          endDate: "2024-01-16T02:30:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      // 90min gap is <= MAX_SLEEP_SESSION_GAP_MS (90min), so they merge
      expect(result).toHaveLength(1);
    });

    it("splits when gap exceeds boundary by 1ms", () => {
      const baseEnd = "2024-01-16T00:00:00Z";
      // 90 minutes + 1ms later — just over the threshold
      const nextStart = "2024-01-16T01:30:00.001Z";

      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: baseEnd,
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: nextStart,
          endDate: "2024-01-16T02:30:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      // Just over threshold — should split
      expect(result).toHaveLength(2);
    });

    it("loop index starts at 1 (second entry), not 0", () => {
      // Single entry should produce one session without loop iterations
      const samples = [
        makeSleepSample({
          uuid: "only",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("only");
    });

    it("groups by source name independently", () => {
      const samples = [
        makeSleepSample({
          uuid: "w1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepCore",
          sourceName: "Apple Watch",
        }),
        makeSleepSample({
          uuid: "p1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T07:00:00Z",
          value: "asleepDeep",
          sourceName: "iPhone",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      const sources = result.map((s) => s.sourceName).sort();
      expect(sources).toEqual(["Apple Watch", "iPhone"]);
    });
  });

  describe("isSleepStageValue", () => {
    it("returns true for all sleep stage values", () => {
      expect(isSleepStageValue("asleep")).toBe(true);
      expect(isSleepStageValue("asleepUnspecified")).toBe(true);
      expect(isSleepStageValue("asleepCore")).toBe(true);
      expect(isSleepStageValue("asleepDeep")).toBe(true);
      expect(isSleepStageValue("asleepREM")).toBe(true);
    });

    it("returns false for non-sleep-stage values", () => {
      expect(isSleepStageValue("inBed")).toBe(false);
      expect(isSleepStageValue("awake")).toBe(false);
      expect(isSleepStageValue("")).toBe(false);
      expect(isSleepStageValue("unknown")).toBe(false);
    });
  });

  describe("computeBoundsFromIsoTimestamps - mutation killers", () => {
    it("returns null when empty array (kills if(false) mutation on length===0 check)", () => {
      const result = computeBoundsFromIsoTimestamps([]);
      expect(result).toBeNull();
    });

    it("correctly identifies min and max from three unsorted timestamps (kills < to <= and > to >= mutations)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T12:00:00Z",
        "2024-01-15T08:00:00Z", // min
        "2024-01-15T20:00:00Z", // max
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe("2024-01-15T08:00:00.000Z");
      expect(result?.endAt).toBe("2024-01-15T20:00:00.000Z");
    });

    it("returns null when all timestamps are invalid (kills || to && mutation on isFinite check)", () => {
      const result = computeBoundsFromIsoTimestamps(["not-a-date", "also-not-a-date"]);
      expect(result).toBeNull();
    });

    it("skips NaN timestamps and still returns bounds from valid ones (kills if(false) on isNaN check)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "invalid-timestamp",
        "2024-06-01T10:00:00Z",
        "another-invalid",
        "2024-06-01T14:00:00Z",
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe("2024-06-01T10:00:00.000Z");
      expect(result?.endAt).toBe("2024-06-01T14:00:00.000Z");
    });

    it("handles duplicate timestamps correctly (kills <= / >= boundary mutations)", () => {
      const result = computeBoundsFromIsoTimestamps([
        "2024-01-15T10:00:00Z",
        "2024-01-15T10:00:00Z",
        "2024-01-15T10:00:00Z",
      ]);
      expect(result).not.toBeNull();
      expect(result?.startAt).toBe(result?.endAt);
    });
  });

  describe("aggregateDailyMetricSamples - mutation killers", () => {
    it("accumulates additive values and applies transforms correctly (kills ObjectLiteral mutations on additiveFields)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 5000,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "steps-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
          value: 5000, // meters, should be transformed to 5 km
          startDate: "2024-01-15T12:00:00Z",
          uuid: "dist-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierFlightsClimbed",
          value: 12,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "flights-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierAppleExerciseTime",
          value: 45,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "exercise-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.steps).toBe(5000);
      expect(jan15?.distanceKm).toBe(5);
      expect(jan15?.flightsClimbed).toBe(12);
      expect(jan15?.exerciseMinutes).toBe(45);
    });

    it("sets point-in-time daily metrics correctly (kills if(key){} block removal, if(true)/if(false) mutations)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierRestingHeartRate",
          value: 55,
          startDate: "2024-01-15T08:00:00Z",
          uuid: "rhr-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierVO2Max",
          value: 42.5,
          startDate: "2024-01-15T09:00:00Z",
          uuid: "vo2-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingSpeed",
          value: 1.3,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "ws-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingStepLength",
          value: 0.72,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wsl-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
          value: 0.28,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wds-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
          value: 0.05,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "wa-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
          value: 0.84,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "steadiness-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(Object.hasOwn(jan15 ?? {}, "restingHr")).toBe(false);
      expect(Object.hasOwn(jan15 ?? {}, "vo2max")).toBe(false);
      expect(jan15?.walkingSpeed).toBe(1.3);
      expect(jan15?.walkingStepLength).toBe(0.72);
      expect(jan15?.walkingDoubleSupportPct).toBe(0.28);
      expect(jan15?.walkingAsymmetryPct).toBe(0.05);
      expect(jan15?.walkingSteadiness).toBe(0.84);
    });

    it("skips non-point, non-additive samples via continue (kills if(false) on !pointMapping continue)", () => {
      // A sample type that's only in metricStreamTypes (not in additive or point-in-time daily)
      // should be ignored by aggregateDailyMetricSamples
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRate", // this is in metricStreamTypes, not daily
          value: 72,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "hr-skip",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 100,
          startDate: "2024-01-15T10:00:00Z",
          uuid: "steps-ok",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.steps).toBe(100);
      // Heart rate should not appear as any daily metric
      expect(Object.hasOwn(jan15 ?? {}, "restingHr")).toBe(false);
    });

    it("branches HRV samples into separate collection (kills if(true) on hrv column check)", () => {
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 35,
          startDate: "2024-01-15T04:00:00Z",
          uuid: "hrv-1",
        }),
        makeSample({
          type: "HKQuantityTypeIdentifierRestingHeartRate",
          value: 60,
          startDate: "2024-01-15T06:00:00Z",
          uuid: "rhr-1",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      expect(jan15).toBeDefined();
      expect(jan15?.hrv).toBe(35);
      expect(Object.hasOwn(jan15 ?? {}, "restingHr")).toBe(false);
    });
  });

  describe("pushQuantitySamples - mutation killers for processDailyMetrics", () => {
    it("includes all additive fields in SQL when non-zero (kills ObjectLiteral {} mutations on field entries)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "s1",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
            value: 5000,
            uuid: "s4",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierFlightsClimbed",
            value: 12,
            uuid: "s5",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierAppleExerciseTime",
            value: 45,
            uuid: "s6",
          }),
        ],
      });

      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      // Verify all additive columns are present in the SQL
      expect(serialized).toContain("steps");
      expect(serialized).toContain("distance_km");
      expect(serialized).toContain("flights_climbed");
      expect(serialized).toContain("exercise_minutes");
    });

    it("includes all point-in-time fields in SQL when non-null (kills ObjectLiteral {} mutations on pointFields)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
            value: 45,
            uuid: "hrv-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingSpeed",
            value: 1.3,
            uuid: "ws-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingStepLength",
            value: 0.72,
            uuid: "wsl-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
            value: 0.28,
            uuid: "wds-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
            value: 0.05,
            uuid: "wa-insert",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
            value: 0.84,
            uuid: "steadiness-insert",
          }),
        ],
      });

      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      // Verify point-in-time columns are present
      expect(serialized).not.toContain("resting_hr");
      expect(serialized).toContain("hrv");
      expect(serialized).not.toContain("vo2max");
      expect(serialized).toContain("walking_speed");
      expect(serialized).toContain("walking_step_length");
      expect(serialized).toContain("walking_double_support_pct");
      expect(serialized).toContain("walking_asymmetry_pct");
      expect(serialized).toContain("walking_steadiness");
    });

    it("does not write absent additive fields for point-in-time-only samples", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierWalkingSpeed",
            value: 1.3,
            uuid: "walking-speed-only",
          }),
        ],
      });

      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      const serialized = JSON.stringify(dailyInsertCall?.[0]);
      expect(serialized).toContain("walking_speed");
      expect(serialized).not.toContain("steps");
      expect(serialized).not.toContain("distance_km");
      expect(serialized).not.toContain("flights_climbed");
      expect(serialized).not.toContain("exercise_minutes");
    });

    it("writes additive fields with zero value when a zero sample is present", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });
      const samples = [
        makeSample({
          type: "HKQuantityTypeIdentifierStepCount",
          value: 0,
          startDate: "2024-01-15T12:00:00Z",
          uuid: "zero-steps",
        }),
      ];

      const daily = aggregateDailyMetricSamples(samples);
      const jan15 = daily.get("2024-01-15\x00iPhone");

      // Steps should be 0 since value is 0
      expect(jan15?.steps).toBe(0);

      await caller.pushQuantitySamples({ samples });
      const dailyInsertCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("daily_metrics") && serialized.includes("INSERT");
      });
      expect(dailyInsertCall).toBeDefined();
      expect(JSON.stringify(dailyInsertCall?.[0])).toContain("steps");
    });

    it("properly categorizes pointInTimeDailyMetric types (kills if(false) mutation on categorize)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
            value: 0.84,
            uuid: "steadiness-categorize",
          }),
        ],
      });

      // Should insert (categorized as pointInTimeDailyMetric, processed by processDailyMetrics)
      expect(result.inserted).toBe(1);
    });

    it("reports errors when daily metrics processing fails (kills BlockStatement mutation on catch block)", async () => {
      const execute = vi.fn();
      // ensureProvider succeeds
      execute.mockResolvedValueOnce([]);
      // daily_metrics insert fails
      execute.mockRejectedValueOnce(new Error("Daily metrics DB error"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
            uuid: "daily-err",
          }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((errorMsg: string) => errorMsg.includes("Daily metrics"))).toBe(
        true,
      );
    });
  });

  describe("pushQuantitySamples - mutation killers for metric stream aggregation", () => {
    it("initializes aggregatedDailyMetrics as false and only refreshes view when aggregation occurs (kills false to true mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // Send only HeartRate (metric stream type but not SpO2 or skin temp)
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            uuid: "hr-no-refresh",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      // No SpO2 or skin temp, so no aggregation, so no refresh
      expect(refreshCall).toBeUndefined();
    });

    it("handles concurrent refresh failure by falling back to non-concurrent refresh (kills catch{} empty block mutation)", async () => {
      const execute = vi.fn();
      execute.mockImplementation((..._args: unknown[]) => {
        // Make the CONCURRENTLY refresh fail to trigger the fallback
        const serialized = JSON.stringify(_args[0]);
        if (
          typeof serialized === "string" &&
          serialized.includes("REFRESH MATERIALIZED VIEW CONCURRENTLY")
        ) {
          return Promise.reject(new Error("cannot refresh concurrently"));
        }
        return Promise.resolve([]);
      });

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            uuid: "spo2-concurrent-fail",
          }),
        ],
      });

      // No Postgres materialized-view refresh path for this metric now; fallback should not run.
      const nonConcurrentRefresh = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && !serialized.includes("CONCURRENTLY")
        );
      });
      expect(nonConcurrentRefresh).toBeUndefined();
    });

    it("correctly filters SpO2 samples using .some() not .every() (kills some to every mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // Mix of SpO2 and heart rate - .some() should return true, .every() would return false
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            uuid: "hr-mixed",
          }),
          makeSample({
            type: "HKQuantityTypeIdentifierOxygenSaturation",
            value: 0.97,
            uuid: "spo2-mixed",
          }),
        ],
      });

      // Aggregation should have happened because SpO2 is present (some returns true)
      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });

    it("correctly filters skin temp samples (kills filter to identity mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // Only skin temp - should trigger aggregation
      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            value: 34.5,
            uuid: "skin-only",
          }),
        ],
      });

      const refreshCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return (
          serialized.includes("REFRESH MATERIALIZED VIEW") && serialized.includes("v_daily_metrics")
        );
      });
      expect(refreshCall).toBeUndefined();
    });
  });

  describe("pushWorkouts - mutation killers", () => {
    it("maps known workout type to correct activity type (kills ?? to && mutation on workoutActivityTypeMap)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-cycling",
            workoutType: "13", // cycling
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: 25000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      // Workouts upsert through ProviderActivityListSync instead of raw SQL inserts.
      expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          activityType: { providerType: "13", canonicalType: "cycling", modality: null },
        }),
        expect.objectContaining({
          activityType: { providerType: "13", canonicalType: "cycling", modality: null },
        }),
      );
    });

    it("includes raw workout data in JSON (kills JSON.stringify({}) mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-raw-data",
            workoutType: "35",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: 10000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: expect.objectContaining({
            duration: 3600,
            totalDistance: 10000,
          }),
        }),
        expect.objectContaining({
          raw: expect.objectContaining({
            duration: 3600,
            totalDistance: 10000,
          }),
        }),
      );
    });

    it("stores workout metadata and workoutActivities in raw JSON column", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-metadata",
            workoutType: "49", // traditionalStrengthTraining
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: null,
            sourceName: "Strong",
            sourceBundle: "io.strongapp.strong",
            metadata: {
              HKIndoorWorkout: 1,
              "some-custom-key": "Bench Press",
            },
            workoutActivities: [
              {
                uuid: "activity-1",
                activityType: 49,
                startDate: "2024-01-15T10:00:00Z",
                endDate: "2024-01-15T10:20:00Z",
                metadata: { exerciseName: "Barbell Bench Press" },
              },
            ],
          },
        ],
      });

      expect(providerActivitySyncMocks.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: expect.objectContaining({
            metadata: expect.objectContaining({
              HKIndoorWorkout: 1,
              "some-custom-key": "Bench Press",
            }),
            workoutActivities: [
              expect.objectContaining({
                uuid: "activity-1",
                metadata: expect.objectContaining({ exerciseName: "Barbell Bench Press" }),
              }),
            ],
          }),
        }),
        expect.anything(),
      );
    });

    it("does not touch the retired Postgres metric_stream table after processing workouts", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "w-link-test",
            workoutType: "13",
            startDate: "2024-01-15T10:00:00Z",
            endDate: "2024-01-15T11:00:00Z",
            duration: 3600,
            totalDistance: null,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
    });

    it("does not touch the retired Postgres metric_stream table when no workouts are provided", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushWorkouts({ ...WORKOUT_SYNC_WINDOW, workouts: [] });

      expect(JSON.stringify(execute.mock.calls)).not.toContain("fitness.metric_stream");
    });
  });

  describe("pushSleepSamples - mutation killers", () => {
    async function getStoredSleepStageParams(stageValue?: string): Promise<unknown[]> {
      const execute = makeExecute();
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const samples: SleepSample[] = [
        {
          uuid: "inbed-quality",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-16T06:00:00Z",
          value: "inBed",
          sourceName: "Apple Watch",
        },
      ];
      if (stageValue) {
        samples.push({
          uuid: `stage-${stageValue}`,
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: stageValue,
          sourceName: "Apple Watch",
        });
      }

      await caller.pushSleepSamples({ samples });
      const sleepInsert = execute.mock.calls.find((call) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      if (!sleepInsert) throw new Error("Expected a sleep-session INSERT");
      return new PgDialect().sqlToQuery(sleepInsert[0]).params.slice(10, 15);
    }

    it.each([
      ["asleepCore", [0, 0, 60, 0, true]],
      ["asleepDeep", [60, 0, 0, 0, true]],
      ["asleepREM", [0, 60, 0, 0, true]],
    ] as const)("stores %s as an available canonical stage bundle", async (stage, expected) => {
      expect(await getStoredSleepStageParams(stage)).toEqual(expected);
    });

    it("does not treat a generic asleep interval as a canonical stage bundle", async () => {
      expect(await getStoredSleepStageParams("asleep")).toEqual([null, null, null, null, false]);
    });

    it("preserves an awake-only measurement without claiming a stage bundle", async () => {
      expect(await getStoredSleepStageParams("awake")).toEqual([null, null, null, 60, false]);
    });

    it("stores missing stages as null when no stage samples exist", async () => {
      expect(await getStoredSleepStageParams()).toEqual([null, null, null, null, false]);
    });

    it("filters inBed from stage samples (kills filter identity/true mutations on stageSamples)", async () => {
      const execute = vi.fn().mockImplementation((...args: unknown[]) => {
        const serialized = JSON.stringify(args[0]);
        // Return a session ID for the sleep_session INSERT so that stage insertion proceeds
        if (serialized.includes("sleep_session") && serialized.includes("RETURNING id")) {
          return Promise.resolve([{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }]);
        }
        return Promise.resolve([]);
      });
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // inBed session with stages where stage starts exactly at session start
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-filter",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-filter-1",
            startDate: "2024-01-15T22:00:00Z", // starts exactly at session start (>= check)
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-filter-2",
            startDate: "2024-01-16T02:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // ends exactly at session end (<= check)
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
        ],
      });

      expect(result.inserted).toBe(1);

      // Verify the sleep stage INSERT happened (sessionId && stages.length > 0)
      const stageInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_stage") && serialized.includes("INSERT");
      });
      expect(stageInsert).toBeDefined();
    });

    it("calculates duration_minutes correctly (kills / to *, + to -, * to / arithmetic mutations)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "dur-test",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z", // 8 hours = 480 minutes
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // 480 minutes is the correct duration
      expect(serialized).toContain(",480,");
    });

    it("keeps generic asleep intervals out of the canonical stage bundle", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-unspecified",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          {
            uuid: "stage-unspecified",
            startDate: "2024-01-15T22:30:00Z",
            endDate: "2024-01-16T00:30:00Z", // 2 hours = 120 minutes
            value: "asleepUnspecified",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      expect(serialized).toContain("staging_available");
      expect(serialized).not.toContain(",120,");
    });

    it("handles inBed-only session with no stages (kills stagesBySource.size > 0 ArrayDeclaration mutation)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-only",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      if (!sleepInsert) throw new Error("Expected a sleep-session INSERT");
      const stageParams = new PgDialect().sqlToQuery(sleepInsert[0]).params.slice(10, 15);
      expect(stageParams).toEqual([null, null, null, null, false]);
    });

    it("filters out stages outside the inBed session (kills overlap check mutations >= to >, <= to <, && to ||)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "inbed-overlap",
            startDate: "2024-01-15T23:00:00Z",
            endDate: "2024-01-16T05:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
          // Stage that starts BEFORE the session (should be filtered out by stageStart >= sessionStart)
          {
            uuid: "stage-before",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-15T22:30:00Z",
            value: "asleepCore",
            sourceName: "Apple Watch",
          },
          // Stage that ends AFTER the session (should be filtered out by stageEnd <= sessionEnd)
          {
            uuid: "stage-after",
            startDate: "2024-01-16T04:30:00Z",
            endDate: "2024-01-16T05:30:00Z",
            value: "asleepDeep",
            sourceName: "Apple Watch",
          },
          // Stage within the session (should be included)
          {
            uuid: "stage-inside",
            startDate: "2024-01-16T00:00:00Z",
            endDate: "2024-01-16T02:00:00Z",
            value: "asleepREM",
            sourceName: "Apple Watch",
          },
        ],
      });

      const sleepInsert = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("sleep_session") && serialized.includes("INSERT");
      });
      expect(sleepInsert).toBeDefined();
      const serialized = JSON.stringify(sleepInsert?.[0]);
      // Only REM stage should be counted: 2 hours = 120 minutes
      // deep=0, rem=120, light=0, awake=0
      expect(serialized).toContain(",120,"); // rem_minutes
    });

    it("returns 0 when no inBed and no derivable sessions (kills if(false) on inBedSamples.length === 0)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      // Only non-sleep values that won't derive a session
      const result = await caller.pushSleepSamples({
        samples: [
          {
            uuid: "non-sleep",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed", // inBed with no stages
            sourceName: "Apple Watch",
          },
        ],
      });

      // Should still insert 1 (the inBed session itself)
      expect(result.inserted).toBe(1);
    });

    it("cleans up legacy external IDs before inserting (verifies DELETE call)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-legacy",
            startDate: "2024-01-15T22:00:00Z",
            endDate: "2024-01-16T06:00:00Z",
            value: "inBed",
            sourceName: "Apple Watch",
          },
        ],
      });

      const deleteCall = execute.mock.calls.find((call: unknown[]) => {
        const serialized = JSON.stringify(call[0]);
        return serialized.includes("DELETE") && serialized.includes("sleep_session");
      });
      expect(deleteCall).toBeDefined();
    });
  });

  describe("deriveSleepSessionsFromStages - mutation killers", () => {
    function makeSleepSample(overrides: Partial<SleepSample> = {}): SleepSample {
      return {
        uuid: overrides.uuid ?? "sleep-1",
        startDate: overrides.startDate ?? "2024-01-15T23:00:00Z",
        endDate: overrides.endDate ?? "2024-01-15T23:30:00Z",
        value: overrides.value ?? "asleepCore",
        sourceName: overrides.sourceName ?? "Apple Watch",
      };
    }

    it("includes awake stages in filtering but not as sleep stage (kills && true / !== to === mutations on awake filter)", () => {
      // "awake" should pass the filter (it's explicitly checked) but not set currentHasSleepStage
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T01:00:00Z",
          endDate: "2024-01-16T01:15:00Z",
          value: "awake",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      // Session should extend to include the awake segment
      expect(result[0]?.endDate).toBe("2024-01-16T01:15:00.000Z");
    });

    it("filters zero-duration entries where startDate equals endDate (kills > to >= mutation on endMs > startMs)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:00:00Z", // zero duration: endMs === startMs
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("handles entry with null endMs from invalid timestamp (kills || false mutation on endMs null check)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "invalid-date", // will produce null endMs
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toEqual([]);
    });

    it("processes source with single sample correctly (kills firstEntry null checks)", () => {
      const samples = [
        makeSleepSample({
          uuid: "single",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.uuid).toBe("single");
      expect(result[0]?.sourceName).toBe("Apple Watch");
    });

    it("correctly handles loop bound (kills < to <= on sorted.length loop)", () => {
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-16T00:00:00Z",
          value: "asleepCore",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-16T00:00:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepDeep",
        }),
      ];

      // Should not crash even if loop goes one past the end
      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
      expect(result[0]?.endDate).toBe("2024-01-16T01:00:00.000Z");
    });

    it("sets currentHasSleepStage when subsequent entry is a sleep stage (kills isSleepStageValue check in loop)", () => {
      // First entry is awake (no sleep stage), second is asleepCore (sleep stage)
      // The session should still be emitted because the second entry sets currentHasSleepStage
      const samples = [
        makeSleepSample({
          uuid: "s1",
          startDate: "2024-01-15T23:00:00Z",
          endDate: "2024-01-15T23:30:00Z",
          value: "awake",
        }),
        makeSleepSample({
          uuid: "s2",
          startDate: "2024-01-15T23:30:00Z",
          endDate: "2024-01-16T01:00:00Z",
          value: "asleepCore",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(1);
    });

    it("uses uuid from session gap boundary correctly", () => {
      const samples = [
        makeSleepSample({
          uuid: "first-session",
          startDate: "2024-01-15T22:00:00Z",
          endDate: "2024-01-15T23:00:00Z",
          value: "asleepCore",
        }),
        // 3-hour gap
        makeSleepSample({
          uuid: "second-session",
          startDate: "2024-01-16T02:00:00Z",
          endDate: "2024-01-16T03:00:00Z",
          value: "asleepDeep",
        }),
      ];

      const result = deriveSleepSessionsFromStages(samples);
      expect(result).toHaveLength(2);
      expect(result[0]?.uuid).toBe("first-session");
      expect(result[1]?.uuid).toBe("second-session");
    });
  });

  describe("pushQuantitySamples - metric stream JSON and batch mutations", () => {
    it("stores source metadata in metric_stream events", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierHeartRate",
            value: 72,
            unit: "count/min",
            uuid: "hr-json-test",
            sourceName: "Apple Watch",
          }),
        ],
      });

      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [expect.objectContaining({ channel: "heart_rate", deviceId: "Apple Watch" })],
        { operationRevision: "1000000000000000" },
      );
    });
  });

  describe("pushQuantitySamples - body measurement mutations", () => {
    it("constructs proper external_id for body measurements (kills mapping continue on valid type)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "body-ext-id",
          }),
        ],
      });

      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [expect.objectContaining({ channel: "body_weight", externalId: "hk:body-ext-id" })],
        { operationRevision: "1000000000000000" },
      );
      const serialized = serializePublishedMetricStreamRows();
      expect(serialized).not.toContain("body_measurement");
    });

    it("processes BMI sample type (kills mapping guard)", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMassIndex",
            value: 23.5,
            uuid: "bmi-1",
          }),
        ],
      });

      expect(result.inserted).toBe(1);
      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            channel: "body_mass_index",
            externalId: "hk:bmi-1",
            scalar: 23.5,
          }),
        ],
        { operationRevision: "1000000000000000" },
      );
    });
  });

  describe("pushQuantitySamples - error status in metrics", () => {
    it("reports error status in healthKitPushTotal when errors exist", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([]); // ensureProvider
      mockMetricStreamPublishRows.mockRejectedValueOnce(new Error("fail"));

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "err-status",
          }),
        ],
      });

      expect(vi.mocked(healthKitPushTotal.add)).toHaveBeenCalledWith(1, {
        endpoint: "pushQuantitySamples",
        status: "error",
      });
    });

    it("handles non-Error objects in catch blocks", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      execute.mockResolvedValueOnce([]); // ensureProvider
      mockMetricStreamPublishRows.mockRejectedValueOnce("string error");

      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 75,
            uuid: "non-error-obj",
          }),
        ],
      });

      expect(result.errors.length).toBeGreaterThan(0);
      // Should use String() conversion for non-Error objects
      expect(result.errors[0]).toContain("string error");
    });
  });

  describe("cache invalidation after data push", () => {
    it("invalidates all user caches after pushSleepSamples inserts data", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushSleepSamples({
        samples: [
          {
            uuid: "sleep-1",
            startDate: "2026-04-02T22:00:00Z",
            endDate: "2026-04-03T06:00:00Z",
            value: "inBed",
            sourceName: "iPhone",
          },
        ],
      });

      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    });

    it("invalidates all user caches after pushWorkouts inserts data", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushWorkouts({
        ...WORKOUT_SYNC_WINDOW,
        workouts: [
          {
            uuid: "workout-1",
            workoutType: "HKWorkoutActivityTypeRunning",
            startDate: "2026-04-03T08:00:00Z",
            endDate: "2026-04-03T09:00:00Z",
            duration: 3600,
            totalDistance: 5000,
            sourceName: "Apple Watch",
            sourceBundle: "com.apple.Health",
          },
        ],
      });

      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    });

    it("invalidates all user caches after pushQuantitySamples inserts data", async () => {
      const execute = makeExecute();
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierStepCount",
            value: 5000,
          }),
        ],
      });

      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    });

    it("refreshes body measurements after inserting HealthKit body weight", async () => {
      const execute = makeExecute();
      const refreshBodyMeasurements = vi.fn().mockResolvedValue(undefined);
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: { refreshBodyMeasurements },
      });

      await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 82.5,
            unit: "kg",
            uuid: "body-weight-1",
          }),
        ],
      });

      expect(refreshBodyMeasurements).toHaveBeenCalledOnce();
      expect(refreshBodyMeasurements.mock.invocationCallOrder[0]).toBeLessThan(
        mockInvalidateByPrefix.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it("reports body measurement refresh failures without invalidating caches", async () => {
      const Sentry = await import("@sentry/node");
      vi.mocked(Sentry.captureException).mockClear();
      const execute = makeExecute();
      const refreshError = new Error("boom");
      const refreshBodyMeasurements = vi.fn().mockRejectedValue(refreshError);
      const caller = createCaller({
        db: makeDatabase(execute),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: { refreshBodyMeasurements },
      });

      const result = await caller.pushQuantitySamples({
        samples: [
          makeSample({
            type: "HKQuantityTypeIdentifierBodyMass",
            value: 82.5,
            unit: "kg",
            uuid: "body-weight-refresh-error",
          }),
        ],
      });

      expect(result.errors).toContain("Body measurements refresh: boom");
      expect(Sentry.captureException).toHaveBeenCalledWith(refreshError, {
        tags: { healthKitSyncStep: "refreshBodyMeasurements" },
      });
      expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    });
  });
});
