import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueueAdd = vi.fn();
const mockQueueInstance = { name: "mock-queue", add: mockQueueAdd };
const MockQueue = vi.fn(() => mockQueueInstance);

vi.mock("bullmq", () => ({
  Queue: MockQueue,
}));

describe("queues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
    mockQueueAdd.mockResolvedValue(undefined);
  });

  describe("constants", () => {
    it("exports correct queue names", async () => {
      const {
        EXPORT_QUEUE,
        IMPORT_QUEUE,
        POST_SYNC_QUEUE,
        SCHEDULED_SYNC_QUEUE,
        SYNC_QUEUE,
        TRAINING_EXPORT_QUEUE,
      } = await import("./queues.ts");
      expect(SYNC_QUEUE).toBe("sync");
      expect(IMPORT_QUEUE).toBe("import");
      expect(EXPORT_QUEUE).toBe("export");
      expect(SCHEDULED_SYNC_QUEUE).toBe("scheduled-sync");
      expect(POST_SYNC_QUEUE).toBe("post-sync");
      expect(TRAINING_EXPORT_QUEUE).toBe("training-export");
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
          delay: POST_SYNC_DEBOUNCE_MS,
          deduplication: {
            id: "post-sync:global-maintenance",
            ttl: POST_SYNC_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
          removeOnComplete: true,
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
          delay: POST_SYNC_DEBOUNCE_MS,
          deduplication: {
            id: "post-sync:user-refit:user-123",
            ttl: POST_SYNC_DEBOUNCE_MS,
            extend: true,
            replace: true,
          },
          removeOnComplete: true,
        },
      );
    });
  });

  describe("createTrainingExportQueue", () => {
    it("creates a Queue with the training export queue name", async () => {
      const { createTrainingExportQueue, TRAINING_EXPORT_QUEUE } = await import("./queues.ts");

      createTrainingExportQueue({ host: "test", port: 3333 });

      expect(MockQueue).toHaveBeenCalledWith(TRAINING_EXPORT_QUEUE, {
        connection: { host: "test", port: 3333 },
      });
    });
  });
});
