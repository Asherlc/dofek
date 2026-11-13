import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportJobData } from "./queues.ts";

const {
  mockQueueGetJob,
  mockQueueAdd,
  mockQueueClose,
  MockQueue,
  mockFlowProducerClose,
  MockFlowProducer,
  mockQueueEventsClose,
  MockQueueEvents,
  MockRedisConnection,
} = vi.hoisted(() => {
  const mockQueueGetJob = vi.fn();
  const mockQueueAdd = vi.fn();
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueInstance = {
    name: "mock-queue",
    add: mockQueueAdd,
    getJob: mockQueueGetJob,
    close: mockQueueClose,
  };
  const MockQueue = vi.fn(function vitestConstructor() {
    return mockQueueInstance;
  });
  const mockFlowProducerClose = vi.fn().mockResolvedValue(undefined);
  const mockFlowProducerInstance = { name: "mock-flow-producer", close: mockFlowProducerClose };
  const MockFlowProducer = vi.fn(function vitestConstructor() {
    return mockFlowProducerInstance;
  });
  const mockQueueEventsClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueEventsInstance = { name: "mock-queue-events", close: mockQueueEventsClose };
  const MockQueueEvents = vi.fn(function vitestConstructor() {
    return mockQueueEventsInstance;
  });
  const MockRedisConnection = vi.fn(function vitestConstructor() {
    return { close: vi.fn().mockResolvedValue(undefined) };
  });
  return {
    mockQueueGetJob,
    mockQueueAdd,
    mockQueueClose,
    MockQueue,
    mockFlowProducerClose,
    MockFlowProducer,
    mockQueueEventsClose,
    MockQueueEvents,
    MockRedisConnection,
  };
});

vi.mock("bullmq", () => ({
  FlowProducer: MockFlowProducer,
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
  RedisConnection: MockRedisConnection,
}));

import {
  ANALYTICS_REFRESH_QUEUE,
  closeAllQueueResources,
  createProviderDataDeletionQueue,
  enqueueDataExport,
  enqueueProviderDataDeletion,
  enqueueProviderDataDeletionContinuation,
  getAnalyticsRefreshQueue,
  getAnalyticsRefreshQueueEvents,
  PROVIDER_DATA_DELETION_QUEUE,
  providerDataDeletionJobDataSchema,
} from "./queues.ts";

const catalogueSeed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "kaya",
  externalId: "1",
  sourceUrl: null,
  name: "Crack",
  kind: "route",
  setting: "outdoor",
  locations: [],
};

describe("queues", () => {
  it("queues one disposable catalogue refresh per user and log", async () => {
    const { enqueueClimbingCatalogueRefresh } = await import("./queues.ts");
    await enqueueClimbingCatalogueRefresh(catalogueSeed);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "climbing-catalogue",
      { type: "climbing-catalogue", userId: "user-a", logEntryId: "log-a", seed: catalogueSeed },
      expect.objectContaining({
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        jobId: "climbing-catalogue-user-a-log-a",
      }),
    );
  });
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "projects %s jobs as pending",
    async (state) => {
      const { getClimbingCatalogueRefreshState } = await import("./queues.ts");
      mockQueueGetJob.mockResolvedValue({ getState: async () => state });
      expect(await getClimbingCatalogueRefreshState("user-a", "log-a")).toBe("pending");
      expect(mockQueueGetJob).toHaveBeenCalledWith("climbing-catalogue-user-a-log-a");
    },
  );
  it.each(["completed", "failed", "unknown", null])(
    "does not leave pending after job state %s",
    async (state) => {
      const { getClimbingCatalogueRefreshState } = await import("./queues.ts");
      mockQueueGetJob.mockResolvedValue(
        state === null ? undefined : { getState: async () => state },
      );
      expect(await getClimbingCatalogueRefreshState("user-a", "log-a")).toBeNull();
    },
  );
  it("rejects job snapshots attributed to a different user or log", async () => {
    const { climbingCatalogueJobDataSchema } = await import("./queues.ts");
    expect(
      climbingCatalogueJobDataSchema.safeParse({
        type: "climbing-catalogue",
        userId: "other",
        logEntryId: "log-a",
        seed: catalogueSeed,
      }).success,
    ).toBe(false);
    expect(
      climbingCatalogueJobDataSchema.safeParse({
        type: "climbing-catalogue",
        userId: "user-a",
        logEntryId: "other",
        seed: catalogueSeed,
      }).success,
    ).toBe(false);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
    mockQueueAdd.mockResolvedValue(undefined);
    mockQueueClose.mockResolvedValue(undefined);
    mockFlowProducerClose.mockResolvedValue(undefined);
    mockQueueEventsClose.mockResolvedValue(undefined);
  });

  describe("constants", () => {
    it("exports correct queue names", async () => {
      const {
        ACTIVITY_DELETE_ANALYTICS_QUEUE,
        EXPORT_QUEUE,
        FIT_FILE_IMPORT_BATCH_QUEUE,
        FIT_FILE_IMPORT_QUEUE,
        IMPORT_QUEUE,
        POST_SYNC_QUEUE,
        PROVIDER_DATA_DELETION_QUEUE,
        SCHEDULED_SYNC_QUEUE,
        SYNC_QUEUE,
        ZIP_ENTRY_EXTRACT_QUEUE,
      } = await import("./queues.ts");
      expect(SYNC_QUEUE).toBe("sync");
      expect(IMPORT_QUEUE).toBe("import");
      expect(FIT_FILE_IMPORT_QUEUE).toBe("fit-file-import");
      expect(FIT_FILE_IMPORT_BATCH_QUEUE).toBe("fit-file-import-batch");
      expect(ZIP_ENTRY_EXTRACT_QUEUE).toBe("zip-entry-extract");
      expect(EXPORT_QUEUE).toBe("export");
      expect(SCHEDULED_SYNC_QUEUE).toBe("scheduled-sync");
      expect(POST_SYNC_QUEUE).toBe("post-sync");
      expect(PROVIDER_DATA_DELETION_QUEUE).toBe("provider-data-deletion");
      expect(ACTIVITY_DELETE_ANALYTICS_QUEUE).toBe("activity-delete-analytics");
    });
  });

  describe("fitFileImportJobResultSchema", () => {
    it("requires the result fields and error messages", async () => {
      const { fitFileImportJobResultSchema } = await import("./queues.ts");

      expect(fitFileImportJobResultSchema.safeParse({}).success).toBe(false);
      expect(
        fitFileImportJobResultSchema.safeParse({ recordsSynced: 1, errors: [{}] }).success,
      ).toBe(false);
    });
  });

  describe("fitFileImportActivitySummarySchema", () => {
    it("accepts the complete canonical activity summary", async () => {
      const { fitFileImportActivitySummarySchema } = await import("./queues.ts");

      expect(
        fitFileImportActivitySummarySchema.safeParse({
          externalId: "activity-1",
          activityType: {
            canonicalType: "cycling",
            providerType: "cycling",
            modality: null,
          },
          startedAtIso: "2026-01-01T00:00:00.000Z",
          name: "Ride",
        }).success,
      ).toBe(true);
    });

    it("requires the canonical activity type fields", async () => {
      const { fitFileImportActivitySummarySchema } = await import("./queues.ts");

      expect(
        fitFileImportActivitySummarySchema.safeParse({
          externalId: "activity-1",
          activityType: {},
          startedAtIso: "2026-01-01T00:00:00.000Z",
          name: "Ride",
        }).success,
      ).toBe(false);
    });
  });

  describe("providerDataDeletionJobDataSchema", () => {
    it("validates the complete resumable deletion payload", () => {
      const payload = {
        type: "provider-data-deletion",
        eventId: "10000000-0000-4000-8000-000000000001",
        generation: 2,
        providerId: "garmin",
        userId: "20000000-0000-4000-8000-000000000002",
        checkpoint: {
          batches: 3,
          deletedRows: 30_000,
          lastGeneration: 1,
          lastId: "30000000-0000-4000-8000-000000000003",
        },
      };

      expect(providerDataDeletionJobDataSchema.parse(payload)).toEqual(payload);
      expect(
        providerDataDeletionJobDataSchema.parse({
          ...payload,
          checkpoint: { ...payload.checkpoint, lastGeneration: undefined },
        }).checkpoint?.lastGeneration,
      ).toBe(0);
      expect(
        providerDataDeletionJobDataSchema.safeParse({
          ...payload,
          checkpoint: { ...payload.checkpoint, deletedRows: -1 },
        }).success,
      ).toBe(false);
      expect(providerDataDeletionJobDataSchema.safeParse({}).success).toBe(false);
      expect(
        providerDataDeletionJobDataSchema.safeParse({ ...payload, providerId: "" }).success,
      ).toBe(false);
      expect(
        providerDataDeletionJobDataSchema.safeParse({ ...payload, checkpoint: {} }).success,
      ).toBe(false);
    });
  });

  describe("getRedisConnection", () => {
    it.each([
      {
        label: "parses a password",
        url: "redis://:secret@myredis.host:6380",
        expected: { host: "myredis.host", port: 6380, password: "secret" },
      },
      {
        label: "defaults to localhost:6379",
        url: undefined,
        expected: { host: "localhost", port: 6379, password: undefined },
      },
      {
        label: "handles a URL without a password",
        url: "redis://redis-host:6379",
        expected: { host: "redis-host", port: 6379, password: undefined },
      },
      {
        label: "defaults the port to 6379",
        url: "redis://localhost",
        expected: { host: "localhost", port: 6379 },
      },
    ])("$label", async ({ url, expected }) => {
      if (url === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = url;
      const { getRedisConnection } = await import("./queues.ts");

      expect(getRedisConnection()).toEqual({
        ...expected,
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
        lazyConnect: true,
      });
    });
  });

  describe("queue factories", () => {
    const queueForFactory = {
      createSyncQueue: "SYNC_QUEUE",
      createImportQueue: "IMPORT_QUEUE",
      createFitFileImportQueue: "FIT_FILE_IMPORT_QUEUE",
      createFitFileImportBatchQueue: "FIT_FILE_IMPORT_BATCH_QUEUE",
      createZipEntryExtractQueue: "ZIP_ENTRY_EXTRACT_QUEUE",
      createExportQueue: "EXPORT_QUEUE",
      createScheduledSyncQueue: "SCHEDULED_SYNC_QUEUE",
      createPostSyncQueue: "POST_SYNC_QUEUE",
      createActivityDeleteAnalyticsQueue: "ACTIVITY_DELETE_ANALYTICS_QUEUE",
    } as const;

    it.each([
      ["createSyncQueue", 1234],
      ["createSyncQueue", undefined],
      ["createImportQueue", 5678],
      ["createImportQueue", undefined],
      ["createFitFileImportQueue", 2468],
      ["createFitFileImportBatchQueue", 8642],
      ["createZipEntryExtractQueue", 9753],
      ["createExportQueue", 1111],
      ["createExportQueue", undefined],
      ["createScheduledSyncQueue", 2222],
      ["createPostSyncQueue", 9999],
      ["createActivityDeleteAnalyticsQueue", 9999],
      ["createActivityDeleteAnalyticsQueue", undefined],
    ] as const)("%s uses its queue and connection options", async (factory, port) => {
      if (port === undefined) process.env.REDIS_URL = "redis://localhost:6379";
      const queues = await import("./queues.ts");
      const connection = port === undefined ? undefined : { host: "test", port };

      queues[factory](connection);

      expect(MockQueue).toHaveBeenCalledWith(queues[queueForFactory[factory]], {
        connection: connection ?? expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("zipEntryExtractJobDataSchema", () => {
    it("accepts nested alphanumeric output extensions", async () => {
      const { zipEntryExtractJobDataSchema } = await import("./queues.ts");

      expect(
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: ["DI_CONNECT/files.zip", "activity.fit"],
          outputExtension: "fit2",
          maxBytes: 1024,
          nestedArchiveMaxBytes: 2048,
          userId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toEqual({
        archivePath: "/tmp/export.zip",
        entryPath: ["DI_CONNECT/files.zip", "activity.fit"],
        outputExtension: "fit2",
        maxBytes: 1024,
        nestedArchiveMaxBytes: 2048,
        userId: "00000000-0000-4000-8000-000000000001",
      });
    });

    it("rejects empty entry paths and non-alphanumeric output extensions", async () => {
      const { zipEntryExtractJobDataSchema } = await import("./queues.ts");

      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: [],
          outputExtension: "fit",
          userId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow();
      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: ["activity.fit"],
          outputExtension: "fit.gz",
          userId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow();
      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: ["activity.fit"],
          outputExtension: ".fit",
          userId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow();
    });
  });

  describe("ImportJobData", () => {
    it("allows kaya-export as an import job type", () => {
      const jobData = {
        uploadId: "00000000-0000-4000-8000-0000000000f3",
        userId: "user-1",
        importType: "kaya-export",
      } satisfies ImportJobData;

      expect(jobData.importType).toBe("kaya-export");
    });
  });

  describe("cached queue support resources", () => {
    it("reuses queue-events and flow-producer instances", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { FIT_FILE_IMPORT_QUEUE, getFitFileImportQueueEvents, getFlowProducer } = await import(
        "./queues.ts"
      );

      const queueEvents = getFitFileImportQueueEvents();
      expect(getFitFileImportQueueEvents()).toBe(queueEvents);
      expect(MockQueueEvents).toHaveBeenCalledTimes(1);
      expect(MockQueueEvents).toHaveBeenCalledWith(FIT_FILE_IMPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
      const flowProducer = getFlowProducer();
      expect(getFlowProducer()).toBe(flowProducer);
      expect(MockFlowProducer).toHaveBeenCalledTimes(1);
      expect(MockFlowProducer).toHaveBeenCalledWith({
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("providerSyncQueueName", () => {
    it("returns sync-{providerId} format", async () => {
      const { providerSyncQueueName } = await import("./queues.ts");
      expect(providerSyncQueueName("strava")).toBe("sync-strava");
      expect(providerSyncQueueName("garmin")).toBe("sync-garmin");
    });
  });

  describe("getSharedRedisConnection", () => {
    it("bounds shared Redis commands and reuses the connection", async () => {
      const { getSharedRedisConnection } = await import("./queues.ts");
      await closeAllQueueResources();
      const first = getSharedRedisConnection();
      expect(getSharedRedisConnection()).toBe(first);
      expect(MockRedisConnection).toHaveBeenCalledTimes(1);
      expect(MockRedisConnection).toHaveBeenCalledWith(
        expect.objectContaining({ commandTimeout: 5000 }),
        { blocking: false, skipVersionCheck: true },
      );
      await closeAllQueueResources();
    });
  });

  describe("cached queue shutdown", () => {
    it.each([
      {
        getter: "getImportQueue",
        queue: "IMPORT_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getFitFileImportQueue",
        queue: "FIT_FILE_IMPORT_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getPostSyncQueue",
        queue: "POST_SYNC_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getActivityDeleteAnalyticsQueue",
        queue: "ACTIVITY_DELETE_ANALYTICS_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getSyncQueue",
        queue: "SYNC_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getDataExportQueue",
        queue: "EXPORT_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getProviderDataDeletionQueue",
        queue: "PROVIDER_DATA_DELETION_QUEUE",
        expectedConnection: { host: "localhost", port: 6379 },
      },
      {
        getter: "getActivityImageQueue",
        queue: "ACTIVITY_IMAGE_QUEUE",
        expectedConnection: { host: "localhost", port: 6379, commandTimeout: 5000 },
      },
    ] as const)(
      "$getter closes and recreates its cached queue",
      async ({ getter, queue, expectedConnection }) => {
        await closeAllQueueResources();
        vi.clearAllMocks();
        const queues = await import("./queues.ts");
        const first = queues[getter]();

        expect(queues[getter]()).toBe(first);
        expect(MockQueue).toHaveBeenCalledOnce();
        expect(MockQueue).toHaveBeenCalledWith(queues[queue], {
          connection: expect.objectContaining(expectedConnection),
        });
        await closeAllQueueResources();
        expect(mockQueueClose).toHaveBeenCalledOnce();
        await closeAllQueueResources();
        expect(mockQueueClose).toHaveBeenCalledOnce();
        queues[getter]();
        expect(MockQueue).toHaveBeenCalledTimes(2);
      },
    );
  });

  describe("createProviderSyncQueue", () => {
    it.each([
      {
        providerId: "strava",
        connection: { host: "test", port: 1234 },
        expected: { host: "test", port: 1234 },
      },
      {
        providerId: "garmin",
        url: "redis://localhost:6379",
        expected: { host: "localhost", port: 6379, commandTimeout: 5000 },
      },
    ])("creates the $providerId queue with expected connection options", async (testCase) => {
      if ("url" in testCase) process.env.REDIS_URL = testCase.url;
      const { createProviderSyncQueue } = await import("./queues.ts");

      createProviderSyncQueue(
        testCase.providerId,
        "connection" in testCase ? testCase.connection : undefined,
      );

      expect(MockQueue).toHaveBeenCalledWith(`sync-${testCase.providerId}`, {
        connection:
          "connection" in testCase
            ? testCase.connection
            : expect.objectContaining(testCase.expected),
      });
    });
  });

  describe("getProviderSyncQueue", () => {
    it.each([
      { providers: ["strava", "strava"], queueCount: 1 },
      { providers: ["garmin", "wahoo"], queueCount: 2 },
    ])("caches queues for providers: $providers", async ({ providers, queueCount }) => {
      const { getProviderSyncQueue } = await import("./queues.ts");
      const queues = providers.map(getProviderSyncQueue);

      if (providers[0] === providers[1]) expect(queues[0]).toBe(queues[1]);
      expect(MockQueue).toHaveBeenCalledTimes(queueCount);
      providers.forEach((providerId) => {
        expect(MockQueue).toHaveBeenCalledWith(`sync-${providerId}`, {
          connection: expect.objectContaining({ host: "localhost", port: 6379 }),
        });
      });
    });
  });

  describe("createExportQueue", () => {
    it("uses the export id as the BullMQ idempotency key", async () => {
      const { createExportQueue } = await import("./queues.ts");
      const queue = createExportQueue({ host: "test", port: 1111 });

      await enqueueDataExport(
        {
          exportId: "10000000-0000-4000-8000-000000000025",
          userId: "20000000-0000-4000-8000-000000000025",
        },
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "export",
        {
          exportId: "10000000-0000-4000-8000-000000000025",
          userId: "20000000-0000-4000-8000-000000000025",
        },
        {
          jobId: "10000000-0000-4000-8000-000000000025",
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });
  });

  describe("enqueueDebouncedPostSyncMaintenance", () => {
    it("adds one delayed deduplicated global maintenance job", async () => {
      const { enqueueDebouncedPostSyncMaintenance, POST_SYNC_DEBOUNCE_MS, createPostSyncQueue } =
        await import("./queues.ts");

      const queue = createPostSyncQueue({ host: "test", port: 9999 });
      await enqueueDebouncedPostSyncMaintenance(queue);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "global-maintenance",
        { type: "global-maintenance" },
        {
          attempts: 288,
          backoff: { type: "fixed", delay: 300_000 },
          delay: POST_SYNC_DEBOUNCE_MS,
          deduplication: {
            id: "post-sync:global-maintenance",
            ttl: POST_SYNC_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 1_000 },
        },
      );
    });
  });

  describe("enqueueDebouncedUserRefit", () => {
    it("adds one delayed deduplicated per-user refit job", async () => {
      const { enqueueDebouncedUserRefit, POST_SYNC_DEBOUNCE_MS, createPostSyncQueue } =
        await import("./queues.ts");

      const queue = createPostSyncQueue({ host: "test", port: 9999 });
      await enqueueDebouncedUserRefit("user-123", queue);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "user-refit",
        { type: "user-refit", userId: "user-123" },
        {
          attempts: 288,
          backoff: { type: "fixed", delay: 300_000 },
          delay: POST_SYNC_DEBOUNCE_MS,
          deduplication: {
            id: "post-sync:user-refit:user-123",
            ttl: POST_SYNC_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 1_000 },
        },
      );
    });
  });

  describe("enqueueActivityDeleteAnalyticsRefresh", () => {
    it("adds an activity delete analytics refresh job with retries", async () => {
      const { enqueueActivityDeleteAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityDeleteAnalyticsRefresh(
        "user-123",
        ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000001"],
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "activity-delete-analytics-refresh",
        {
          type: "activity-delete-analytics-refresh",
          userId: "user-123",
          activityIds: ["00000000-0000-0000-0000-000000000001"],
        },
        {
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 100 },
          attempts: 5,
          backoff: { type: "fixed", delay: 30_000 },
        },
      );
    });
  });

  describe("enqueueProviderDeleteAnalyticsRefresh", () => {
    it("queues a provider-scoped ClickHouse refresh even when the provider has no activities", async () => {
      const { enqueueProviderDeleteAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");
      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });

      await enqueueProviderDeleteAnalyticsRefresh(
        "user-123",
        "strava",
        "30000000-0000-4000-8000-000000000001",
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "provider-delete-analytics-refresh",
        {
          type: "provider-delete-analytics-refresh",
          userId: "user-123",
          providerId: "strava",
          deletionEventId: "30000000-0000-4000-8000-000000000001",
        },
        {
          jobId: "provider-delete-analytics-refresh-30000000-0000-4000-8000-000000000001",
          removeOnComplete: { age: 604_800, count: 1_000 },
          removeOnFail: { age: 604_800, count: 100 },
          attempts: 5,
          backoff: { type: "fixed", delay: 30_000 },
        },
      );
    });
  });

  describe("activity analytics refreshes without activity ids", () => {
    it.each([
      "enqueueActivityDeleteAnalyticsRefresh",
      "enqueueActivityRestoreAnalyticsRefresh",
      "enqueueActivityRecomputeAnalyticsRefresh",
    ] as const)("%s does not enqueue a job", async (enqueue) => {
      const queues = await import("./queues.ts");
      const queue = queues.createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });

      await queues[enqueue]("user-123", [], queue);

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  describe("enqueueProviderDataDeletion", () => {
    it("uses the outbox event id as the BullMQ idempotency key", async () => {
      const connection = { host: "test", port: 9999 };
      const queue = createProviderDataDeletionQueue(connection);

      expect(MockQueue).toHaveBeenCalledWith(PROVIDER_DATA_DELETION_QUEUE, { connection });

      await enqueueProviderDataDeletion(
        {
          eventId: "30000000-0000-4000-8000-000000000001",
          generation: 2,
          providerId: "strava",
          userId: "user-123",
        },
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "provider-data-deletion",
        {
          type: "provider-data-deletion",
          eventId: "30000000-0000-4000-8000-000000000001",
          generation: 2,
          providerId: "strava",
          userId: "user-123",
        },
        {
          attempts: 20,
          backoff: { type: "fixed", delay: 30_000 },
          jobId: "30000000-0000-4000-8000-000000000001",
          removeOnComplete: { age: 604_800, count: 1_000 },
          removeOnFail: { age: 2_592_000, count: 1_000 },
        },
      );
    });

    it("uses the event and batch as the continuation idempotency key", async () => {
      const queue = createProviderDataDeletionQueue({ host: "test", port: 9999 });
      const data = {
        type: "provider-data-deletion" as const,
        eventId: "30000000-0000-4000-8000-000000000001",
        generation: 2,
        providerId: "strava",
        userId: "10000000-0000-4000-8000-000000000001",
        checkpoint: {
          batches: 3,
          deletedRows: 2_500,
          examinedRows: 3_000,
          lastGeneration: 1,
          lastId: "20000000-0000-4000-8000-000000000001",
        },
      };

      await enqueueProviderDataDeletionContinuation(data, queue);

      expect(mockQueueAdd).toHaveBeenCalledWith("provider-data-deletion", data, {
        attempts: 20,
        backoff: { type: "fixed", delay: 30_000 },
        jobId: "30000000-0000-4000-8000-000000000001-batch-3",
        removeOnComplete: { age: 604_800, count: 1_000 },
        removeOnFail: { age: 2_592_000, count: 1_000 },
      });
    });
  });

  describe("enqueueActivityRestoreAnalyticsRefresh", () => {
    it("adds an activity restore analytics refresh job with retries", async () => {
      const { enqueueActivityRestoreAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      mockQueueAdd.mockResolvedValueOnce({ id: "restore-job-1" });
      const jobId = await enqueueActivityRestoreAnalyticsRefresh(
        "user-123",
        ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000002"],
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "activity-restore-analytics-refresh",
        {
          type: "activity-restore-analytics-refresh",
          userId: "user-123",
          activityIds: ["00000000-0000-0000-0000-000000000002"],
        },
        {
          removeOnComplete: { age: 604_800, count: 1_000 },
          removeOnFail: { age: 604_800, count: 100 },
          attempts: 5,
          backoff: { type: "fixed", delay: 30_000 },
        },
      );
      expect(jobId).toBe("restore-job-1");
    });
  });

  describe("enqueueActivityRecomputeAnalyticsRefresh", () => {
    it("adds an activity recompute analytics refresh job with an activity-scoped BullMQ-safe custom id", async () => {
      const { enqueueActivityRecomputeAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityRecomputeAnalyticsRefresh(
        "user-123",
        ["00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000003"],
        queue,
      );

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "activity-recompute-analytics-refresh",
        {
          type: "activity-recompute-analytics-refresh",
          userId: "user-123",
          activityIds: ["00000000-0000-0000-0000-000000000003"],
        },
        {
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 100 },
          attempts: 5,
          backoff: { type: "fixed", delay: 30_000 },
          jobId: "activity-recompute-analytics-refresh-user-123-c67f2fc391b67892",
        },
      );
    });

    it("uses different job ids for different recompute activity sets from the same user", async () => {
      const { enqueueActivityRecomputeAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityRecomputeAnalyticsRefresh(
        "user-123",
        ["00000000-0000-0000-0000-000000000003"],
        queue,
      );
      await enqueueActivityRecomputeAnalyticsRefresh(
        "user-123",
        ["00000000-0000-0000-0000-000000000004"],
        queue,
      );

      const firstCallOptions = mockQueueAdd.mock.calls[0]?.[2];
      const secondCallOptions = mockQueueAdd.mock.calls[1]?.[2];
      expect(firstCallOptions?.jobId).toMatch(
        /^activity-recompute-analytics-refresh-user-123-[a-f0-9]+$/,
      );
      expect(secondCallOptions?.jobId).toMatch(
        /^activity-recompute-analytics-refresh-user-123-[a-f0-9]+$/,
      );
      expect(firstCallOptions?.jobId).not.toBe(secondCallOptions?.jobId);
    });
  });

  describe("activity image queues", () => {
    it("uses an explicit connection for a standalone queue and the shared connection by default", async () => {
      const { createActivityImageQueue, getRedisCommandConnection } = await import("./queues.ts");
      const connection = { host: "image-redis.test", port: 6380 };
      createActivityImageQueue(connection);
      expect(MockQueue).toHaveBeenLastCalledWith("activity-images", { connection });
      createActivityImageQueue();
      expect(MockQueue).toHaveBeenLastCalledWith("activity-images", {
        connection: getRedisCommandConnection(),
      });
      await closeAllQueueResources();
    });
  });

  describe("closeAllQueueResources", () => {
    it("closes all cached queues and flow producers", async () => {
      const {
        closeAllQueueResources,
        getFitFileImportQueue,
        getFitFileImportQueueEvents,
        getFlowProducer,
      } = await import("./queues.ts");

      getFitFileImportQueue();
      getFitFileImportQueueEvents();
      getFlowProducer();

      await closeAllQueueResources();

      expect(mockQueueClose).toHaveBeenCalled();
      expect(mockQueueEventsClose).toHaveBeenCalled();
      expect(mockFlowProducerClose).toHaveBeenCalled();
    });

    it("is safe when no queue resources are cached", async () => {
      const { closeAllQueueResources } = await import("./queues.ts");
      await closeAllQueueResources();
      vi.clearAllMocks();

      await expect(closeAllQueueResources()).resolves.toBeUndefined();

      expect(mockQueueClose).not.toHaveBeenCalled();
      expect(mockQueueEventsClose).not.toHaveBeenCalled();
      expect(mockFlowProducerClose).not.toHaveBeenCalled();
    });
  });
});

describe("analytics refresh resource lifecycle", () => {
  it("retains dispatch handles while their asynchronous close is pending", async () => {
    await closeAllQueueResources();
    const queue = getAnalyticsRefreshQueue();
    const events = getAnalyticsRefreshQueueEvents();
    const queueCount = MockQueue.mock.calls.length;
    const eventCount = MockQueueEvents.mock.calls.length;
    let finish = () => {};
    mockQueueClose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const closing = closeAllQueueResources();
    expect(getAnalyticsRefreshQueue()).toBe(queue);
    expect(getAnalyticsRefreshQueueEvents()).toBe(events);
    expect(MockQueue).toHaveBeenCalledTimes(queueCount);
    expect(MockQueueEvents).toHaveBeenCalledTimes(eventCount);
    finish();
    await closing;
    getAnalyticsRefreshQueue();
    getAnalyticsRefreshQueueEvents();
    expect(MockQueue).toHaveBeenCalledTimes(queueCount + 1);
    expect(MockQueueEvents).toHaveBeenCalledTimes(eventCount + 1);
    await closeAllQueueResources();
  });

  it("cancels refresh waiters without recreating their signal before final teardown", async () => {
    const { closeAnalyticsRefreshWaiters, getAnalyticsRefreshWaitSignal } = await import(
      "./queues.ts"
    );
    await closeAllQueueResources();
    const signal = getAnalyticsRefreshWaitSignal();
    await closeAnalyticsRefreshWaiters();
    expect(signal.aborted).toBe(true);
    expect(getAnalyticsRefreshWaitSignal()).toBe(signal);
    await closeAllQueueResources();
    expect(getAnalyticsRefreshWaitSignal().aborted).toBe(false);
  });

  it("reuses dispatch resources and releases both connections during shutdown", async () => {
    await closeAllQueueResources();
    vi.clearAllMocks();
    expect(getAnalyticsRefreshQueue()).toBe(getAnalyticsRefreshQueue());
    expect(getAnalyticsRefreshQueueEvents()).toBe(getAnalyticsRefreshQueueEvents());
    expect(MockQueue).toHaveBeenCalledOnce();
    expect(MockQueueEvents).toHaveBeenCalledOnce();
    expect(MockQueue).toHaveBeenCalledWith(ANALYTICS_REFRESH_QUEUE, expect.any(Object));
    await closeAllQueueResources();
    expect(mockQueueClose).toHaveBeenCalledOnce();
    expect(mockQueueEventsClose).toHaveBeenCalledOnce();
    getAnalyticsRefreshQueue();
    getAnalyticsRefreshQueueEvents();
    expect(MockQueue).toHaveBeenCalledTimes(2);
    expect(MockQueueEvents).toHaveBeenCalledTimes(2);
    await closeAllQueueResources();
  });
});
