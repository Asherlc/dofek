import { afterEach, describe, expect, it, vi } from "vitest";

const originalNodeEnv = process.env.NODE_ENV;

describe("dedupe-store", () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("InMemorySlackDedupeStore claims a key once within TTL and allows it after expiry", async () => {
    const { InMemorySlackDedupeStore } = await import("./dedupe-store.ts");
    const store = new InMemorySlackDedupeStore();
    const key = "event:Ev123";

    const firstClaim = await store.claim(key, 25);
    const secondClaim = await store.claim(key, 25);

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const thirdClaim = await store.claim(key, 25);
    expect(thirdClaim).toBe(true);
  });

  it("RedisSlackDedupeStore maps Redis NX result to boolean", async () => {
    const { RedisSlackDedupeStore } = await import("./dedupe-store.ts");
    const set = vi
      .fn()
      .mockResolvedValueOnce("OK" as const)
      .mockResolvedValueOnce(null);

    const store = new RedisSlackDedupeStore(async () => ({ set }));

    await expect(store.claim("event:Ev1", 1_000)).resolves.toBe(true);
    await expect(store.claim("event:Ev1", 1_000)).resolves.toBe(false);
    expect(set).toHaveBeenNthCalledWith(1, "slack:dedupe:event:Ev1", "1", "PX", 1_000, "NX");
  });

  it("createSlackDedupeStore returns InMemorySlackDedupeStore in test env", async () => {
    process.env.NODE_ENV = "test";
    vi.resetModules();
    const moduleUnderTest = await import("./dedupe-store.ts");

    const store = moduleUnderTest.createSlackDedupeStore();
    expect(store).toBeInstanceOf(moduleUnderTest.InMemorySlackDedupeStore);
  });

  it("createSlackDedupeStore uses shared Redis connection outside test env", async () => {
    process.env.NODE_ENV = "production";
    vi.resetModules();

    const set = vi
      .fn()
      .mockResolvedValueOnce("OK" as const)
      .mockResolvedValueOnce(null);
    const getRedisConnection = vi.fn(() => ({ host: "localhost", port: 6379 }));

    class MockRedisConnection {
      static instanceCount = 0;
      readonly client: Promise<{ set: typeof set }>;

      constructor() {
        MockRedisConnection.instanceCount += 1;
        this.client = Promise.resolve({ set });
      }
    }

    vi.doMock("bullmq", () => ({ RedisConnection: MockRedisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection }));

    const moduleUnderTest = await import("./dedupe-store.ts");
    const storeOne = moduleUnderTest.createSlackDedupeStore();
    const storeTwo = moduleUnderTest.createSlackDedupeStore();

    expect(storeOne).toBeInstanceOf(moduleUnderTest.RedisSlackDedupeStore);
    expect(storeTwo).toBeInstanceOf(moduleUnderTest.RedisSlackDedupeStore);
    await expect(storeOne.claim("event:Ev2", 2_000)).resolves.toBe(true);
    await expect(storeTwo.claim("event:Ev3", 2_000)).resolves.toBe(false);
    expect(getRedisConnection).toHaveBeenCalledTimes(1);
    expect(MockRedisConnection.instanceCount).toBe(1);
    expect(set).toHaveBeenNthCalledWith(1, "slack:dedupe:event:Ev2", "1", "PX", 2_000, "NX");
    expect(set).toHaveBeenNthCalledWith(2, "slack:dedupe:event:Ev3", "1", "PX", 2_000, "NX");
  });
});
