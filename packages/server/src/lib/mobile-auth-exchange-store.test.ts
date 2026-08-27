import { beforeEach, describe, expect, it, vi } from "vitest";

const redisClient = vi.hoisted(() => ({
  set: vi.fn(),
  sendCommand: vi.fn(),
}));
const redisConnectionConstructor = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("bullmq", () => ({
  RedisConnection: redisConnectionConstructor,
}));

vi.mock("dofek/jobs/queues", () => ({
  getRedisConnection: vi.fn(),
}));

vi.mock("@sentry/node", () => ({ captureException: mockCaptureException }));

import {
  InMemoryMobileAuthExchangeStore,
  RedisMobileAuthExchangeStore,
} from "./mobile-auth-exchange-store.ts";

beforeEach(() => {
  vi.clearAllMocks();
  redisConnectionConstructor.mockImplementation(
    class {
      constructor() {
        return { client: Promise.resolve(redisClient) };
      }
    },
  );
  redisClient.set.mockResolvedValue("OK");
});

describe("InMemoryMobileAuthExchangeStore", () => {
  it("consumes a code only once", async () => {
    const store = new InMemoryMobileAuthExchangeStore();
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });

    await expect(store.consume(code)).resolves.toEqual({
      kind: "session",
      sessionId: "session-1",
      isNewUser: false,
    });
    await expect(store.consume(code)).resolves.toBeNull();
  });

  it("rejects expired codes", async () => {
    const store = new InMemoryMobileAuthExchangeStore({ ttlMs: 1 });
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(store.consume(code)).resolves.toBeNull();
  });
});

describe("RedisMobileAuthExchangeStore", () => {
  it("stores and atomically consumes a session payload", async () => {
    const payload = { kind: "session" as const, sessionId: "session-1", isNewUser: true };
    redisClient.sendCommand.mockResolvedValueOnce(JSON.stringify(payload));
    const store = new RedisMobileAuthExchangeStore();

    const code = await store.issue(payload);
    await expect(store.consume(code)).resolves.toEqual(payload);
    await new RedisMobileAuthExchangeStore().issue(payload);

    expect(redisClient.set).toHaveBeenCalledWith(
      expect.stringMatching(/^mobile-auth-exchange:[a-f0-9]{64}$/),
      JSON.stringify(payload),
      { PX: 60_000 },
    );
    expect(redisClient.sendCommand).toHaveBeenCalledWith([
      "GETDEL",
      expect.stringMatching(/^mobile-auth-exchange:[a-f0-9]{64}$/),
    ]);
    expect(redisConnectionConstructor).toHaveBeenCalledWith(undefined, {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
    expect(redisConnectionConstructor).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and invalid Redis payloads", async () => {
    const store = new RedisMobileAuthExchangeStore(async () => ({
      set: vi.fn().mockResolvedValue("OK"),
      getAndDelete: vi
        .fn()
        .mockResolvedValueOnce("not-json")
        .mockResolvedValueOnce(JSON.stringify({ kind: "unknown" })),
    }));

    await expect(store.consume("malformed")).resolves.toBeNull();
    await expect(store.consume("invalid")).resolves.toBeNull();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(SyntaxError), {
      tags: { context: "mobile-auth-exchange-parse" },
    });
  });

  it.each([
    ["null", null],
    ["an object without Redis commands", {}],
    ["an object with non-function Redis commands", { set: true, sendCommand: true }],
  ])("rejects a Redis client that is %s", async (_description, invalidRedisClient) => {
    vi.resetModules();
    vi.doMock("bullmq", () => ({
      RedisConnection: vi.fn(
        class {
          constructor() {
            return { client: Promise.resolve(invalidRedisClient) };
          }
        },
      ),
    }));
    vi.doMock("dofek/jobs/queues", () => ({ getRedisConnection: vi.fn() }));

    const { RedisMobileAuthExchangeStore: FreshRedisMobileAuthExchangeStore } = await import(
      "./mobile-auth-exchange-store.ts"
    );
    const store = new FreshRedisMobileAuthExchangeStore();

    await expect(
      store.issue({ kind: "session", sessionId: "session-1", isNewUser: false }),
    ).rejects.toThrow("Redis client does not support mobile auth exchange commands");

    vi.doUnmock("bullmq");
    vi.doUnmock("dofek/jobs/queues");
  });
});
