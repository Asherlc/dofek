import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function createFakeRedisClient() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const ttlSeconds = new Map<string, number>();

  return {
    client: {
      async set(key: string, value: string): Promise<"OK"> {
        values.set(key, value);
        return "OK";
      },
      async get(key: string): Promise<string | null> {
        return values.get(key) ?? null;
      },
      async del(...keys: string[]): Promise<number> {
        let deleted = 0;
        for (const key of keys) {
          if (values.delete(key)) deleted++;
          if (sets.delete(key)) deleted++;
          ttlSeconds.delete(key);
        }
        return deleted;
      },
      async sadd(key: string, ...members: string[]): Promise<number> {
        const current = sets.get(key) ?? new Set<string>();
        const before = current.size;
        for (const member of members) current.add(member);
        sets.set(key, current);
        return current.size - before;
      },
      async scard(key: string): Promise<number> {
        return sets.get(key)?.size ?? 0;
      },
      async smembers(key: string): Promise<string[]> {
        return [...(sets.get(key) ?? new Set<string>())];
      },
      async expire(key: string, seconds: number): Promise<number> {
        ttlSeconds.set(key, seconds);
        return 1;
      },
    },
    values,
    sets,
    ttlSeconds,
  };
}

describe("RedisUploadStateStore", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("bullmq");
    vi.doUnmock("dofek/jobs/queues");
    process.env = { ...originalEnv };
  });

  it("stores sessions, chunks, and statuses in Redis", async () => {
    const fakeRedis = createFakeRedisClient();
    const module = await import("./upload-state-store.ts");
    const store = new module.RedisUploadStateStore(async () => fakeRedis.client);

    await store.saveUploadSession("upload-1", { total: 3, dir: "/tmp/upload-1", userId: "user-1" });
    await store.addReceivedChunk("upload-1", 2);
    await store.addReceivedChunk("upload-1", 0);
    await store.saveUploadStatus("upload-1", {
      status: "uploading",
      progress: 50,
      message: "Receiving chunks...",
      userId: "user-1",
    });

    expect(await store.getUploadSession("upload-1")).toEqual({
      total: 3,
      dir: "/tmp/upload-1",
      userId: "user-1",
    });
    expect(await store.getReceivedChunkCount("upload-1")).toBe(2);
    expect(await store.getReceivedChunks("upload-1")).toEqual([0, 2]);
    expect(await store.getUploadStatus("upload-1")).toEqual({
      status: "uploading",
      progress: 50,
      message: "Receiving chunks...",
      userId: "user-1",
    });
    expect(fakeRedis.ttlSeconds.get("upload-chunks:upload-1")).toBe(1800);
  });

  it("cleans up invalid upload payloads", async () => {
    const fakeRedis = createFakeRedisClient();
    const module = await import("./upload-state-store.ts");
    const store = new module.RedisUploadStateStore(async () => fakeRedis.client);

    fakeRedis.values.set("upload-session:broken-json", "{not-json");
    fakeRedis.values.set("upload-session:broken-schema", JSON.stringify({ total: 0, dir: 12 }));
    fakeRedis.values.set("upload-status:broken-status", JSON.stringify({ status: "nope" }));

    await expect(store.getUploadSession("broken-json")).resolves.toBeNull();
    await expect(store.getUploadSession("broken-schema")).resolves.toBeNull();
    await expect(store.getUploadStatus("broken-status")).resolves.toBeNull();

    expect(fakeRedis.values.has("upload-session:broken-json")).toBe(false);
    expect(fakeRedis.values.has("upload-session:broken-schema")).toBe(false);
    expect(fakeRedis.values.has("upload-status:broken-status")).toBe(false);
  });

  it("deletes stored upload state", async () => {
    const fakeRedis = createFakeRedisClient();
    const module = await import("./upload-state-store.ts");
    const store = new module.RedisUploadStateStore(async () => fakeRedis.client);

    await store.saveUploadSession("upload-2", { total: 2, dir: "/tmp/upload-2", userId: "user-2" });
    await store.addReceivedChunk("upload-2", 1);
    await store.saveUploadStatus("upload-2", {
      status: "done",
      progress: 100,
      message: "Finished",
      userId: "user-2",
    });

    await store.deleteUploadSession("upload-2");
    await store.deleteUploadStatus("upload-2");

    expect(await store.getUploadSession("upload-2")).toBeNull();
    expect(await store.getReceivedChunkCount("upload-2")).toBe(0);
    expect(await store.getUploadStatus("upload-2")).toBeNull();
  });

  it("uses Redis-backed default store outside test env", async () => {
    const fakeRedis = createFakeRedisClient();
    const redisConnection = vi.fn().mockImplementation(() => ({
      client: Promise.resolve(fakeRedis.client),
    }));
    const getRedisConnection = vi.fn(() => ({ host: "redis" }));

    vi.doMock("bullmq", () => ({ RedisConnection: redisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection }));
    process.env = { ...originalEnv, NODE_ENV: "production" };

    const module = await import("./upload-state-store.ts");
    const store = module.getUploadStateStore();

    await store.saveUploadStatus("upload-3", {
      status: "processing",
      progress: 80,
      message: "Processing",
      userId: "user-3",
    });

    expect(await store.getUploadStatus("upload-3")).toEqual({
      status: "processing",
      progress: 80,
      message: "Processing",
      userId: "user-3",
    });
    expect(getRedisConnection).toHaveBeenCalledTimes(1);
    expect(redisConnection).toHaveBeenCalledTimes(1);
  });
});
