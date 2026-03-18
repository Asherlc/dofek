import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueueInstance = { name: "mock-queue" };
const MockQueue = vi.fn(() => mockQueueInstance);

vi.mock("bullmq", () => ({
  Queue: MockQueue,
}));

describe("queues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
  });

  describe("constants", () => {
    it("exports correct queue names", async () => {
      const { SYNC_QUEUE, IMPORT_QUEUE } = await import("./queues.ts");
      expect(SYNC_QUEUE).toBe("sync");
      expect(IMPORT_QUEUE).toBe("import");
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
});
