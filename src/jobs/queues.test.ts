import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportJobData } from "./queues.ts";

const {
  mockQueueAdd,
  mockQueueClose,
  MockQueue,
  mockFlowProducerClose,
  MockFlowProducer,
  mockQueueEventsClose,
  MockQueueEvents,
} = vi.hoisted(() => {
  const mockQueueAdd = vi.fn();
  const mockQueueClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueInstance = { name: "mock-queue", add: mockQueueAdd, close: mockQueueClose };
  const MockQueue = vi.fn(() => mockQueueInstance);
  const mockFlowProducerClose = vi.fn().mockResolvedValue(undefined);
  const mockFlowProducerInstance = { name: "mock-flow-producer", close: mockFlowProducerClose };
  const MockFlowProducer = vi.fn(() => mockFlowProducerInstance);
  const mockQueueEventsClose = vi.fn().mockResolvedValue(undefined);
  const mockQueueEventsInstance = { name: "mock-queue-events", close: mockQueueEventsClose };
  const MockQueueEvents = vi.fn(() => mockQueueEventsInstance);
  return {
    mockQueueAdd,
    mockQueueClose,
    MockQueue,
    mockFlowProducerClose,
    MockFlowProducer,
    mockQueueEventsClose,
    MockQueueEvents,
  };
});

vi.mock("bullmq", () => ({
  FlowProducer: MockFlowProducer,
  Queue: MockQueue,
  QueueEvents: MockQueueEvents,
}));

import {
  closeAllQueueResources,
  createProviderDataDeletionQueue,
  EXPORT_QUEUE,
  enqueueDataExport,
  enqueueProviderDataDeletion,
  enqueueProviderDataDeletionContinuation,
  getDataExportQueue,
  getProviderDataDeletionQueue,
  PROVIDER_DATA_DELETION_QUEUE,
  providerDataDeletionJobDataSchema,
} from "./queues.ts";

describe("queues", () => {
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
    it("parses REDIS_URL environment variable with password", async () => {
      process.env.REDIS_URL = "redis://:secret@myredis.host:6380";
      const { getRedisConnection } = await import("./queues.ts");

      const conn = getRedisConnection();

      expect(conn).toEqual({
        host: "myredis.host",
        port: 6380,
        password: "secret",
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
        lazyConnect: true,
      });
    });

    it("defaults to localhost:6379 when REDIS_URL is not set", async () => {
      delete process.env.REDIS_URL;
      const { getRedisConnection } = await import("./queues.ts");

      const conn = getRedisConnection();

      expect(conn).toEqual({
        host: "localhost",
        port: 6379,
        password: undefined,
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
        lazyConnect: true,
      });
    });

    it("handles REDIS_URL without password", async () => {
      process.env.REDIS_URL = "redis://redis-host:6379";
      const { getRedisConnection } = await import("./queues.ts");

      const conn = getRedisConnection();
      expect("host" in conn).toBe(true);
      if ("host" in conn) {
        expect(conn.host).toBe("redis-host");
        expect(conn.port).toBe(6379);
        expect(conn.password).toBeUndefined();
      }
    });

    it("defaults port to 6379 when not specified", async () => {
      process.env.REDIS_URL = "redis://localhost";
      const { getRedisConnection } = await import("./queues.ts");

      const conn = getRedisConnection();
      if ("port" in conn) {
        expect(conn.port).toBe(6379);
      }
    });
  });

  describe("createSyncQueue", () => {
    it("creates a Queue with the sync queue name", async () => {
      const { createSyncQueue, SYNC_QUEUE } = await import("./queues.ts");

      createSyncQueue({ host: "test", port: 1234 });

      expect(MockQueue).toHaveBeenCalledWith(SYNC_QUEUE, {
        connection: { host: "test", port: 1234 },
      });
    });

    it("uses default redis connection when none provided", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { createSyncQueue, SYNC_QUEUE } = await import("./queues.ts");

      createSyncQueue();

      expect(MockQueue).toHaveBeenCalledWith(SYNC_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("createImportQueue", () => {
    it("creates a Queue with the import queue name", async () => {
      const { createImportQueue, IMPORT_QUEUE } = await import("./queues.ts");

      createImportQueue({ host: "test", port: 5678 });

      expect(MockQueue).toHaveBeenCalledWith(IMPORT_QUEUE, {
        connection: { host: "test", port: 5678 },
      });
    });

    it("uses default redis connection when none provided", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { createImportQueue, IMPORT_QUEUE } = await import("./queues.ts");

      createImportQueue();

      expect(MockQueue).toHaveBeenCalledWith(IMPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("createFitFileImportQueue", () => {
    it("creates a Queue with the FIT file import queue name", async () => {
      const { createFitFileImportQueue, FIT_FILE_IMPORT_QUEUE } = await import("./queues.ts");

      createFitFileImportQueue({ host: "test", port: 2468 });

      expect(MockQueue).toHaveBeenCalledWith(FIT_FILE_IMPORT_QUEUE, {
        connection: { host: "test", port: 2468 },
      });
    });
  });

  describe("createFitFileImportBatchQueue", () => {
    it("creates a Queue with the FIT file import batch queue name", async () => {
      const { createFitFileImportBatchQueue, FIT_FILE_IMPORT_BATCH_QUEUE } = await import(
        "./queues.ts"
      );

      createFitFileImportBatchQueue({ host: "test", port: 8642 });

      expect(MockQueue).toHaveBeenCalledWith(FIT_FILE_IMPORT_BATCH_QUEUE, {
        connection: { host: "test", port: 8642 },
      });
    });
  });

  describe("createZipEntryExtractQueue", () => {
    it("creates a Queue with the ZIP entry extract queue name", async () => {
      const { createZipEntryExtractQueue, ZIP_ENTRY_EXTRACT_QUEUE } = await import("./queues.ts");

      createZipEntryExtractQueue({ host: "test", port: 9753 });

      expect(MockQueue).toHaveBeenCalledWith(ZIP_ENTRY_EXTRACT_QUEUE, {
        connection: { host: "test", port: 9753 },
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
        }),
      ).toEqual({
        archivePath: "/tmp/export.zip",
        entryPath: ["DI_CONNECT/files.zip", "activity.fit"],
        outputExtension: "fit2",
        maxBytes: 1024,
        nestedArchiveMaxBytes: 2048,
      });
    });

    it("rejects empty entry paths and non-alphanumeric output extensions", async () => {
      const { zipEntryExtractJobDataSchema } = await import("./queues.ts");

      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: [],
          outputExtension: "fit",
        }),
      ).toThrow();
      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: ["activity.fit"],
          outputExtension: "fit.gz",
        }),
      ).toThrow();
      expect(() =>
        zipEntryExtractJobDataSchema.parse({
          archivePath: "/tmp/export.zip",
          entryPath: ["activity.fit"],
          outputExtension: ".fit",
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

  describe("getImportQueue", () => {
    it("reuses one import queue instance", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getImportQueue, IMPORT_QUEUE } = await import("./queues.ts");

      const first = getImportQueue();
      const second = getImportQueue();

      expect(first).toBe(second);
      expect(MockQueue).toHaveBeenCalledTimes(1);
      expect(MockQueue).toHaveBeenCalledWith(IMPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getFitFileImportQueue", () => {
    it("reuses one FIT file import queue instance", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getFitFileImportQueue, FIT_FILE_IMPORT_QUEUE } = await import("./queues.ts");

      const first = getFitFileImportQueue();
      const second = getFitFileImportQueue();

      expect(first).toBe(second);
      expect(MockQueue).toHaveBeenCalledTimes(1);
      expect(MockQueue).toHaveBeenCalledWith(FIT_FILE_IMPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getFitFileImportQueueEvents", () => {
    it("reuses one FIT file import queue-events listener", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { FIT_FILE_IMPORT_QUEUE, getFitFileImportQueueEvents } = await import("./queues.ts");

      const first = getFitFileImportQueueEvents();
      const second = getFitFileImportQueueEvents();

      expect(first).toBe(second);
      expect(MockQueueEvents).toHaveBeenCalledTimes(1);
      expect(MockQueueEvents).toHaveBeenCalledWith(FIT_FILE_IMPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getFlowProducer", () => {
    it("reuses one flow producer instance", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { getFlowProducer } = await import("./queues.ts");

      const first = getFlowProducer();
      const second = getFlowProducer();

      expect(first).toBe(second);
      expect(MockFlowProducer).toHaveBeenCalledTimes(1);
      expect(MockFlowProducer).toHaveBeenCalledWith({
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("closeFitFileImportQueueResources", () => {
    it("closes cached FIT file import queue resources and clears the cache", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const {
        closeFitFileImportQueueResources,
        getFitFileImportQueue,
        getFitFileImportQueueEvents,
        getFlowProducer,
      } = await import("./queues.ts");

      getFitFileImportQueue();
      getFitFileImportQueueEvents();
      getFlowProducer();
      const queueConstructorCallsBeforeClose = MockQueue.mock.calls.length;
      const queueEventsConstructorCallsBeforeClose = MockQueueEvents.mock.calls.length;
      const flowProducerConstructorCallsBeforeClose = MockFlowProducer.mock.calls.length;

      await closeFitFileImportQueueResources();

      expect(mockQueueClose).toHaveBeenCalledOnce();
      expect(mockQueueEventsClose).toHaveBeenCalledOnce();
      expect(mockFlowProducerClose).toHaveBeenCalledOnce();

      getFitFileImportQueue();
      getFitFileImportQueueEvents();
      getFlowProducer();

      expect(MockQueue).toHaveBeenCalledTimes(queueConstructorCallsBeforeClose + 1);
      expect(MockQueueEvents).toHaveBeenCalledTimes(queueEventsConstructorCallsBeforeClose + 1);
      expect(MockFlowProducer).toHaveBeenCalledTimes(flowProducerConstructorCallsBeforeClose + 1);
    });

    it("is safe when no FIT file import resources are cached", async () => {
      const { closeFitFileImportQueueResources } = await import("./queues.ts");
      await closeFitFileImportQueueResources();
      vi.clearAllMocks();

      await expect(closeFitFileImportQueueResources()).resolves.toBeUndefined();

      expect(mockQueueClose).not.toHaveBeenCalled();
      expect(mockQueueEventsClose).not.toHaveBeenCalled();
      expect(mockFlowProducerClose).not.toHaveBeenCalled();
    });
  });

  describe("providerSyncQueueName", () => {
    it("returns sync-{providerId} format", async () => {
      const { providerSyncQueueName } = await import("./queues.ts");
      expect(providerSyncQueueName("strava")).toBe("sync-strava");
      expect(providerSyncQueueName("garmin")).toBe("sync-garmin");
    });
  });

  describe("createProviderSyncQueue", () => {
    it("creates a Queue with per-provider queue name", async () => {
      const { createProviderSyncQueue } = await import("./queues.ts");

      createProviderSyncQueue("strava", { host: "test", port: 1234 });

      expect(MockQueue).toHaveBeenCalledWith("sync-strava", {
        connection: { host: "test", port: 1234 },
      });
    });

    it("uses default redis connection when none provided", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { createProviderSyncQueue } = await import("./queues.ts");

      createProviderSyncQueue("garmin");

      expect(MockQueue).toHaveBeenCalledWith("sync-garmin", {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getProviderSyncQueue", () => {
    it("reuses a cached queue for the same provider", async () => {
      const { getProviderSyncQueue } = await import("./queues.ts");

      const firstQueue = getProviderSyncQueue("strava");
      const secondQueue = getProviderSyncQueue("strava");

      expect(firstQueue).toBe(secondQueue);
      expect(MockQueue).toHaveBeenCalledTimes(1);
      expect(MockQueue).toHaveBeenCalledWith("sync-strava", {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });

    it("creates separate cached queues for different providers", async () => {
      const { getProviderSyncQueue } = await import("./queues.ts");

      getProviderSyncQueue("garmin");
      getProviderSyncQueue("wahoo");

      expect(MockQueue).toHaveBeenCalledWith("sync-garmin", expect.any(Object));
      expect(MockQueue).toHaveBeenCalledWith("sync-wahoo", expect.any(Object));
    });
  });

  describe("createExportQueue", () => {
    it("creates a Queue with the export queue name", async () => {
      const { createExportQueue, EXPORT_QUEUE } = await import("./queues.ts");

      createExportQueue({ host: "test", port: 1111 });

      expect(MockQueue).toHaveBeenCalledWith(EXPORT_QUEUE, {
        connection: { host: "test", port: 1111 },
      });
    });

    it("uses default redis connection when none provided", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { createExportQueue, EXPORT_QUEUE } = await import("./queues.ts");

      createExportQueue();

      expect(MockQueue).toHaveBeenCalledWith(EXPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });

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

    it("creates and closes one cached export queue", async () => {
      await closeAllQueueResources();
      vi.clearAllMocks();

      const firstQueue = getDataExportQueue();
      const secondQueue = getDataExportQueue();

      expect(firstQueue).toBe(secondQueue);
      expect(MockQueue).toHaveBeenCalledOnce();
      expect(MockQueue).toHaveBeenCalledWith(EXPORT_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });

      await closeAllQueueResources();
      expect(mockQueueClose).toHaveBeenCalledOnce();
    });
  });

  describe("createScheduledSyncQueue", () => {
    it("creates a Queue with the scheduled sync queue name", async () => {
      const { createScheduledSyncQueue, SCHEDULED_SYNC_QUEUE } = await import("./queues.ts");

      createScheduledSyncQueue({ host: "test", port: 2222 });

      expect(MockQueue).toHaveBeenCalledWith(SCHEDULED_SYNC_QUEUE, {
        connection: { host: "test", port: 2222 },
      });
    });
  });

  describe("createPostSyncQueue", () => {
    it("creates a Queue with the post-sync queue name", async () => {
      const { createPostSyncQueue, POST_SYNC_QUEUE } = await import("./queues.ts");

      createPostSyncQueue({ host: "test", port: 9999 });

      expect(MockQueue).toHaveBeenCalledWith(POST_SYNC_QUEUE, {
        connection: { host: "test", port: 9999 },
      });
    });
  });

  describe("createActivityDeleteAnalyticsQueue", () => {
    it("creates a Queue with the activity delete analytics queue name", async () => {
      const { createActivityDeleteAnalyticsQueue, ACTIVITY_DELETE_ANALYTICS_QUEUE } = await import(
        "./queues.ts"
      );

      createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });

      expect(MockQueue).toHaveBeenCalledWith(ACTIVITY_DELETE_ANALYTICS_QUEUE, {
        connection: { host: "test", port: 9999 },
      });
    });

    it("uses default redis connection when none provided", async () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      const { createActivityDeleteAnalyticsQueue, ACTIVITY_DELETE_ANALYTICS_QUEUE } = await import(
        "./queues.ts"
      );

      createActivityDeleteAnalyticsQueue();

      expect(MockQueue).toHaveBeenCalledWith(ACTIVITY_DELETE_ANALYTICS_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getPostSyncQueue", () => {
    it("reuses the cached post-sync queue", async () => {
      const { getPostSyncQueue, POST_SYNC_QUEUE } = await import("./queues.ts");

      const firstQueue = getPostSyncQueue();
      const secondQueue = getPostSyncQueue();

      expect(firstQueue).toBe(secondQueue);
      expect(MockQueue).toHaveBeenCalledWith(POST_SYNC_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
    });
  });

  describe("getActivityDeleteAnalyticsQueue", () => {
    it("reuses the cached activity delete analytics queue", async () => {
      const { getActivityDeleteAnalyticsQueue, ACTIVITY_DELETE_ANALYTICS_QUEUE } = await import(
        "./queues.ts"
      );

      const firstQueue = getActivityDeleteAnalyticsQueue();
      const secondQueue = getActivityDeleteAnalyticsQueue();

      expect(firstQueue).toBe(secondQueue);
      expect(MockQueue).toHaveBeenCalledWith(ACTIVITY_DELETE_ANALYTICS_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });
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

    it("does not enqueue a job when no activity ids are provided", async () => {
      const { enqueueActivityDeleteAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityDeleteAnalyticsRefresh("user-123", [], queue);

      expect(mockQueueAdd).not.toHaveBeenCalled();
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

    it("creates and closes one cached provider deletion queue", async () => {
      await closeAllQueueResources();
      vi.clearAllMocks();

      const firstQueue = getProviderDataDeletionQueue();
      const secondQueue = getProviderDataDeletionQueue();

      expect(firstQueue).toBe(secondQueue);
      expect(MockQueue).toHaveBeenCalledOnce();
      expect(MockQueue).toHaveBeenCalledWith(PROVIDER_DATA_DELETION_QUEUE, {
        connection: expect.objectContaining({ host: "localhost", port: 6379 }),
      });

      await closeAllQueueResources();
      expect(mockQueueClose).toHaveBeenCalledOnce();
    });
  });

  describe("enqueueActivityRestoreAnalyticsRefresh", () => {
    it("adds an activity restore analytics refresh job with retries", async () => {
      const { enqueueActivityRestoreAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityRestoreAnalyticsRefresh(
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
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 100 },
          attempts: 5,
          backoff: { type: "fixed", delay: 30_000 },
        },
      );
    });

    it("does not enqueue a job when no activity ids are provided", async () => {
      const { enqueueActivityRestoreAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityRestoreAnalyticsRefresh("user-123", [], queue);

      expect(mockQueueAdd).not.toHaveBeenCalled();
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

    it("does not enqueue a job when no activity ids are provided", async () => {
      const { enqueueActivityRecomputeAnalyticsRefresh, createActivityDeleteAnalyticsQueue } =
        await import("./queues.ts");

      const queue = createActivityDeleteAnalyticsQueue({ host: "test", port: 9999 });
      await enqueueActivityRecomputeAnalyticsRefresh("user-123", [], queue);

      expect(mockQueueAdd).not.toHaveBeenCalled();
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
